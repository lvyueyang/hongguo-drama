// SPDX-License-Identifier: MIT
/**
 * 合并的「发布产物」与计划判定里**既有测试没锁住**的分支
 * （迁自 4.5 `scripts/check-merge-optimization.cjs`）。
 *
 * 已经覆盖的不重复：直复制/重编码主链、兼容模式、HEVC 换 mpegts、缺轨补静音、
 * 时间基重封装、1080P 门（`merge-plan.test.ts`）；合并过程与临时目录（`merge.test.ts`、
 * `merge-invariants.test.ts`）；工具定位与编码器探测（`tools.test.ts`）。
 *
 * 本文件补两件事：
 *   1. `publishFile` 的发布语义——硬链接可用时不复制字节、目标已存在绝不覆盖、
 *      硬链接不可用的五种错误码都退回独占复制、退回失败不留半成品、源文件不动；
 *   2. 计划里「跟着源走」的判定——H.264 参数变化仍直复制（标 avc3）、音频参数不同只重编音频、
 *      码率与帧率取源（不是固定 6 Mbps / 30 fps）。
 *
 * 4.5 同一检查里的渲染层断言（下载列表在完成事件后仍按分集自然顺序）在 5.0 由队列顺序
 * 保证，见 `apps/desktop/src/renderer/src/pages/DownloadManager.order.test.tsx`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMergePlan, readMergeInfo } from './merge-plan.ts';
import { publishFile } from './tools.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-publish-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('publishFile：产物发布', () => {
  it('硬链接可用时直接发布，不复制字节', () => {
    const dir = tempDir();
    const source = path.join(dir, 'merge.tmp');
    const target = path.join(dir, '系列合集.mp4');
    fs.writeFileSync(source, 'verified video');
    const copy = vi.spyOn(fs, 'copyFileSync');

    publishFile(source, target);

    expect(fs.readFileSync(target, 'utf8')).toBe('verified video');
    expect(copy).not.toHaveBeenCalled();
    // 硬链接：同一个 inode，发布不额外占空间
    expect(fs.statSync(target).ino).toBe(fs.statSync(source).ino);
  });

  it('目标已存在时失败，绝不覆盖用户文件（也不退回复制）', () => {
    const dir = tempDir();
    const source = path.join(dir, 'merge.tmp');
    const target = path.join(dir, '系列合集.mp4');
    fs.writeFileSync(source, 'new output');
    fs.writeFileSync(target, 'user file');
    const copy = vi.spyOn(fs, 'copyFileSync');

    expect(() => publishFile(source, target)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }) as unknown as Error,
    );
    expect(copy).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('user file');
  });

  it('五种「硬链接不可用」错误码都退回独占复制，且既有目标不被改写', () => {
    for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
      const dir = tempDir();
      const source = path.join(dir, 'merge.tmp');
      const target = path.join(dir, 'out.mp4');
      fs.writeFileSync(source, 'verified video');
      const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(`no hard link: ${code}`), { code });
      });

      publishFile(source, target);
      expect(fs.readFileSync(target, 'utf8'), code).toBe('verified video');

      // 退回路径依然不许覆盖：目标存在就失败，内容保持原样
      fs.writeFileSync(target, 'existing');
      expect(() => publishFile(source, target), code).toThrow(
        expect.objectContaining({ code: 'EEXIST' }) as unknown as Error,
      );
      expect(fs.readFileSync(target, 'utf8'), code).toBe('existing');

      link.mockRestore();
    }
  });

  it('退回复制失败时不留下半成品，源文件也不被改动', () => {
    const dir = tempDir();
    const source = path.join(dir, 'merge.tmp');
    fs.writeFileSync(source, 'verified video');
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('no hard link'), { code: 'EXDEV' });
    });

    const missingDir = path.join(dir, 'missing-directory', 'out.mp4');
    expect(() => publishFile(source, missingDir)).toThrow(
      expect.objectContaining({ code: 'ENOENT' }) as unknown as Error,
    );
    expect(fs.existsSync(missingDir)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('verified video');
  });
});

/** 与旧检查同一套 ffprobe 输出：720×1280 / H.264 High / 25fps / 650 kbps。 */
function probe(
  video: Record<string, unknown> = {},
  audio: Record<string, unknown> | null = {},
  duration = 20,
): Record<string, unknown> {
  const baseVideo = {
    codec_type: 'video',
    codec_name: 'h264',
    codec_tag_string: 'avc1',
    profile: 'High',
    level: 31,
    width: 720,
    height: 1280,
    pix_fmt: 'yuv420p',
    sample_aspect_ratio: '1:1',
    r_frame_rate: '25/1',
    time_base: '1/12800',
    extradata_hash: 'SHA256:same',
    bit_rate: '650000',
  };
  const baseAudio = {
    codec_type: 'audio',
    codec_name: 'aac',
    profile: 'LC',
    sample_rate: '48000',
    channels: 2,
    channel_layout: 'stereo',
    time_base: '1/48000',
    extradata_hash: 'SHA256:audio',
    bit_rate: '64000',
  };
  return {
    streams: [{ ...baseVideo, ...video }, ...(audio === null ? [] : [{ ...baseAudio, ...audio }])],
    format: { duration: String(duration), bit_rate: '720000', size: '1800000' },
  };
}

