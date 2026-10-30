// SPDX-License-Identifier: MIT
/**
 * 本地媒体工具：ffmpeg/ffprobe 的定位、执行与产物发布。
 *
 * 迁移自 4.5 `main.js` 的 `resolveFfmpeg` / `probeVideoInfo` / `probeDuration` /
 * `pickH264Encoder` 与 `src/native/merge-runner.js` 的 `publishMergedOutput`。
 * 宿主（Electron / CLI）只提供路径来源，SDK 自己决定怎么跑、怎么看结果。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { FfmpegTools } from '@hongguo/host';
import { shortEdge as shortEdgeOf } from '@hongguo/shared';
import { type MergeInfo, readMergeInfo } from './merge-plan.ts';

/** 宿主只需要提供「去哪找工具」，SDK 不关心它是不是 Electron。 */
export interface MediaToolsHost {
  ffmpeg?(): FfmpegTools | null;
}

export interface MediaTools {
  ffmpeg: string | null;
  ffprobe: string | null;
  /** 内置 FFmpeg 没有 HTTP 传输能力，HLS 必须先在宿主侧落盘。 */
  supportsHttp: boolean;
}

export type MediaProbeInfo = MergeInfo;

/** 单集时长/分辨率探测结果。 */
export interface MediaDurationInfo {
  duration: number;
}

export function resolveMediaTools(host: MediaToolsHost | null | undefined): MediaTools {
  let found: FfmpegTools | null = null;
  try {
    found = host?.ffmpeg?.() ?? null;
  } catch {
    found = null;
  }
  let ffmpeg: string | null = null;
  let ffprobe: string | null = null;
  try {
    ffmpeg = found?.ffmpeg?.() ?? null;
  } catch {
    ffmpeg = null;
  }
  try {
    ffprobe = found?.ffprobe?.() ?? null;
  } catch {
    ffprobe = null;
  }
  return { ffmpeg, ffprobe, supportsHttp: found?.supportsHttp === true };
}

function toolError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause });
}

function canceledError(message = '已取消'): Error {
  return Object.assign(new Error(message), { code: 'CANCELED' });
}

export interface RunToolOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

export interface RunToolResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 超时/取消导致子进程被杀 */
  killed: boolean;
}

/**
 * 跑一个工具进程并收回输出。
 *
 * 与 4.5 的差别只在错误分类：工具本身起不来（ENOENT/EACCES）必须能区分出来，
 * 因为「工具坏了」不该被当成「片源坏了」去重试换清晰度。
 */
export function runTool(
  command: string,
  args: string[],
  options: RunToolOptions = {},
): Promise<RunToolResult> {
  const { timeoutMs = 30_000, signal, maxBuffer = 8 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(canceledError());
      return;
    }
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (signal) signal.removeEventListener('abort', abort);
        if (!error) {
          resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), killed: false });
          return;
        }
        const code = String((error as { code?: unknown }).code ?? '');
        const killed = Boolean(error.killed) || code === 'ETIMEDOUT' || Boolean(signal?.aborted);
        if (killed) {
          resolve({
            code: Number((error as { code?: unknown }).code) || -1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            killed: true,
          });
          return;
        }
        if (['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR'].includes(code)) {
          reject(toolError('视频处理工具不可用，请修复安装后重试', error));
          return;
        }
        resolve({
          code:
            typeof (error as { code?: unknown }).code === 'number'
              ? Number((error as { code?: unknown }).code)
              : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          killed: false,
        });
      },
    );
    const abort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function requirePath(tool: string | null, label: string): string {
  if (!tool) throw toolError(`未找到 ${label}，请重新下载完整发行包或检查安装后重试`);
  return tool;
}

export interface ProbeMediaOptions {
  tools: MediaTools;
  file: string;
  signal?: AbortSignal;
  /**
   * 工具本身无法运行时是否抛错。
   * 下载校验必须抛（否则「工具缺失」会被误判成「文件没画面」），
   * 只想知道「这文件是什么」的场景返回 null 更好。
   */
  rejectToolErrors?: boolean;
}

