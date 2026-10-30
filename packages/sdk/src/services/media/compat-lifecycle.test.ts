/**
 * 兼容转码的生命周期（迁移自 4.5 `scripts/check-compat-lifecycle.cjs` 中
 * **在 5.0 仍有对应实现**的取消/回退/缓存部分）。
 *
 * 4.5 的这条检查跑的是 `main.js` 里包在转码外的编排：来源权限查询、锁定集拦截、
 * 同集请求去重（共享请求）、清兼容缓存、临时解密输入。5.0 把这些都去掉了：
 * `transcodePort`（apps/desktop/src/main/index.ts）拿的是**已下载到本地的成品**
 * （`queue.get(taskId)` → `task.savePath`），没有"在线取源 + 权限门槛"这一层，
 * 也就没有共享请求注册表与清缓存通道。所以这里只锁**转码器自己的生命周期**：
 *
 * - 取消发生在时长探测阶段 → 连编码器探测都不许起（旧检查第 5 条）；
 * - 取消正在跑的转码 → 杀子进程、不发布半成品、**不启动软件回退**（旧检查第 11 条）；
 * - 硬编失败换软编、软编再失败就停手并清理（旧检查第 10 条）；
 * - force 忽略缓存且不探测硬件编码器，失败只试一次（旧检查第 12、14 条）；
 * - 缓存命中不启动任何子进程；
 * - 产物只以正式名字出现（旧检查「不给播放器半成品」的语义）；
 * - 无论成功、失败还是取消，源文件都原样保留（旧检查第 13 条）。
 *
 * 全部用替身脚本跑，不需要真实 ffmpeg。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcodeForCompat } from './transcode.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-compat-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** 转码参数里的产物路径永远是最后一个绝对路径参数。 */
const OUTPUT_PICK = `out=""
for arg in "$@"; do case "$arg" in /*) out="$arg";; esac; done`;

// 全量跑时每个文件一个 worker、每个用例还起真子进程：5s 就绪等待会被负载顶掉，放宽到 20s。
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待替身脚本就绪超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 替身脚本靠环境变量拿到日志/信号文件路径（spawn 继承进程环境）。
 * ffmpeg 与 ffprobe 用各自的变量，避免互相覆盖。
 */
const FFMPEG_LOG = 'HONGGUO_COMPAT_FFMPEG_LOG';
const PROBE_LOG = 'HONGGUO_COMPAT_PROBE_LOG';
const STOP_FILE = 'HONGGUO_COMPAT_STOP';

/** 一次「能跑起来但永远不结束」的转码：等取消信号文件出现才退出。 */
function stallingFfmpeg(dir: string, log: string, stopFile: string): string {
  process.env[FFMPEG_LOG] = log;
  process.env[STOP_FILE] = stopFile;
  return script(
    dir,
    'ffmpeg-stall',
    `echo "$*" >> "$${FFMPEG_LOG}"
${OUTPUT_PICK}
printf 'partial-media' > "$out"
while [ ! -f "$${STOP_FILE}" ]; do sleep 0.02; done
exit 143`,
  );
}

function inputs(dir: string): { input: string; output: string; probeLog: string } {
  const input = path.join(dir, 'downloaded.mp4');
  fs.writeFileSync(input, Buffer.alloc(120 * 1024, 7));
  return {
    input,
    output: path.join(dir, 'downloaded.mp4.compat.mp4'),
    probeLog: path.join(dir, 'probe.log'),
  };
}

function stat(file: string): [number, number] {
  const info = fs.statSync(file);
  return [info.size, info.mtimeMs];
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[FFMPEG_LOG];
  delete process.env[PROBE_LOG];
  delete process.env[STOP_FILE];
});

