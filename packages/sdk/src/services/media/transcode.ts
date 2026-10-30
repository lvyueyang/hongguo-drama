// SPDX-License-Identifier: MIT
/**
 * 兼容模式转码：把 HEVC（平台常用编码）转成 H.264，解决「黑屏但有声音」。
 *
 * 迁移自 4.5 `main.js` 的 `transcodeForPlayback`。为什么这么绕：
 * Chromium 在 Windows 上只能靠硬件解 HEVC，显卡不支持或被 GPU 黑名单挡掉时就黑屏；
 * 转码是唯一不依赖用户硬件的兜底。编码器按平台挑，挑到的**真的能编一帧**才用，
 * 失败整轮换软件编码，绝不混用参数。
 */
import fs from 'node:fs';
import {
  createEncoderPicker,
  type EncoderPicker,
  type MediaTools,
  probeDuration,
  spawnTool,
} from './tools.ts';

export interface TranscodeRequest {
  input: string;
  output: string;
  tools: MediaTools;
  onProgress?(percent: number): void;
  signal?: AbortSignal;
  pickEncoder?: EncoderPicker;
  /** 忽略缓存强制重转 */
  force?: boolean;
  /** 小于这个字节数的产物视为缓存无效 */
  minCacheBytes?: number;
}

export interface TranscodeResult {
  output: string;
  cached: boolean;
  bytes: number;
  encoder: string;
}

/** 各编码器的推荐参数：硬件编码器不认 libx264 的 crf/preset。 */
export function encoderArgs(encoder: string): string[] {
  if (encoder === 'libx264')
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.2'];
  if (encoder === 'h264_videotoolbox')
    return ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p'];
  if (encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0'];
  if (encoder === 'h264_qsv') return ['-c:v', 'h264_qsv', '-global_quality', '23'];
  if (encoder === 'h264_amf')
    return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'];
  return ['-c:v', encoder, '-cq', '23'];
}

/** 完整转码参数；`-progress pipe:1` 让进度可解析（比解析 stderr 稳）。 */
export function transcodeArgs(options: { input: string; output: string; encoder: string }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-i',
    options.input,
    ...encoderArgs(options.encoder),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'mp4',
    options.output,
  ];
}

export interface TranscodeProgressTick {
  outTimeUs?: number;
  /** ffmpeg 报 `progress=end` */
  done?: boolean;
}

/** 解析 `-progress pipe:1` 的一小段输出；不完整的尾行由调用方自己缓存。 */
export function parseProgress(chunk: string): TranscodeProgressTick[] {
  const ticks: TranscodeProgressTick[] = [];
  for (const line of chunk.split('\n')) {
    const match = /^out_time_us=(\d+)$/.exec(line.trim());
    if (match) ticks.push({ outTimeUs: Number(match[1]) });
    else if (/^progress=end$/.test(line.trim())) ticks.push({ done: true });
  }
  return ticks;
}

/** 同一输出路径的在飞转码：并发请求共享同一次任务，避免两个 ffmpeg 写同一个 .part。 */
const inFlight = new Map<string, Promise<TranscodeResult>>();

export async function transcodeForCompat(request: TranscodeRequest): Promise<TranscodeResult> {
  const key = String(request.output);
  const running = inFlight.get(key);
  if (running) {
    // 同一输出已经有任务在跑：普通请求直接共享它；force 请求等它结束再重来，
    // 否则两个 ffmpeg 会抢同一个 `.part`，产出互相覆盖的坏文件。
    if (!request.force) return running;
    await running.catch(() => {});
  }
  const job = runTranscode(request);
  inFlight.set(key, job);
  void job
    .catch(() => {})
    .finally(() => {
      if (inFlight.get(key) === job) inFlight.delete(key);
    });
  return job;
}

/** 只供测试：清掉在飞表（避免用例之间互相影响）。 */
export function resetTranscodeJobs(): void {
  inFlight.clear();
}

async function runTranscode(request: TranscodeRequest): Promise<TranscodeResult> {
  const { input, output, tools, signal } = request;
  const minCacheBytes = Number(request.minCacheBytes) > 0 ? Number(request.minCacheBytes) : 100 * 1024;

  if (!request.force && fs.existsSync(output) && fs.statSync(output).size > minCacheBytes) {
    // 命中缓存：刷新访问时间，避免被当成旧文件清掉。
    try {
      const now = new Date();
      fs.utimesSync(output, now, now);
    } catch {
      /* 只影响淘汰顺序 */
    }
    return { output, cached: true, bytes: fs.statSync(output).size, encoder: 'cache' };
  }
  if (!fs.existsSync(input)) throw new Error('找不到要转码的视频文件');
  if (!tools.ffmpeg) throw new Error('未找到 ffmpeg，无法转码');

  const duration = await probeDuration(tools, input, { signal });
  let encoder = request.force
    ? 'libx264'
    : await (request.pickEncoder ?? createEncoderPicker(tools))({ signal });
  const temporary = `${output}.part`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('已取消转码'), { code: 'CANCELED' });
    fs.rmSync(temporary, { force: true });
    const tool = spawnTool(tools.ffmpeg, transcodeArgs({ input, output: temporary, encoder }));
    let pending = '';
    let stderrTail = '';
    const abort = () => {
      tool.stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    tool.child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const tick of parseProgress(lines.join('\n'))) {
        if (tick.done) {
          request.onProgress?.(100);
          continue;
        }
        if (!tick.outTimeUs || !(duration > 0)) continue;
        const seconds = tick.outTimeUs / 1e6;
        request.onProgress?.(Math.max(0, Math.min(99, Math.floor((seconds / duration) * 100))));
      }
    });
    tool.child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-1500);
    });
    const code = await tool.done;
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) {
      fs.rmSync(temporary, { force: true });
      throw Object.assign(new Error('已取消转码'), { code: 'CANCELED' });
    }
    if (code === 0 && fs.existsSync(temporary)) {
      fs.renameSync(temporary, output);
      request.onProgress?.(100);
      return { output, cached: false, bytes: fs.statSync(output).size, encoder };
    }
    fs.rmSync(temporary, { force: true });
    const tail = stderrTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
    lastError = new Error(`软件转码失败（ffmpeg 退出码 ${code}）${tail ? `：${tail}` : ''}`);
    // 硬件编码器失败就整轮换软件编码，重来一次。
    if (encoder === 'libx264') break;
    encoder = 'libx264';
  }
  throw lastError ?? new Error('转码失败');
}