function info(...args: Parameters<typeof probe>) {
  const parsed = readMergeInfo(probe(...args));
  if (!parsed) throw new Error('fixture 必须含视频轨');
  return parsed;
}

describe('buildMergePlan：跟着源走', () => {
  it('已经兼容的 H.264 即使码率不同也直复制，不引入标签', () => {
    const plan = buildMergePlan([info(), info({ bit_rate: '900000' })], { compatible: true });
    expect(plan.videoMode).toBe('copy');
    expect(plan.audioMode).toBe('copy');
    expect(plan.remux).toBe(false);
    expect(plan.videoTag).toBeNull();
  });

  it('H.264 分辨率/参数集变化仍直复制，只是标成 avc3（不重编码）', () => {
    for (const mismatch of [
      { width: 1080, height: 1920 },
      { profile: 'Main', level: 40 },
      { extradata_hash: 'SHA256:different' },
      { extradata_hash: undefined },
    ]) {
      const plan = buildMergePlan([info(), info(mismatch)]);
      expect(plan.videoMode, JSON.stringify(mismatch)).toBe('copy');
      expect(plan.videoContainer, JSON.stringify(mismatch)).toBe('mp4');
      expect(plan.videoTag, JSON.stringify(mismatch)).toBe('avc3');
    }
  });

  it('码率不同本身不算不兼容：不重封装也不改标签', () => {
    const plan = buildMergePlan([info(), info({ bit_rate: '900000' })]);
    expect(plan.videoMode).toBe('copy');
    expect(plan.remux).toBe(false);
    expect(plan.videoTag).toBeNull();
  });

  it('只有音频参数不同时保留视频直复制，只重编码音频', () => {
    const plan = buildMergePlan([info(), info({}, { sample_rate: '44100', time_base: '1/44100' })]);
    expect(plan.videoMode).toBe('copy');
    expect(plan.audioMode).toBe('encode');
  });

  it('混合编码时码率与帧率取源，不套用固定 6 Mbps / 30 fps', () => {
    const plan = buildMergePlan([info(), info({ codec_name: 'hevc' })]);
    expect(plan.videoMode).toBe('encode');
    // 650 kbps 的源拍出来的预算必须仍然贴着源，而不是放大成固定高码率
    expect(plan.videoBitrate).toBeGreaterThanOrEqual(650_000);
    expect(plan.videoBitrate).toBeLessThanOrEqual(2_000_000);
    expect(plan.fps).toBe(25);
    expect(plan.totalDuration).toBe(40);
    expect(plan.estimatedBytes).toBeGreaterThan(0);
    expect(plan.estimatedBytes).toBeLessThan(15_000_000);
  });

  it('两份参数一致的 HEVC 保持 mp4 直复制，不需要 mpegts', () => {
    const plan = buildMergePlan([
      info({ codec_name: 'hevc', codec_tag_string: 'hvc1' }),
      info({ codec_name: 'hevc', codec_tag_string: 'hvc1' }),
    ]);
    expect(plan.videoMode).toBe('copy');
    expect(plan.videoContainer).toBe('mp4');
    expect(plan.videoTag).toBeNull();
  });

  it('时长缺失直接拒绝，不做「猜一个」的合并', () => {
    expect(() => buildMergePlan([info({}, {}, 0)])).toThrow(/时长|duration/);
  });
});
