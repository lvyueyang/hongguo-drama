/**
 * 合并计划（迁移自 4.5 `src/native/merge-plan.js`）。
 * 这条逻辑决定「能不能不重编码」，判错就是无声的画质损失或损坏文件，所以逐分支覆盖。
 */
import { describe, expect, it } from 'vitest';
import { buildMergePlan, canUseHardwareFrames, checkMinimumQuality, readMergeInfo } from './merge-plan.ts';

function probe(
  options: {
    codec?: string;
    width?: number;
    height?: number;
    duration?: number;
    audio?: boolean;
    extradata?: string;
    audioCodec?: string;
    timeBase?: string;
    pixFmt?: string;
    sar?: string;
    fps?: string;
  } = {},
): any {
  const {
    codec = 'h264',
    width = 1080,
    height = 1920,
    duration = 10,
    audio = true,
    extradata = 'v-hash',
    audioCodec = 'aac',
    timeBase = '1/90000',
    pixFmt = 'yuv420p',
    sar = '1:1',
    fps = '30/1',
  } = options;
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: codec,
        width,
        height,
        pix_fmt: pixFmt,
        sample_aspect_ratio: sar,
        r_frame_rate: fps,
        time_base: timeBase,
        extradata_hash: extradata,
        bit_rate: '2000000',
      },
      ...(audio
        ? [
            {
              codec_type: 'audio',
              codec_name: audioCodec,
              channels: 2,
              sample_rate: '48000',
              time_base: timeBase,
              extradata_hash: 'a-hash',
            },
          ]
        : []),
    ],
    format: { duration: String(duration), size: String(2_000_000), bit_rate: '2000000' },
  };
}

describe('readMergeInfo', () => {
  it('取视频/音频轨与时长，缺视频轨返回 null', () => {
    const info = readMergeInfo(probe())!;
    expect(info.codec).toBe('h264');
    expect([info.w, info.h, info.duration]).toEqual([1080, 1920, 10]);
    expect(info.audio).toBe(true);
    expect(info.audioStream?.codec_name).toBe('aac');
    expect(info.videoSignature).toContain('h264');
    expect(readMergeInfo({ streams: [{ codec_type: 'audio' }] })).toBeNull();
    expect(readMergeInfo({})).toBeNull();
    expect(readMergeInfo(null)).toBeNull();
  });

  it('签名只含解码器配置：码率/时长不同不影响签名', () => {
    const a = readMergeInfo(probe({ duration: 10 }))!;
    const b = readMergeInfo({ ...probe({ duration: 30 }), streams: probe({ duration: 30 }).streams })!;
    expect(a.videoSignature).toBe(b.videoSignature);
    expect(a.signature).toBe(b.signature);
    // 分辨率变了就是不同的解码器配置。
    const c = readMergeInfo(probe({ width: 720, height: 1280 }))!;
    expect(c.videoSignature).not.toBe(a.videoSignature);
  });
});

