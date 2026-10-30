// SPDX-License-Identifier: MIT
/**
 * 合并计划：比较**解码器配置**而不是每个文件的统计值（码率、时长必然不同）。
 *
 * 迁移自 4.5 `src/native/merge-plan.js`，算法未改，只补类型。判定链：
 * 1. 编码一致 → 直接复制流；编码不一致 → 统一重编码；
 * 2. 容器：HEVC 直复制且解码器配置不同 → 需要 mpegts 承载，否则 mp4；
 * 3. 音轨：缺轨/配置不同/兼容模式要求 AAC → 重编码，否则复制；
 * 4. 时间基不同 → 必须重封装。
 */

const VIDEO_FIELDS = [
  'codec_name',
  'codec_tag_string',
  'profile',
  'level',
  'width',
  'height',
  'pix_fmt',
  'sample_aspect_ratio',
  'r_frame_rate',
  'extradata_hash',
  'color_range',
  'color_space',
  'color_transfer',
  'color_primaries',
  'field_order',
];
const AUDIO_FIELDS = ['codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'extradata_hash'];

export interface MergeInfo {
  codec: string;
  w: number;
  h: number;
  audio: boolean;
  duration: number;
  video: Record<string, any>;
  audioStream: Record<string, any> | null;
  videoSignature: string;
  audioSignature: string;
  signature: string;
  videoBitrate: number;
}

export type VideoMode = 'copy' | 'encode';
export type AudioMode = 'none' | 'copy' | 'encode';

export interface MergePlan {
  videoMode: VideoMode;
  videoContainer: 'mp4' | 'mpegts';
  videoTag: string | null;
  audioMode: AudioMode;
  remux: boolean;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  totalDuration: number;
  estimatedBytes: number;
}

function signature(stream: Record<string, any> | null | undefined, fields: string[]): string {
  return stream ? JSON.stringify(fields.map((key) => stream[key] ?? null)) : '';
}

/** ffprobe 的 JSON → 合并需要的结构；没有视频轨（或格式不认识）返回 null。 */
export function readMergeInfo(data: any): MergeInfo | null {
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) return null;
  const audio = streams.find((stream) => stream?.codec_type === 'audio') ?? null;
  const duration = Number(data?.format?.duration) || 0;
  const size = Number(data?.format?.size) || 0;
  const formatBitrate = Number(data?.format?.bit_rate) || (duration > 0 ? (size * 8) / duration : 0);
  const videoSignature = signature(video, VIDEO_FIELDS);
  const audioSignature = signature(audio, AUDIO_FIELDS);
  return {
    codec: String(video.codec_name ?? ''),
    w: Number(video.width) || 0,
    h: Number(video.height) || 0,
    audio: Boolean(audio),
    duration,
    video,
    audioStream: audio,
    videoSignature,
    audioSignature,
    signature: JSON.stringify([videoSignature, video.time_base, audioSignature, audio?.time_base]),
    videoBitrate:
      Number(video.bit_rate) || Math.max(0, formatBitrate - (Number(audio?.bit_rate) || (audio ? 96000 : 0))),
  };
}

