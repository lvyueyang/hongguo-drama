/**
 * 兼容模式转码（迁移自 4.5 `main.js` 的 transcodeForPlayback）。
 * 重点：缓存命中不重转、硬件编码器编不动就整轮换软件、产物只以正式名字出现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encoderArgs,
  parseProgress,
  resetTranscodeJobs,
  transcodeArgs,
  transcodeForCompat,
} from './transcode.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-transcode-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HONGGUO_FAKE_LOG;
  resetTranscodeJobs();
});

describe('参数表', () => {
  it('每个编码器有自己的推荐参数，未知编码器也不静默用 libx264 的参数', () => {
    expect(encoderArgs('libx264')).toContain('-crf');
    expect(encoderArgs('h264_videotoolbox')).toEqual([
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      '6M',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(encoderArgs('h264_nvenc')).toContain('-cq');
    expect(encoderArgs('h264_qsv')).toContain('-global_quality');
    expect(encoderArgs('h264_amf')).toContain('-qp_i');
    expect(encoderArgs('something_else')).toEqual(['-c:v', 'something_else', '-cq', '23']);
  });

  it('转码参数带进度管道与兼容性参数', () => {
    const args = transcodeArgs({ input: '/in.mp4', output: '/out.part', encoder: 'libx264' });
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:1');
    expect(args).toContain('-nostats');
    expect(args).toContain('+faststart');
    expect(args.slice(-1)).toEqual(['/out.part']);
    expect(args.join(' ')).toContain('-c:a aac');
    expect(args.join(' ')).toContain('-pix_fmt yuv420p');
  });
});

describe('parseProgress', () => {
  it('解析 out_time_us 与结束标记，忽略其它行', () => {
    expect(parseProgress('frame=10\nout_time_us=2500000\njunk\n')).toEqual([{ outTimeUs: 2_500_000 }]);
    expect(parseProgress('progress=end\n')).toEqual([{ done: true }]);
    expect(parseProgress('')).toEqual([]);
  });
});

describe('transcodeForCompat', () => {
  it('已有足够大的产物直接命中缓存，不启动转码（输入甚至可以不在了）', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(output, Buffer.alloc(200 * 1024, 1));
    const result = await transcodeForCompat({
      input: path.join(dir, 'missing.mp4'),
      output,
      tools: { ffmpeg: null, ffprobe: null, supportsHttp: false },
    });
    expect(result).toMatchObject({ cached: true, encoder: 'cache' });
    expect(fs.readFileSync(output).length).toBe(200 * 1024);
  });

  it('没有输入、没有 ffmpeg 都明确报错', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    await expect(
      transcodeForCompat({
        input: path.join(dir, 'missing.mp4'),
        output,
        tools: { ffmpeg: '/x', ffprobe: null, supportsHttp: false },
      }),
    ).rejects.toThrow(/找不到要转码/);
    const input = path.join(dir, 'in.mp4');
    fs.writeFileSync(input, 'media');
    await expect(
      transcodeForCompat({ input, output, tools: { ffmpeg: null, ffprobe: null, supportsHttp: false } }),
    ).rejects.toThrow(/未找到 ffmpeg/);
  });

  it('转码成功：进度按 out_time_us 上报，产物原子落盘，不留 .part', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
printf 'out_time_us=5000000\\n'
printf 'converted' > "$out"
exit 0`,
    );
    const percents: number[] = [];
    const result = await transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      onProgress: (percent) => percents.push(percent),
      pickEncoder: async () => 'libx264',
    });
    expect(result.cached).toBe(false);
    expect(result.encoder).toBe('libx264');
    expect(fs.readFileSync(output).toString()).toBe('converted');
    expect(fs.existsSync(`${output}.part`)).toBe(false);
    expect(percents).toContain(50);
    expect(percents.at(-1)).toBe(100);
  });

  it('硬件编码器编不动就整轮切软件编码，最后仍然产出成品', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const log = path.join(dir, 'calls.log');
    process.env.HONGGUO_FAKE_LOG = log;
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$HONGGUO_FAKE_LOG"
case "$*" in
  *h264_videotoolbox*) echo "no hardware" >&2; exit 1;;
esac
out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
printf 'software' > "$out"
exit 0`,
    );
    const result = await transcodeForCompat({
      input,
      output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
      pickEncoder: async () => 'h264_videotoolbox',
    });
    expect(result.encoder).toBe('libx264');
    expect(fs.readFileSync(output).toString()).toBe('software');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('h264_videotoolbox');
    expect(calls[1]).toContain('libx264');
  });

  it('软件编码也失败就如实报错，不留半成品', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const ffmpeg = script(dir, 'ffmpeg', 'echo "broken stream" >&2; exit 1');
    await expect(
      transcodeForCompat({
        input,
        output,
        tools: { ffmpeg, ffprobe, supportsHttp: false },
        pickEncoder: async () => 'libx264',
      }),
    ).rejects.toThrow(/软件转码失败/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.part`)).toBe(false);
  });

  it('已取消就不开始转码', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const controller = new AbortController();
    controller.abort();
    const pickEncoder = vi.fn(async () => 'libx264');
    await expect(
      transcodeForCompat({
        input,
        output,
        tools: { ffmpeg: '/x', ffprobe: null, supportsHttp: false },
        signal: controller.signal,
        pickEncoder,
      }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(output)).toBe(false);
  });
});

describe('并发转码去重（两个请求写同一个输出）', () => {
  it('同一输出并发调用只起一个 ffmpeg，两边拿到同一份结果', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const log = path.join(dir, 'calls.log');
    process.env.HONGGUO_FAKE_LOG = log;
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$HONGGUO_FAKE_LOG"
out=""
for arg in "$@"; do
  case "$arg" in /*) out="$arg";; esac
done
sleep 0.2
printf 'converted' > "$out"
exit 0`,
    );
    const tools = { ffmpeg, ffprobe, supportsHttp: false } as const;
    const pickEncoder = async () => 'libx264';
    const [first, second] = await Promise.all([
      transcodeForCompat({ input, output, tools, pickEncoder }),
      transcodeForCompat({ input, output, tools, pickEncoder }),
    ]);
    expect(first.output).toBe(second.output);
    expect(fs.readFileSync(output).toString()).toBe('converted');
    // 只起了一个 ffmpeg（否则两个会同时写 out.mp4.part）
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('force 时不复用在飞任务（用户手动重转要真的重来）', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'in.mp4');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, 'media');
    const log = path.join(dir, 'calls.log');
    process.env.HONGGUO_FAKE_LOG = log;
    const ffprobe = script(dir, 'ffprobe', 'echo 10');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$HONGGUO_FAKE_LOG"
out=""
for arg in "$@"; do
  case "$arg" in /*) out="$arg";; esac
done
sleep 0.2
printf 'converted' > "$out"
exit 0`,
    );
    const tools = { ffmpeg, ffprobe, supportsHttp: false } as const;
    const pickEncoder = async () => 'libx264';
    await Promise.all([
      transcodeForCompat({ input, output, tools, pickEncoder }),
      transcodeForCompat({ input, output, tools, pickEncoder, force: true }),
    ]);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