describe('buildMergePlan', () => {
  it('编码与时间基一致 → 直复制、音频复制、不重封装', () => {
    const infos = [readMergeInfo(probe())!, readMergeInfo(probe())!];
    const plan = buildMergePlan(infos);
    expect(plan.videoMode).toBe('copy');
    expect(plan.audioMode).toBe('copy');
    expect(plan.remux).toBe(false);
    expect(plan.videoContainer).toBe('mp4');
    expect(plan.videoTag).toBeNull();
    expect(plan.totalDuration).toBe(20);
  });

  it('编码不一致 → 统一重编码，音频也重编码', () => {
    const plan = buildMergePlan([
      readMergeInfo(probe({ codec: 'h264' }))!,
      readMergeInfo(probe({ codec: 'hevc' }))!,
    ]);
    expect(plan.videoMode).toBe('encode');
    expect(plan.audioMode).toBe('encode');
    expect(plan.videoTag).toBe('avc3');
    expect(plan.videoBitrate).toBeGreaterThanOrEqual(300_000);
    expect(plan.videoBitrate).toBeLessThanOrEqual(20_000_000);
  });

  it('HEVC 直复制但解码器配置不同 → 用 mpegts 承载', () => {
    const plan = buildMergePlan([
      readMergeInfo(probe({ codec: 'hevc', extradata: 'a' }))!,
      readMergeInfo(probe({ codec: 'hevc', extradata: 'b' }))!,
    ]);
    expect(plan.videoMode).toBe('copy');
    expect(plan.videoContainer).toBe('mpegts');
    expect(plan.videoTag).toBe('hev1');
  });

  it('兼容模式要求 H.264/AAC：HEVC 必须重编码，非 AAC 音轨也重编码', () => {
    const hevc = readMergeInfo(probe({ codec: 'hevc', audioCodec: 'mp3' }))!;
    const plan = buildMergePlan([hevc, readMergeInfo(probe({ codec: 'hevc', audioCodec: 'mp3' }))!], {
      compatible: true,
    });
    expect(plan.videoMode).toBe('encode');
    expect(plan.audioMode).toBe('encode');
    const h264Aac = buildMergePlan([readMergeInfo(probe())!, readMergeInfo(probe())!], { compatible: true });
    expect(h264Aac.videoMode).toBe('copy');
    expect(h264Aac.audioMode).toBe('copy');
  });

  it('某集缺音轨 → 音频重编码（补静音轨），没有音轨就 none', () => {
    const plan = buildMergePlan([
      readMergeInfo(probe({ audio: true }))!,
      readMergeInfo(probe({ audio: false }))!,
    ]);
    expect(plan.audioMode).toBe('encode');
    expect(plan.audioBitrate).toBe(96_000);
    const silent = buildMergePlan([
      readMergeInfo(probe({ audio: false }))!,
      readMergeInfo(probe({ audio: false }))!,
    ]);
    expect(silent.audioMode).toBe('none');
    expect(silent.audioBitrate).toBe(0);
  });

  it('时间基不同 → 必须重封装', () => {
    const plan = buildMergePlan([
      readMergeInfo(probe({ timeBase: '1/90000' }))!,
      readMergeInfo(probe({ timeBase: '1/1000' }))!,
    ]);
    expect(plan.remux).toBe(true);
  });

  it('缺时长或尺寸直接拒绝，不做「猜一个」的合并', () => {
    const ok = readMergeInfo(probe())!;
    expect(() => buildMergePlan([])).toThrow(/时长或画面尺寸/);
    expect(() => buildMergePlan([ok, { ...ok, duration: 0 }])).toThrow(/时长或画面尺寸/);
    expect(() => buildMergePlan([ok, { ...ok, w: 0 }])).toThrow(/时长或画面尺寸/);
    expect(() => buildMergePlan([null as any])).toThrow(/时长或画面尺寸/);
  });

  it('估值随总时长与码率走，用于磁盘余量判断', () => {
    const plan = buildMergePlan([readMergeInfo(probe({ duration: 60 }))!]);
    expect(plan.estimatedBytes).toBeGreaterThan(0);
    expect(plan.estimatedBytes).toBeCloseTo(
      (plan.totalDuration * (plan.videoBitrate + plan.audioBitrate)) / 8,
      0,
    );
  });
});

describe('canUseHardwareFrames', () => {
  it('只有 videotoolbox 且全部分集都是 yuv420p/方形像素才走硬件帧', () => {
    const infos = [readMergeInfo(probe({ codec: 'hevc' }))!];
    expect(canUseHardwareFrames(infos, 'h264_videotoolbox')).toBe(true);
    expect(canUseHardwareFrames(infos, 'libx264')).toBe(false);
    expect(canUseHardwareFrames(infos, null)).toBe(false);
    expect(canUseHardwareFrames([readMergeInfo(probe({ pixFmt: 'yuv444p' }))!], 'h264_videotoolbox')).toBe(
      false,
    );
    expect(canUseHardwareFrames([readMergeInfo(probe({ sar: '4:3' }))!], 'h264_videotoolbox')).toBe(false);
    expect(canUseHardwareFrames([readMergeInfo(probe({ codec: 'av1' }))!], 'h264_videotoolbox')).toBe(false);
  });
});

describe('checkMinimumQuality（4.5 的 require1080）', () => {
  const ok = readMergeInfo(probe({ width: 1080, height: 1920 }))!;
  const low = readMergeInfo(probe({ width: 720, height: 1280 }))!;

  it('全部达标才放行', () => {
    const result = checkMinimumQuality([ok, ok], { vidIndexes: [1, 2] });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('');
  });

  it('有一集不达标就拒绝，并说清是第几集、多少 P', () => {
    const result = checkMinimumQuality([ok, low], { vidIndexes: [1, 2] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('第 2 集实际为 720P');
    expect(result.reason).toContain('共 1 集未达到 1080P');
    expect(result.issues).toEqual([{ index: 2, quality: 720, w: 720, h: 1280 }]);
  });

  it('多集不达标时最多列三集，剩下用「共 N 集」概括', () => {
    const result = checkMinimumQuality([low, low, low, low], { vidIndexes: [1, 2, 3, 4] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('第 1 集');
    expect(result.reason).toContain('第 3 集');
    expect(result.reason).not.toContain('第 4 集');
    expect(result.reason).toContain('共 4 集未达到 1080P');
  });

  it('读不出视频信息也拒绝（不能「没信息就当作达标」）', () => {
    const result = checkMinimumQuality([ok, null], { vidIndexes: [1, 2] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('第 2 集视频信息读取失败');
  });

  it('阈值可调；竖屏按短边算', () => {
    expect(checkMinimumQuality([low], { minimum: 720 }).ok).toBe(true);
    expect(checkMinimumQuality([readMergeInfo(probe({ width: 1920, height: 720 }))!]).ok).toBe(false);
  });
});
