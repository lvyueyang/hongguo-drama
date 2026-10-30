// SPDX-License-Identifier: MIT
/**
 * HLS 准备：把远端清单与分片落到本地，再由 FFmpeg 无损重封装成 mp4。
 *
 * 迁移自 4.5 `src/native/hls-media.js`。为什么不能直接交给 FFmpeg 拉流：
 * 内置 FFmpeg 没有 HTTP 传输能力（`supportsHttp: false`），而且播放地址必须经过
 * 我们的 DNS/重定向守卫 —— 让 FFmpeg 自己去连等于绕过守卫，还会把私网地址带进来。
 *
 * 因此这里做三件事：守卫下暂存、改写清单地址为本地路径、只允许本地协议喂给 FFmpeg。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { webMediaRequestOptions } from '../../internal/net/guard.ts';

const DISK_RESERVE = 512 * 1024 * 1024;
const diskJobs = new Set<{ device: number; remaining(extra?: number): number }>();

export interface HlsRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type HlsRequester = (url: string, options: HlsRequestOptions) => Promise<any>;

export interface RemuxHlsOptions {
  url: string;
  output: string;
  /** 内置 ffmpeg 路径；缺失直接报错，不要用系统里的同名程序 */
  ffmpeg: string | null;
  signal?: AbortSignal;
  /** 每次访问远端前复核来源是否仍启用（自定义源可能被中途停用） */
  checkAccess?: () => void;
  headers?: Record<string, string>;
  onProgress?(receivedBytes: number): void;
  /** 暂存空间上限（字节）；缺省不限制，仍受磁盘剩余空间约束 */
  tempCapacityBytes?: number;
  request?: HlsRequester;
}

async function requestHls(url: string, options: HlsRequestOptions): Promise<any> {
  // webMediaRequestOptions 的字段是宽松类型，断言到 never 以免与 axios 的重载联合类型打架。
  return axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 30_000,
    ...webMediaRequestOptions(url),
    signal: options.signal,
    headers: options.headers,
  } as never);
}