/** ffprobe → 合并/校验所需的结构；读不出来返回 null（工具坏了按选项抛错）。 */
export async function probeMedia(options: ProbeMediaOptions): Promise<MediaProbeInfo | null> {
  const { tools, file, signal, rejectToolErrors = false } = options;
  if (!tools.ffprobe) {
    if (rejectToolErrors) throw toolError('视频检查工具不可用，请修复安装后重试');
    return null;
  }
  const result = await runTool(
    tools.ffprobe,
    [
      '-v',
      'error',
      '-show_data_hash',
      'sha256',
      '-show_entries',
      'stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,extradata_hash,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries,field_order:format=duration,bit_rate,size',
      '-of',
      'json',
      file,
    ],
    { timeoutMs: 30_000, signal },
  ).catch((error) => {
    if (rejectToolErrors) throw error;
    return null;
  });
  if (!result) return null;
  if (result.killed) {
    if (signal?.aborted) throw canceledError('已取消媒体检查');
    if (rejectToolErrors) throw toolError('视频检查工具超时或无法运行');
    return null;
  }
  if (result.code !== 0) return null;
  try {
    return readMergeInfo(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/** 只要时长（转码进度要用）；工具缺失或解析失败返回 0。 */
export async function probeDuration(
  tools: MediaTools,
  file: string,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  if (!tools.ffprobe) return 0;
  const result = await runTool(
    tools.ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { timeoutMs: 30_000, signal: options.signal },
  ).catch(() => null);
  if (!result || result.code !== 0) return 0;
  const duration = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

/**
 * 发布成品：优先硬链接（原子、零拷贝），文件系统不支持时退回独占复制。
 *
 * 独占是关键：`COPYFILE_EXCL` 会在目标已存在时失败，绝不会覆盖用户自己放进去的文件。
 */
export function publishFile(source: string, destination: string): void {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? '');
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(code)) throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

export function shortEdge(variant: { width?: number; height?: number; pixels?: number }): number {
  return shortEdgeOf(variant);
}

export type EncoderPicker = (options?: { signal?: AbortSignal }) => Promise<string>;

/**
 * 探测可用的 H.264 编码器：先看 `-encoders` 列表，再**真的编一帧**。
 * 列表里有不代表能用（没有 N 卡时的 nvenc 就会失败），只用列表会得到一个
 * 一编译就失败的编码器，再回退重跑一遍整个合并。
 */
export function createEncoderPicker(tools: MediaTools): EncoderPicker {
  let cached: string | null = null;
  return async (options = {}) => {
    if (cached) return cached;
    const ffmpegPath = requirePath(tools.ffmpeg, 'FFmpeg');
    const listed = await runTool(ffmpegPath, ['-hide_banner', '-encoders'], {
      timeoutMs: 20_000,
      signal: options.signal,
    }).catch(() => null);
    if (options.signal?.aborted) throw canceledError();
    const text = listed?.stdout ?? '';
    const preferred =
      process.platform === 'darwin'
        ? ['h264_videotoolbox', 'libx264']
        : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264'];
    const candidates = preferred.filter((encoder) => text.includes(encoder));
    // 软件编码永远是兜底：即使列表里没打印（裁剪过的构建），也要试一次。
    if (!candidates.includes('libx264')) candidates.push('libx264');
    for (const encoder of candidates) {
      if (options.signal?.aborted) throw canceledError();
      const attempt = await runTool(
        ffmpegPath,
        [
          '-hide_banner',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=64x64:d=0.1',
          '-frames:v',
          '1',
          '-c:v',
          encoder,
          '-f',
          'null',
          '-',
        ],
        { timeoutMs: 25_000, signal: options.signal },
      ).catch(() => null);
      if (attempt?.code === 0) {
        cached = encoder;
        break;
      }
    }
    if (!cached) cached = 'libx264';
    return cached;
  };
}

/** 起一个长驻子进程（转码/合并用），返回可取消的句柄。 */
export interface SpawnedTool {
  child: ReturnType<typeof spawn>;
  /** 等它退出 */
  done: Promise<number>;
  /** 停止（优雅后强杀） */
  stop(): void;
}

export function spawnTool(
  command: string,
  args: string[],
  handlers: {
    onStdout?(chunk: string): void;
    onStderr?(chunk: string): void;
  } = {},
): SpawnedTool {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => handlers.onStdout?.(chunk));
  child.stderr?.on('data', (chunk: string) => handlers.onStderr?.(chunk));
  const done = new Promise<number>((resolve) => {
    child.once('error', () => {
      settled = true;
      clearTimeout(killTimer);
      resolve(-1);
    });
    child.once('close', (code) => {
      settled = true;
      clearTimeout(killTimer);
      resolve(typeof code === 'number' ? code : -1);
    });
  });
  return {
    child,
    done,
    stop() {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 2000);
      killTimer.unref?.();
    },
  };
}
