/**
 * 一键合并（迁移自 4.5 `src/native/merge-runner.js` 的 runMerge）。
 * 重点：编码一致才直复制、缺信息不猜、发布不覆盖、取消能停住子进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultOutputPath, type MergeTask, mergeSeries } from './merge.ts';
import { probeMedia } from './tools.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-merge-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function probeJson(
  options: { codec?: string; width?: number; height?: number; extradata?: string } = {},
): string {
  const { codec = 'h264', width = 1080, height = 1920, extradata = 'hash-a' } = options;
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: codec,
        width,
        height,
        pix_fmt: 'yuv420p',
        sample_aspect_ratio: '1:1',
        r_frame_rate: '30/1',
        time_base: '1/90000',
        extradata_hash: extradata,
      },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', extradata_hash: 'a' },
    ],
    format: { duration: '10', size: '200000' },
  });
}

interface Fixture {
  dir: string;
  tools: { ffmpeg: string; ffprobe: string; supportsHttp: false };
  log: string;
  episodes: Array<{ path: string; vid_index: number }>;
}

function fixture(options: { probeJson?: string; failProbe?: boolean } = {}): Fixture {
  const dir = tempDir();
  const log = path.join(dir, 'ffmpeg.log');
  process.env.HONGGUO_FAKE_LOG = log;
  const ffprobe = script(
    dir,
    'ffprobe',
    options.failProbe ? 'exit 1' : `cat <<'EOF'\n${options.probeJson ?? probeJson()}\nEOF`,
  );
  const ffmpeg = script(
    dir,
    'ffmpeg',
    `echo "$*" >> "$HONGGUO_FAKE_LOG"
out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
[ -n "$out" ] && printf 'merged-media' > "$out"
printf 'out_time_us=5000000\\n'
exit 0`,
  );
  const episodes = [1, 2].map((index) => {
    const file = path.join(dir, `ep${index}.mp4`);
    fs.writeFileSync(file, `episode-${index}`);
    return { path: file, vid_index: index };
  });
  return { dir, tools: { ffmpeg, ffprobe, supportsHttp: false }, log, episodes };
}

function task(): MergeTask {
  return { id: 'merge-1', seriesId: '1', status: 'running', stage: 'checking' };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HONGGUO_FAKE_LOG;
});

describe('defaultOutputPath', () => {
  it('默认「<剧名>_合集.mp4」，同名已存在就顺延，不覆盖', () => {
    const dir = tempDir();
    const first = defaultOutputPath(dir, '测试剧');
    expect(path.basename(first)).toBe('测试剧_合集.mp4');
    fs.writeFileSync(first, 'existing');
    const second = defaultOutputPath(dir, '测试剧');
    expect(path.basename(second)).toBe('测试剧_合集 (2).mp4');
    // 剧名里的非法字符会被净化
    expect(path.basename(defaultOutputPath(dir, 'a/b:c'))).toBe('abc_合集.mp4');
  });
});

describe('mergeSeries', () => {
  it('编码一致走直复制：只跑一次 concat，产出成品并清理工作目录', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const result = await mergeSeries({
      task: task(),
      episodes: h.episodes,
      outDir: h.dir,
      outputPath: output,
      tools: h.tools,
    });
    expect(result).toMatchObject({ path: output, count: 2 });
    expect(fs.readFileSync(output).toString()).toBe('merged-media');
    const calls = fs.readFileSync(h.log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-f concat');
    expect(calls[0]).toContain('-c copy');
    expect(fs.readdirSync(h.dir).some((name) => name.startsWith('.merge-'))).toBe(false);
  });

  it('分集信息读不出来时不猜：明确要求重新下载该集', async () => {
    const h = fixture({ failProbe: true });
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: path.join(h.dir, 'out.mp4'),
        tools: h.tools,
      }),
    ).rejects.toThrow(/第 1 集无法读取有效视频信息/);
  });

  it('编码不一致时先逐集统一编码再合，任务状态与说明同步更新', async () => {
    const h = fixture();
    const t = task();
    const mergeInfo = (extradata: string) => ({
      codec: 'hevc',
      w: 1080,
      h: 1920,
      audio: true,
      duration: 10,
      video: {
        codec_name: 'hevc',
        width: 1080,
        height: 1920,
        time_base: '1/90000',
        r_frame_rate: '30/1',
        pix_fmt: 'yuv420p',
        sample_aspect_ratio: '1:1',
      },
      audioStream: { codec_name: 'aac', time_base: '1/90000', extradata_hash: 'a' },
      videoSignature: extradata,
      audioSignature: 'a1',
      signature: `s-${extradata}`,
      videoBitrate: 2_000_000,
    });
    let index = 0;
    const result = await mergeSeries({
      task: t,
      episodes: h.episodes,
      outDir: h.dir,
      outputPath: path.join(h.dir, 'out.mp4'),
      tools: h.tools,
      // 兼容模式要求 H.264，而分集是 HEVC → 必须逐集重编码。
      compatible: true,
      probe: async () => {
        index += 1;
        return mergeInfo(index === 1 ? 'v1' : 'v2') as never;
      },
    });
    expect(result.count).toBe(2);
    const calls = fs.readFileSync(h.log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.join('\n')).toContain('-c:v libx264');
    expect(t.status).toBe('completed');
    expect(t.method).toBe('统一视频编码');
    expect(t.progress).toBe(100);
    expect(t.done).toBe(2);
    expect(fs.existsSync(path.join(h.dir, 'out.mp4'))).toBe(true);
  });

  it('require1080：任一集达不到 1080P 就拒绝，且不建工作目录、不产出文件', async () => {
    const h = fixture({ probeJson: probeJson({ width: 720, height: 1280 }) });
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: output,
        tools: h.tools,
        require1080: true,
      }),
    ).rejects.toThrow(/第 1 集实际为 720P/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(h.dir).some((name) => name.startsWith('.merge-'))).toBe(false);
  });

  it('require1080：全部达标时照常合并', async () => {
    const h = fixture();
    const result = await mergeSeries({
      task: task(),
      episodes: h.episodes,
      outDir: h.dir,
      outputPath: path.join(h.dir, 'out.mp4'),
      tools: h.tools,
      require1080: true,
    });
    expect(result.count).toBe(2);
  });

  it('目标文件已存在时失败，且不覆盖用户文件', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    fs.writeFileSync(output, 'user file');
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: output,
        tools: h.tools,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(output).toString()).toBe('user file');
  });

  it('取消后停止子进程并报「已取消」，不产出成品', async () => {
    const h = fixture();
    const t = task();
    const output = path.join(h.dir, 'out.mp4');
    const slowFfmpeg = script(
      h.dir,
      'ffmpeg-slow',
      `echo "$*" >> "$HONGGUO_FAKE_LOG"
sleep 5
out=""
for arg in "$@"; do
  case "$arg" in /*) out="$arg";; esac
done
[ -n "$out" ] && printf 'merged-media' > "$out"`,
    );
    const pending = mergeSeries({
      task: t,
      episodes: h.episodes,
      outDir: h.dir,
      outputPath: output,
      tools: { ...h.tools, ffmpeg: slowFfmpeg },
      onProgress: () => {
        t.cancelled = true;
      },
    });
    await expect(pending).rejects.toThrow(/已取消/);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('没有 ffmpeg/ffprobe 时明确报错', async () => {
    const h = fixture();
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: path.join(h.dir, 'out.mp4'),
        tools: { ffmpeg: null, ffprobe: null, supportsHttp: false },
      }),
    ).rejects.toThrow(/未找到完整 FFmpeg/);
  });

  it('没有分集时直接报错', async () => {
    const h = fixture();
    await expect(
      mergeSeries({
        task: task(),
        episodes: [],
        outDir: h.dir,
        outputPath: path.join(h.dir, 'out.mp4'),
        tools: h.tools,
      }),
    ).rejects.toThrow(/还没有已完成的下载/);
  });
});

/**
 * 真实 FFmpeg 的合并验收（对应旧基准 `scripts/check-merge-benchmark.cjs` 对新实现的断言）。
 *
 * 基准脚本比较的是「旧 main.js vs 新实现」，旧实现随 main.js 一起下线；
 * 但它在**新实现**上验的这几条是硬要求：时长等于各集之和、产物能全片静默解码、
 * 不留临时目录、源文件不被改动。这里用真 FFmpeg 生成的片段跑一遍（无 ffmpeg 时跳过）。
 */
