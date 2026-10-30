// SPDX-License-Identifier: MIT
/**
 * 解密任务：把纯计算搬进 worker 线程。
 *
 * 迁移自 4.5 `src/native/decrypt-worker.cjs`。为什么必须独立线程：
 * 单集 1080p 十几 MB，逐样本 AES-CTR 跑在主线程上会把窗口卡住，
 * 主线程一忙连「取消」这种 IPC 都收不到，取消就形同虚设。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface DecryptTaskOptions {
  signal?: AbortSignal;
  /** worker 脚本路径；打包后与主入口同目录（宿主提供） */
  workerPath?: string;
  /** 覆盖 worker 创建方式（测试注入用；默认按 workerPath 起真 worker） */
  createWorker?: (workerData: Record<string, unknown>) => MinimalWorker;
}

interface MinimalWorker {
  once(event: 'message', listener: (value: any) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<unknown> | unknown;
}

export interface DecryptFileRequest {
  srcPath: string;
  dstPath: string;
  key: ArrayLike<number>;
}

export interface DecryptBufferRequest {
  buffer: Buffer;
  key: ArrayLike<number>;
}

function canceledError(message = '已取消视频解密'): Error {
  return Object.assign(new Error(message), { code: 'CANCELED' });
}

function runInWorker(
  payload: Record<string, unknown>,
  options: DecryptTaskOptions,
): Promise<{ buffer?: ArrayBuffer | Uint8Array }> {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(canceledError());
      return;
    }
    let worker: MinimalWorker;
    try {
      worker = options.createWorker
        ? options.createWorker(payload)
        : new Worker(String(options.workerPath ?? ''), { workerData: payload });
    } catch (error) {
      reject(
        Object.assign(new Error(`无法启动视频解密线程：${(error as Error).message}`), {
          code: 'LOCAL_MEDIA_TOOL_ERROR',
        }),
      );
      return;
    }
    let settled = false;
    const finish = async (error: Error | null, result?: { buffer?: ArrayBuffer | Uint8Array }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      // 等 writer 真正停下来，调用方才能安全删临时文件。
      await worker.terminate();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const cancel = () => void finish(canceledError());
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once(
      'message',
      (result: any) =>
        void finish(
          result?.error
            ? Object.assign(new Error(String(result.error)), { code: 'MEDIA_DECODE_ERROR' })
            : null,
          result,
        ),
    );
    worker.once('error', (error: Error) => void finish(error));
    worker.once('exit', (code: number) => {
      if (!settled) void finish(new Error(`视频解密意外中断（${code}）`));
    });
    if (signal?.aborted) cancel();
  });
}

function requireWorkerPath(options: DecryptTaskOptions): void {
  if (!options.createWorker && !options.workerPath) {
    throw Object.assign(new Error('缺少视频解密线程脚本路径'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
  }
}

/** 文件对文件：大文件不经过内存。源文件不会被改写。 */
export async function decryptFileInWorker(
  request: DecryptFileRequest,
  options: DecryptTaskOptions = {},
): Promise<void> {
  requireWorkerPath(options);
  await runInWorker(
    { srcPath: request.srcPath, dstPath: request.dstPath, key: Array.from(request.key) },
    options,
  );
}

/** 内存对内存：结果经 Transferable 回传，避免结构化克隆再复制一份大 buffer。 */
export async function decryptBufferInWorker(
  request: DecryptBufferRequest,
  options: DecryptTaskOptions = {},
): Promise<Buffer> {
  requireWorkerPath(options);
  const source = request.buffer;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const result = await runInWorker({ buffer: copy.buffer, key: Array.from(request.key) }, options);
  if (!result?.buffer) throw new Error('视频解密没有返回数据');
  return Buffer.from(result.buffer instanceof Uint8Array ? result.buffer : new Uint8Array(result.buffer));
}

export interface ContentKeyDecryptRequest {
  input: string;
  output: string;
  /** CENC 密钥：32 位十六进制 */
  contentKey: string;
}

/**
 * CENC（senc / saiz+saio 两种布局）解密：只有原生 FFmpeg 能处理，node 侧做不到。
 *
 * 失败时删掉没写完的输出，保证调用方看到的只能是一个完整文件或没有文件；
 * stderr 一律丢弃 —— 里面可能有私有路径与密钥片段。
 */
export async function decryptContentKeyFile(
  request: ContentKeyDecryptRequest,
  options: { ffmpeg: string | null; signal?: AbortSignal },
): Promise<void> {
  const { input, output, contentKey } = request;
  if (typeof contentKey !== 'string' || !/^[a-f\d]{32}$/i.test(contentKey))
    throw Object.assign(new Error('片源解密密钥格式无效'), { code: 'SECURITY_BLOCKED' });
  if (options.signal?.aborted) throw canceledError('已取消媒体解密');
  const executable = options.ffmpeg;
  if (!executable)
    throw Object.assign(new Error('未找到内置 FFmpeg，无法准备该片源。请重新下载完整发行包并运行'), {
      code: 'LOCAL_MEDIA_TOOL_ERROR',
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-decryption_key',
          contentKey,
          '-i',
          input,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          output,
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let canceled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const abort = () => {
        if (canceled) return;
        canceled = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        killTimer.unref?.();
      };
      const cleanup = () => {
        clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.stderr?.on('data', () => {});
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once('error', () => {
        cleanup();
        reject(Object.assign(new Error('无法启动内置 FFmpeg'), { code: 'LOCAL_MEDIA_TOOL_ERROR' }));
      });
      child.once('close', (code) => {
        cleanup();
        if (canceled) reject(canceledError('已取消媒体解密'));
        else if (code !== 0)
          reject(
            Object.assign(new Error(`媒体解密失败（FFmpeg 退出码 ${code}），请重新获取片源后重试`), {
              code: 'MEDIA_DECODE_ERROR',
            }),
          );
        else resolve();
      });
    });
    if (options.signal?.aborted) throw canceledError('已取消媒体解密');
    if (fs.statSync(output).size === 0) throw new Error('媒体解密没有生成可用文件');
  } catch (error) {
    try {
      fs.unlinkSync(output);
    } catch {
      /* 输出没建出来 */
    }
    throw error;
  }
}