export async function remuxHls(options: RemuxHlsOptions): Promise<void> {
  const {
    url,
    output,
    ffmpeg,
    signal,
    checkAccess = () => {},
    headers = {},
    onProgress,
    tempCapacityBytes,
  } = options;
  if (!ffmpeg) throw new Error('未找到 FFmpeg，无法准备 HLS 视频');
  const request = options.request ?? requestHls;
  webMediaRequestOptions(url);

  const controller = new AbortController();
  const files = new Map<string, string>();
  let temporary: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let writer: fs.WriteStream | undefined;
  let failure: Error | undefined;
  let killed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let spaceTimer: NodeJS.Timeout | undefined;
  let diskJob: { device: number; remaining(extra?: number): number } | undefined;
  let received = 0;
  let lastProgress = 0;
  let stagedBytes = 0;
  let committedBytes = 0;
  let remuxing = false;
  const capacityBytes =
    Number.isFinite(tempCapacityBytes) && Number(tempCapacityBytes) >= 0
      ? Number(tempCapacityBytes)
      : Number.POSITIVE_INFINITY;

  const stopChild = () => {
    if (!child || killed) return;
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    killTimer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 2000);
    killTimer.unref?.();
  };
  const fail = (error: Error) => {
    failure ||= error;
    controller.abort();
    stopChild();
  };
  const abort = () => fail(new Error('已取消 HLS 准备'));
  const check = () => {
    if (signal?.aborted) abort();
    if (failure) throw failure;
    checkAccess();
  };
  const ensureCapacity = (extra: number) => {
    if (stagedBytes + extra > capacityBytes) throw new Error('HLS 暂存空间不足，已停止');
    if (!temporary) return;
    const stat = fs.statfsSync(temporary);
    const free = Number(stat.bsize) * Number(stat.bavail);
    const needed = [...diskJobs]
      .filter((job) => job.device === diskJob?.device)
      .reduce((sum, job) => sum + job.remaining(job === diskJob ? extra : 0), DISK_RESERVE);
    if (!Number.isFinite(free) || free < needed) throw new Error('HLS 暂存或输出空间不足，已停止');
  };

  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => fail(new Error('HLS 准备超时，请重试')), 10 * 60 * 1000);

  const stage = async (remote: string, playlist = false, ancestors = new Set<string>()): Promise<string> => {
    check();
    webMediaRequestOptions(remote);
    if (ancestors.has(remote)) throw new Error('HLS 清单循环引用');
    const known = files.get(remote);
    if (known) return known;
    if (files.size >= 10_000) throw new Error('HLS 清单过大');
    const extension = playlist
      ? 'm3u8'
      : (/\.(ts|m4s|mp4|aac|m4a|vtt)$/i.exec(new URL(remote).pathname)?.[1] ?? 'ts');
    const local = path.join(temporary as string, `${files.size}.${extension}`);
    files.set(remote, local);
    let upstream: any;
    try {
      upstream = await request(remote, {
        signal: controller.signal,
        headers: { ...headers, 'Accept-Encoding': 'identity' },
      });
      check();
      if (upstream.status !== 200) throw new Error('HLS 媒体请求失败或内容不完整');
      const type = String(upstream.headers?.['content-type'] ?? '');
      if (playlist || /mpegurl/i.test(type)) {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of upstream.data) {
          check();
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('HLS 清单过大');
          parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (
          Number(upstream.headers?.['content-length']) &&
          bytes !== Number(upstream.headers['content-length'])
        )
          throw new Error('HLS 清单下载不完整');
        const text = Buffer.concat(parts).toString('utf8');
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
        if (/#EXTINF:/.test(text) && !/#EXT-X-ENDLIST/.test(text))
          throw new Error('暂不支持未结束的直播清单');
        const base = String(upstream.request?.res?.responseUrl || upstream.url || remote);
        webMediaRequestOptions(base);
        const chain = new Set([...ancestors, remote]);
        let lines = text.split(/\r?\n/);
        // 只保留一个最高带宽的码率版本：最终分辨率由下载校验兜底，不要在清单层猜。
        const variants = lines
          .map((line, index) => ({
            index,
            bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(line.indexOf(':') + 1))?.[1]) || 0,
          }))
          .filter((item) => lines[item.index]?.startsWith('#EXT-X-STREAM-INF:'));
        if (variants.length > 1) {
          const chosen = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
          const removed = new Set(
            variants.filter((item) => item !== chosen).flatMap((item) => [item.index, item.index + 1]),
          );
          lines = lines.filter((_line, index) => !removed.has(index));
        }
        const rewritten: string[] = [];
        let variant = false;
        for (const line of lines) {
          check();
          const value = line.trim();
          if (!value) {
            rewritten.push(line);
            continue;
          }
          if (!value.startsWith('#')) {
            rewritten.push(await stage(new URL(value, base).href, variant, chain));
            variant = false;
            continue;
          }
          variant = value.startsWith('#EXT-X-STREAM-INF:');
          if (value.startsWith('#EXT-X-DEFINE:')) throw new Error('不支持含动态地址变量的 HLS 清单');
          if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && !/METHOD=(?:AES-128|NONE)(?:,|$)/.test(value))
            throw new Error('不支持该 HLS 加密方式');
          let result = line;
          const matches = [...line.matchAll(/\bURI="([^"]*)"/g)];
          if ((line.match(/\bURI\s*=/g) ?? []).length !== matches.length) throw new Error('HLS 地址格式无效');
          for (const match of matches) {
            const file = await stage(
              new URL(match[1] as string, base).href,
              /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(value),
              chain,
            );
            if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && fs.statSync(file).size !== 16)
              throw new Error('HLS 密钥长度无效');
            result = result.replace(match[0], `URI="${file}"`);
          }
          rewritten.push(result);
        }
        const manifest = rewritten.join('\n');
        const size = Buffer.byteLength(manifest);
        ensureCapacity(size);
        stagedBytes += size;
        await fsp.writeFile(local, manifest, { mode: 0o600 });
        committedBytes = stagedBytes;
      } else {
        if (/text\/html|application\/json/i.test(type)) throw new Error('HLS 分片返回了错误页面');
        let bytes = 0;
        upstream.data.on('data', (chunk: Buffer) => {
          try {
            ensureCapacity(chunk.length);
          } catch (error) {
            fail(error as Error);
            upstream.data.destroy(error as Error);
            return;
          }
          stagedBytes += chunk.length;
          bytes += chunk.length;
          received += chunk.length;
          if (Date.now() - lastProgress >= 150) {
            onProgress?.(received);
            lastProgress = Date.now();
          }
        });
        writer = fs.createWriteStream(local, { mode: 0o600 });
        await pipeline(upstream.data, writer, { signal: controller.signal });
        committedBytes = stagedBytes;
        writer = undefined;
        if (
          !bytes ||
          (Number(upstream.headers?.['content-length']) &&
            bytes !== Number(upstream.headers['content-length']))
        )
          throw new Error('HLS 分片下载不完整');
        onProgress?.(received);
      }
      check();
      return local;
    } finally {
      upstream?.data?.destroy?.();
    }
  };

  try {
    check();
    // 暂存与输出放在同一设备：多个 HLS 任务共享一份剩余空间预算。
    const outputDir = path.dirname(output);
    await fsp.mkdir(outputDir, { recursive: true });
    temporary = await fsp.mkdtemp(path.join(outputDir, '.hongguo-hls-'));
    const temporaryDir = temporary;
    diskJob = {
      device: fs.statSync(temporaryDir).dev,
      remaining(extra = 0) {
        const pending = Math.max(0, stagedBytes - committedBytes - (writer?.bytesWritten ?? 0));
        let outputBytes = 0;
        if (remuxing) {
          try {
            outputBytes = fs.statSync(output).size;
          } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
          }
        }
        // 实际剩余空间已经扣掉了写下去的字节，这里只预留排队中的写入与未写完的 MP4。
        return (
          pending + extra + Math.max(0, Math.ceil((stagedBytes + extra) * 1.1) + 1024 * 1024 - outputBytes)
        );
      },
    };
    diskJobs.add(diskJob);
    if (!(capacityBytes > 0)) throw new Error('HLS 暂存空间不足');
    ensureCapacity(0);
    const input = await stage(url, true);
    check();
    ensureCapacity(0);
    remuxing = true;
    spaceTimer = setInterval(() => {
      try {
        ensureCapacity(0);
      } catch (error) {
        fail(error as Error);
      }
    }, 1000);
    await new Promise<void>((resolve, reject) => {
      child = spawn(
        ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-protocol_whitelist',
          'file,crypto',
          '-allowed_extensions',
          'ALL',
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
      child.stderr?.on('data', () => {});
      child.once('error', () => reject(new Error('无法启动 FFmpeg')));
      child.once('close', (code) => {
        clearTimeout(killTimer);
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error('HLS 媒体转换失败'));
      });
      if (controller.signal.aborted) stopChild();
    });
    check();
    if (!fs.existsSync(output) || !fs.statSync(output).size) throw new Error('HLS 没有生成有效视频');
  } catch (error) {
    try {
      fs.unlinkSync(output);
    } catch {
      /* 输出还没建出来 */
    }
    throw failure ?? error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    clearInterval(spaceTimer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    if (diskJob) diskJobs.delete(diskJob);
    try {
      if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
    } catch {
      /* 临时目录可能已被清理 */
    }
  }
}