function detectRealTools(): { ffmpeg: string; ffprobe: string; supportsHttp: boolean } | null {
  const names =
    process.platform === 'win32'
      ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }
      : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const dirs = [
    path.resolve(process.cwd(), 'build', 'ffmpeg', `${process.platform}-${process.arch}`),
    path.resolve(process.cwd(), 'build', 'ffmpeg'),
    ...String(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean),
  ];
  for (const dir of dirs) {
    const ffmpeg = path.join(dir, names.ffmpeg);
    const ffprobe = path.join(dir, names.ffprobe);
    try {
      fs.accessSync(ffmpeg, fs.constants.X_OK);
      fs.accessSync(ffprobe, fs.constants.X_OK);
      return { ffmpeg, ffprobe, supportsHttp: false };
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

const realTools = detectRealTools();

describe.skipIf(!realTools)('真实 FFmpeg 合并（需要本机 ffmpeg/ffprobe）', () => {
  it('直复制合并：时长等于各集之和、全片可解码、不留临时目录、源文件不动', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tempDir();
    const ffmpeg = (realTools as { ffmpeg: string }).ffmpeg;
    const clips = ['a', 'b'].map((name) => {
      const file = path.join(dir, `${name}.mp4`);
      execFileSync(
        ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=320x240:r=24:d=2',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=2',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          file,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
      );
      return file;
    });
    const before = clips.map((file) => {
      const stat = fs.statSync(file);
      return [stat.size, stat.mtimeMs];
    });
    const output = path.join(dir, 'merged.mp4');
    const result = await mergeSeries({
      task: { id: 'merge-real', seriesId: '1', status: 'running' },
      episodes: [
        { path: clips[0], vid_index: 1 },
        { path: clips[1], vid_index: 2 },
      ],
      outDir: dir,
      outputPath: output,
      tools: realTools!,
    });
    expect(result.count).toBe(2);
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('.merge-'))).toBe(false);

    const info = await probeMedia({ tools: realTools!, file: output });
    expect(info?.duration).toBeGreaterThan(3.6);
    expect(info?.duration).toBeLessThan(4.4);

    // 全片静默解码：坏文件的元数据可能完好，只有真解码能证伪
    const decoded = execFileSync(
      ffmpeg,
      ['-v', 'error', '-xerror', '-nostdin', '-i', output, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, encoding: 'utf8' },
    );
    expect(String(decoded).trim()).toBe('');

    // 源文件必须原样保留（合并是只读的）
    for (const [index, file] of clips.entries()) {
      const stat = fs.statSync(file);
      expect([stat.size, stat.mtimeMs]).toEqual(before[index]);
    }
  });
});
