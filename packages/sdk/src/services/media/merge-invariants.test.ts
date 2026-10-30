/**
 * 合并的不变量（迁移自 4.5 `scripts/check-merge.cjs` 中**不依赖真实媒体**的部分，
 * 外加一条需要真实 ffmpeg 的黑帧回归）。
 *
 * 4.5 那条检查用真 ffmpeg 生成横屏/竖屏/异编码片段，经 `merge-series` IPC 合并后逐帧比对
 * 尺寸、检查取消与 FFmpeg 失败不留输出、源文件字节与 mtime 不变、每个源文件只探测一次。
 * 5.0 把逻辑搬到 `merge.ts`，本文件用替身脚本覆盖同一批不变量：
 *
 * - 每个分集只探测一次，且从不探测中间产物与输出（旧检查的 `probeCalls` 断言）；
 * - FFmpeg 失败：不发布输出、不留 `.merge-*` 临时目录、源文件字节与 mtime 不变；
 * - 取消：子进程跑着时取消，结束后不发布输出、不留临时目录、源文件不变；
 * - `require1080` 拒绝：连工作目录都不建、不跑 ffmpeg、源文件不变；
 * - 上次中断留下的工作目录只清自己建的那种（`cleanupMergeTemps`）；
 * - **黑帧回归**（旧检查的核心）：动态分辨率直复制合并后，全片能解码、每集画面尺寸都出现、
 *   时长等于各集之和。这条需要真实 ffmpeg，本机没有时整块跳过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupMergeTemps, type MergeTask, mergeSeries } from './merge.ts';
import { buildMergePlan, type MergeInfo, readMergeInfo } from './merge-plan.ts';
import { probeMedia } from './tools.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-merge-invariants-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** 替身 ffmpeg 的产物路径：参数里最后一个绝对路径（与 4.5 的 check-merge 同一约定）。 */
const OUTPUT_PICK = `out=""
for arg in "$@"; do case "$arg" in /*) out="$arg";; esac; done`;

const FFMPEG_LOG = 'HONGGUO_MERGE_FFMPEG_LOG';
const PROBE_LOG = 'HONGGUO_MERGE_PROBE_LOG';
const STOP_FILE = 'HONGGUO_MERGE_STOP';

// 全量跑时每个文件一个 worker、每个用例还起真子进程：5s 就绪等待会被负载顶掉，放宽到 20s。
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待合并子进程就绪超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function probeJson(options: { width: number; height: number; duration: string; extradata: string }): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: options.width,
        height: options.height,
        pix_fmt: 'yuv420p',
        sample_aspect_ratio: '1:1',
        r_frame_rate: '24/1',
        time_base: '1/90000',
        extradata_hash: options.extradata,
      },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', extradata_hash: 'a' },
    ],
    format: { duration: options.duration, size: '200000' },
  });
}

interface Fixture {
  dir: string;
  episodes: Array<{ path: string; vid_index: number }>;
  tools: { ffmpeg: string; ffprobe: string; supportsHttp: false };
  probeLog: string;
  ffmpegLog: string;
  /** 每个源文件的原样指纹，用来验「合并是只读的」 */
  fingerprint(): Array<[number, number]>;
}

/** 两集同编码同参数（走直复制），替身脚本记录每一次探测与转码。 */
function fixture(options: { ffmpegBody?: string } = {}): Fixture {
  const dir = tempDir();
  const probeLog = path.join(dir, 'probe.log');
  const ffmpegLog = path.join(dir, 'ffmpeg.log');
  process.env[PROBE_LOG] = probeLog;
  process.env[FFMPEG_LOG] = ffmpegLog;
  const ffprobe = script(
    dir,
    'ffprobe',
    `echo "$*" >> "$${PROBE_LOG}"
cat <<'EOF'
${probeJson({ width: 1080, height: 1920, duration: '10', extradata: 'hash-a' })}
EOF`,
  );
  const ffmpeg = script(
    dir,
    'ffmpeg',
    options.ffmpegBody ??
      `echo "$*" >> "$${FFMPEG_LOG}"
${OUTPUT_PICK}
printf 'merged-media' > "$out"
printf 'out_time_us=5000000\\n'
exit 0`,
  );
  const episodes = [1, 2].map((index) => {
    const file = path.join(dir, `ep${index}.mp4`);
    fs.writeFileSync(file, `episode-${index}`);
    return { path: file, vid_index: index };
  });
  return {
    dir,
    episodes,
    tools: { ffmpeg, ffprobe, supportsHttp: false },
    probeLog,
    ffmpegLog,
    fingerprint: () =>
      episodes.map((episode) => {
        const info = fs.statSync(episode.path);
        return [info.size, info.mtimeMs];
      }),
  };
}

const task = (): MergeTask => ({
  id: 'merge-invariants',
  seriesId: '1',
  status: 'running',
  stage: 'checking',
});
const probes = (file: string): string[] =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => path.resolve(line.trim().split(' ').at(-1) as string));

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[FFMPEG_LOG];
  delete process.env[PROBE_LOG];
  delete process.env[STOP_FILE];
});