export function buildMergePlan(infos: MergeInfo[], options: { compatible?: boolean } = {}): MergePlan {
  if (!Array.isArray(infos) || !infos.length) throw new Error('分集缺少有效时长或画面尺寸');
  if (infos.some((info) => !info || !(info.duration > 0) || !(info.w > 0) || !(info.h > 0)))
    throw new Error('分集缺少有效时长或画面尺寸');
  const first = infos[0]!;
  const totalDuration = infos.reduce((sum, info) => sum + info.duration, 0);
  const sameCodec =
    ['h264', 'hevc'].includes(first.codec) && infos.every((info) => info.codec === first.codec);
  const videoMode: VideoMode =
    sameCodec && !(options.compatible && first.codec !== 'h264') ? 'copy' : 'encode';
  const videoContainer: 'mp4' | 'mpegts' =
    videoMode === 'copy' &&
    first.codec === 'hevc' &&
    infos.some((info) => info.videoSignature !== first.videoSignature)
      ? 'mpegts'
      : 'mp4';
  const dynamicVideo = infos.some((info) => info.videoSignature !== first.videoSignature);
  const videoTag =
    videoContainer === 'mpegts'
      ? 'hev1'
      : videoMode === 'encode'
        ? dynamicVideo
          ? 'avc3'
          : null
        : first.codec === 'h264' && dynamicVideo
          ? 'avc3'
          : null;
  const hasAudio = infos.some((info) => info.audio);
  const audioMode: AudioMode = !hasAudio
    ? 'none'
    : videoMode === 'encode' ||
        infos.some(
          (info) =>
            !info.audio || !info.audioStream?.extradata_hash || info.audioSignature !== first.audioSignature,
        ) ||
        (options.compatible && first.audioStream?.codec_name !== 'aac')
      ? 'encode'
      : 'copy';
  const remux = infos.some(
    (info) =>
      info.video?.time_base !== first.video?.time_base ||
      info.audioStream?.time_base !== first.audioStream?.time_base,
  );
  const [num, den = 1] = String(first.video?.r_frame_rate || '30/1')
    .split('/')
    .map(Number);
  const fps = Math.min(60, Math.max(1, (num as number) / (den as number) || 30));
  // 一个码率跑完整个合并，避免逐场景切换让编码器头不一致；后续要按画面复杂度调，等有实测需求再说。
  const sourceRate =
    infos.reduce(
      (sum, info) =>
        sum +
        (info.videoBitrate || info.w * info.h * fps * 0.04) *
          (info.codec === 'hevc' ? 1.8 : 1.25) *
          info.duration,
      0,
    ) / totalDuration;
  const videoBitrate = Math.round(Math.min(20_000_000, Math.max(300_000, sourceRate)) / 1000) * 1000;
  const audioBitrate = hasAudio ? 96_000 : 0;
  return {
    videoMode,
    videoContainer,
    videoTag,
    audioMode,
    remux,
    fps,
    videoBitrate,
    audioBitrate,
    totalDuration,
    estimatedBytes: (totalDuration * (videoBitrate + audioBitrate)) / 8,
  };
}

export interface MinimumQualityIssue {
  index: number;
  quality: number;
  w: number;
  h: number;
}

export interface MinimumQualityResult {
  ok: boolean;
  /** 不达标时的中文说明（可以直接展示给用户） */
  reason: string;
  issues: MinimumQualityIssue[];
}

/**
 * 「合集必须都是 1080P」这道门（4.5 `merge-series` 的 `require1080`）。
 *
 * 为什么单独判：直复制合并是无损的，把一集 720P 混进去以后，用户拿到的是一个
 * 标称 1080P、实际某几集模糊的合集，事后没法分辨是哪几集。
 */
export function checkMinimumQuality(
  infos: Array<MergeInfo | null | undefined>,
  options: { vidIndexes?: number[]; minimum?: number } = {},
): MinimumQualityResult {
  const minimum = Number(options.minimum) > 0 ? Number(options.minimum) : 1080;
  const issues: MinimumQualityIssue[] = [];
  for (const [position, info] of infos.entries()) {
    const index = Number(options.vidIndexes?.[position]) || position + 1;
    const w = Number(info?.w) || 0;
    const h = Number(info?.h) || 0;
    if (!w || !h) {
      return {
        ok: false,
        reason: `第 ${index} 集视频信息读取失败，无法确认是否达到 ${minimum}P；请选择快速合并或兼容合并。`,
        issues: [{ index, quality: 0, w, h }],
      };
    }
    const quality = Math.min(w, h);
    if (quality < minimum) issues.push({ index, quality, w, h });
  }
  if (!issues.length) return { ok: true, reason: '', issues };
  const shown = issues
    .slice(0, 3)
    .map((item) => `第 ${item.index} 集实际为 ${item.quality}P（${item.w}×${item.h}）`)
    .join('、');
  const tail =
    issues.length > 3
      ? `…共 ${issues.length} 集未达到 ${minimum}P`
      : `；共 ${issues.length} 集未达到 ${minimum}P`;
  return { ok: false, reason: `${shown}${tail}；请选择快速合并或兼容合并。`, issues };
}

/** 只有 videotoolbox 需要（且只能）吃硬件帧：其它编码器走普通帧更稳。 */
export function canUseHardwareFrames(infos: MergeInfo[], encoder: string | null): boolean {
  return (
    encoder === 'h264_videotoolbox' &&
    infos.every(
      (info) =>
        ['h264', 'hevc'].includes(info.codec) &&
        info.video?.pix_fmt === 'yuv420p' &&
        (!info.video?.sample_aspect_ratio || info.video.sample_aspect_ratio === '1:1'),
    )
  );
}