describe('取消语义（旧 check-compat-lifecycle 第 5、11 条）', () => {
  it('时长探测阶段取消：连编码器探测都不起，不留任何产物', async () => {
    const dir = tempDir();
    const { input, output, probeLog } = inputs(dir);
    const before = stat(input);
    process.env[PROBE_LOG] = probeLog;
    const ffprobe = script(dir, 'ffprobe', `echo probing >> "$${PROBE_LOG}"\nsleep 0.5\necho 10`);
    const log = path.join(dir, 'ffmpeg.log');
    const ffmpeg = stallingFfmpeg(dir, log, path.join(dir, 'never'));
    const controller = new AbortController();
    const pending = transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      signal: controller.signal,
    });
    // 确认取消发生在探测阶段（而不是探测之前就短路了）
    await waitFor(() => fs.existsSync(probeLog));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.part`)).toBe(false);
    expect(stat(input)).toEqual(before);
  });

  it('取消正在跑的转码：杀子进程、不发布半成品、不启动软件回退', { timeout: 60_000 }, async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    const log = path.join(dir, 'ffmpeg.log');
    const stop = path.join(dir, 'stop');
    const ffmpeg = stallingFfmpeg(dir, log, stop);
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const controller = new AbortController();
    const pending = transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      pickEncoder: async () => 'h264_nvenc',
      signal: controller.signal,
    });
    await waitFor(() => fs.existsSync(log));
    fs.writeFileSync(stop, '');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.part`)).toBe(false);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('h264_nvenc');
    expect(fs.readFileSync(input).length).toBe(120 * 1024);
  });

  it('已经开始转码就不再接受取消之外的第二次尝试：失败只发生在硬编这一轮', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    const log = path.join(dir, 'ffmpeg.log');
    process.env[FFMPEG_LOG] = log;
    const ffmpeg = script(dir, 'ffmpeg', `echo "$*" >> "$${FFMPEG_LOG}"\necho "no device" >&2\nexit 1`);
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    await expect(
      transcodeForCompat({
        input,
        output,
        tools: { ffmpeg, ffprobe, supportsHttp: false },
        pickEncoder: async () => 'h264_nvenc',
      }),
    ).rejects.toThrow(/软件转码失败.*1/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.map((line) => (line.includes('h264_nvenc') ? 'hardware' : 'software'))).toEqual([
      'hardware',
      'software',
    ]);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.part`)).toBe(false);
  });
});

describe('失败清理与源文件不变（旧 check-compat-lifecycle 第 10、13 条）', () => {
  it('软编也失败：如实报错、不留 .part 与正式产物、源文件字节与 mtime 不变', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    const before = stat(input);
    process.env[FFMPEG_LOG] = path.join(dir, 'ffmpeg.log');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$${FFMPEG_LOG}"\necho "broken colormatrix" >&2\nexit 2`,
    );
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    await expect(
      transcodeForCompat({
        input,
        output,
        tools: { ffmpeg, ffprobe, supportsHttp: false },
        pickEncoder: async () => 'h264_nvenc',
      }),
    ).rejects.toThrow(/软件转码失败.*2/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.part`)).toBe(false);
    expect(stat(input)).toEqual(before);
  });

  it('转码成功也不会改动输入文件（下载成品是只读输入）', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    const before = stat(input);
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `${OUTPUT_PICK}
printf 'compat-media' > "$out"
printf 'out_time_us=9000000\\n'
exit 0`,
    );
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const result = await transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      pickEncoder: async () => 'libx264',
    });
    expect(result).toMatchObject({ cached: false, encoder: 'libx264' });
    expect(fs.readFileSync(output).toString()).toBe('compat-media');
    expect(fs.existsSync(`${output}.part`)).toBe(false);
    expect(stat(input)).toEqual(before);
  });
});

describe('缓存与 force（旧 check-compat-lifecycle 第 12 条）', () => {
  it('缓存命中：不启动任何子进程，产物原地不动', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    fs.writeFileSync(output, Buffer.alloc(200 * 1024, 1));
    const ffmpeg = script(dir, 'ffmpeg', 'exit 1');
    const ffprobe = script(dir, 'ffprobe', 'exit 1');
    const pickEncoder = vi.fn(async () => 'h264_nvenc');
    const result = await transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      pickEncoder,
    });
    expect(result).toMatchObject({ cached: true, encoder: 'cache', bytes: 200 * 1024 });
    expect(pickEncoder).not.toHaveBeenCalled();
  });

  it('force 忽略缓存、不探测硬件编码器，且软件失败只试一次、不破坏已有产物', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    fs.writeFileSync(output, Buffer.alloc(200 * 1024, 3));
    const before = stat(input);
    const log = path.join(dir, 'ffmpeg.log');
    process.env[FFMPEG_LOG] = log;
    const ffmpeg = script(dir, 'ffmpeg', `echo "$*" >> "$${FFMPEG_LOG}"\necho "boom" >&2\nexit 9`);
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const pickEncoder = vi.fn(async () => 'h264_nvenc');
    await expect(
      transcodeForCompat({
        input,
        output,
        tools: { ffmpeg, ffprobe, supportsHttp: false },
        force: true,
        pickEncoder,
      }),
    ).rejects.toThrow(/软件转码失败.*9/);
    expect(pickEncoder).not.toHaveBeenCalled();
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('libx264');
    expect(fs.readFileSync(output).length).toBe(200 * 1024);
    expect(stat(input)).toEqual(before);
  });
});

describe('产物原子性（旧检查「不把半成品交给播放器」的语义）', () => {
  it('转码进行中只有 .part，正式名字只在成功后出现', async () => {
    const dir = tempDir();
    const { input, output } = inputs(dir);
    const stop = path.join(dir, 'finish');
    process.env[STOP_FILE] = stop;
    const temporary = `${output}.part`;
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `${OUTPUT_PICK}
printf 'partial' > "$out"
while [ ! -f "$${STOP_FILE}" ]; do sleep 0.02; done
printf 'final-media' > "$out"
exit 0`,
    );
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const pending = transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      pickEncoder: async () => 'libx264',
    });
    await waitFor(() => fs.existsSync(temporary));
    expect(fs.existsSync(output)).toBe(false);
    fs.writeFileSync(stop, '');
    const result = await pending;
    expect(result.cached).toBe(false);
    expect(fs.readFileSync(output).toString()).toBe('final-media');
    expect(fs.existsSync(temporary)).toBe(false);
  });
});