describe('探测范围（旧 check-merge.cjs 的 probeCalls 断言）', () => {
  it('每个分集只探测一次，且只探测源文件，不探测输出', async () => {
    const h = fixture();
    const result = await mergeSeries({
      task: task(),
      episodes: h.episodes,
      outDir: h.dir,
      outputPath: path.join(h.dir, 'out.mp4'),
      tools: h.tools,
    });
    expect(result.count).toBe(2);
    expect(probes(h.probeLog)).toEqual(h.episodes.map((episode) => path.resolve(episode.path)));
  });

  it('合并失败时分集也各只探测一次，不做二次校验', async () => {
    const h = fixture({ ffmpegBody: 'echo "concat failed" >&2\nexit 1' });
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: path.join(h.dir, 'out.mp4'),
        tools: h.tools,
      }),
    ).rejects.toThrow(/FFmpeg 退出码 1/);
    expect(probes(h.probeLog)).toEqual(h.episodes.map((episode) => path.resolve(episode.path)));
  });
});

describe('失败与取消的收尾（旧 check-merge.cjs 的 FFmpeg 失败 / 取消断言）', () => {
  it('FFmpeg 失败：不发布输出、不留临时目录、源文件字节与 mtime 不变', async () => {
    const h = fixture({ ffmpegBody: 'echo "ffmpeg exploded" >&2\nexit 1' });
    const before = h.fingerprint();
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: output,
        tools: h.tools,
      }),
    ).rejects.toThrow(/ffmpeg exploded/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(h.dir).some((name) => name.startsWith('.merge-'))).toBe(false);
    expect(h.fingerprint()).toEqual(before);
  });

  it('子进程运行中取消：结束后立即失败、不发布输出、不留临时目录、源文件不变', async () => {
    const dir = tempDir();
    const stop = path.join(dir, 'stop');
    process.env[STOP_FILE] = stop;
    const ffmpegLog = path.join(dir, 'ffmpeg.log');
    process.env[FFMPEG_LOG] = ffmpegLog;
    // 子进程挂住，等测试放行后才退出（模拟「正在合并」的中间态）
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$${FFMPEG_LOG}"
${OUTPUT_PICK}
printf 'merged-media' > "$out"
while [ ! -f "$${STOP_FILE}" ]; do sleep 0.02; done
exit 0`,
    );
    const probeLog = path.join(dir, 'probe.log');
    process.env[PROBE_LOG] = probeLog;
    const ffprobe = script(
      dir,
      'ffprobe',
      `echo "$*" >> "$${PROBE_LOG}"
cat <<'EOF'
${probeJson({ width: 1080, height: 1920, duration: '10', extradata: 'hash-a' })}
EOF`,
    );
    const episodes = [1, 2].map((index) => {
      const file = path.join(dir, `ep${index}.mp4`);
      fs.writeFileSync(file, `episode-${index}`);
      return { path: file, vid_index: index };
    });
    const before = episodes.map((episode) => {
      const info = fs.statSync(episode.path);
      return [info.size, info.mtimeMs];
    });
    const output = path.join(dir, 'out.mp4');
    const t = task();
    const pending = mergeSeries({
      task: t,
      episodes,
      outDir: dir,
      outputPath: output,
      tools: { ffmpeg, ffprobe, supportsHttp: false },
    });
    await waitFor(() => (t.children?.size ?? 0) > 0);
    t.cancelled = true;
    fs.writeFileSync(stop, '');
    await expect(pending).rejects.toThrow(/已取消/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('.merge-'))).toBe(false);
    expect(
      episodes.map((episode) => {
        const info = fs.statSync(episode.path);
        return [info.size, info.mtimeMs];
      }),
    ).toEqual(before);
  });

  it('require1080 拒绝：连工作目录都不建、不跑 ffmpeg、源文件不变', async () => {
    const h = fixture();
    const before = h.fingerprint();
    await expect(
      mergeSeries({
        task: task(),
        episodes: h.episodes,
        outDir: h.dir,
        outputPath: path.join(h.dir, 'out.mp4'),
        tools: h.tools,
        require1080: true,
        probe: async (file: string) =>
          readMergeInfo(
            JSON.parse(
              probeJson({
                width: 720,
                height: 1280,
                duration: '10',
                extradata: file.endsWith('ep1.mp4') ? 'hash-a' : 'hash-b',
              }),
            ),
          ) as MergeInfo,
      }),
    ).rejects.toThrow(/第 1 集实际为 720P/);
    expect(fs.existsSync(h.ffmpegLog)).toBe(false);
    expect(fs.readdirSync(h.dir).some((name) => name.startsWith('.merge-'))).toBe(false);
    expect(h.fingerprint()).toEqual(before);
  });
});

describe('上次中断留下的工作目录（旧 check-merge.cjs 的 cleanupMergeTemps 断言）', () => {
  it('清掉自己建的 .merge-XXXXXX，保留不认识的目录与普通文件', async () => {
    const dir = tempDir();
    const orphan = path.join(dir, '.merge-Ts1234');
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, '0.mp4'), 'x');
    const protectedDir = path.join(dir, '.merge-Keep12');
    fs.mkdirSync(protectedDir);
    fs.writeFileSync(path.join(protectedDir, 'notes.txt'), 'keep');
    const wrongName = path.join(dir, '.merge-short');
    fs.mkdirSync(wrongName);
    const userFile = path.join(dir, 'out.mp4');
    fs.writeFileSync(userFile, 'user file');

    await cleanupMergeTemps([dir, path.join(dir, 'not-created')]);

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(protectedDir)).toBe(true);
    expect(fs.existsSync(wrongName)).toBe(true);
    expect(fs.readFileSync(userFile).toString()).toBe('user file');
  });
});

/**
 * 黑帧回归（旧 check-merge.cjs 的逐帧尺寸验收）。
 *
 * 动态分辨率的 H.264 直复制必须打 `avc3` 标签，否则播放器只在第一个 SPS 内解码，
 * 分辨率一变就是黑屏/花屏——这正是 4.5 那条检查要守的回归。它需要真实 ffmpeg：
 * 本机没有 ffmpeg 时整块跳过（与 `merge.test.ts` 的真实媒体块同一策略）。
 */
function detectRealTools(): { ffmpeg: string; ffprobe: string; supportsHttp: boolean } | null {
  const names =
    process.platform === 'win32'
      ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }
      : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const candidates = [
    path.resolve(process.cwd(), 'build', 'ffmpeg', `${process.platform}-${process.arch}`),
    path.resolve(process.cwd(), 'build', 'ffmpeg'),
    ...String(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean),
  ];
  for (const dir of candidates) {
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

describe.skipIf(!realTools)('真实 FFmpeg 的黑帧回归（需要本机 ffmpeg/ffprobe）', () => {
  it('动态分辨率直复制：标记 avc3、时长等于各集之和、全片可解码且每集尺寸都出现', async () => {
    const { execFileSync } = await import('node:child_process');
    const ffmpegBin = (realTools as { ffmpeg: string }).ffmpeg;
    const ffprobeBin = (realTools as { ffprobe: string }).ffprobe;
    const dir = tempDir();
    const sizes: Array<[number, number]> = [
      [640, 360],
      [480, 270],
      [320, 180],
    ];
    const clips = sizes.map(([width, height], index) => {
      const file = path.join(dir, `clip${index + 1}.mp4`);
      execFileSync(
        ffmpegBin,
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          `color=c=${['red', 'green', 'blue'][index]}:s=${width}x${height}:r=24:d=1`,
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=48000:cl=stereo',
          '-t',
          '1',
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

    // 计划层先确认走的是「直复制 + avc3」这条路，否则这条回归测不到黑帧
    const infos = await Promise.all(
      clips.map(async (file) => (await probeMedia({ tools: realTools!, file })) as MergeInfo),
    );
    const plan = buildMergePlan(infos);
    expect(plan.videoMode).toBe('copy');
    expect(plan.videoTag).toBe('avc3');

    const before = clips.map((file) => {
      const info = fs.statSync(file);
      return [info.size, info.mtimeMs];
    });
    const output = path.join(dir, 'merged.mp4');
    const result = await mergeSeries({
      task: task(),
      episodes: clips.map((file, index) => ({ path: file, vid_index: index + 1 })),
      outDir: dir,
      outputPath: output,
      tools: realTools!,
    });
    expect(result.count).toBe(3);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('.merge-'))).toBe(false);

    const info = await probeMedia({ tools: realTools!, file: output });
    expect(info?.duration).toBeGreaterThan(2.6);
    expect(info?.duration).toBeLessThan(3.4);

    // 全片静默解码：坏帧（黑帧/花屏）会让解码报错
    const decoded = execFileSync(
      ffmpegBin,
      ['-v', 'error', '-xerror', '-nostdin', '-i', output, '-f', 'null', '-'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        encoding: 'utf8',
      },
    );
    expect(String(decoded).trim()).toBe('');

    // 逐帧尺寸：每个分集的画面尺寸都必须出现，且不存在第三种尺寸（SPS 被错用就会对不上）
    const frames = JSON.parse(
      execFileSync(
        ffprobeBin,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_frames',
          '-show_entries',
          'frame=width,height',
          '-of',
          'json',
          output,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, encoding: 'utf8' },
      ),
    ).frames as Array<{ width: number; height: number }>;
    const seen = new Map<string, number>();
    for (const frame of frames) {
      const key = `${Number(frame.width)}x${Number(frame.height)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(['320x180', '480x270', '640x360']);
    for (const [width, height] of sizes) {
      expect(seen.get(`${width}x${height}`) ?? 0).toBeGreaterThanOrEqual(15);
    }

    // 源文件必须原样保留（合并是只读的）
    expect(
      clips.map((file) => {
        const stat = fs.statSync(file);
        return [stat.size, stat.mtimeMs];
      }),
    ).toEqual(before);
  });
});
