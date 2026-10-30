/** 下载与播放的清晰度策略：单一实现，宿主只传 policy。 */
export type DownloadQuality = 'auto' | '1080p' | '720p';

export function normalizeDownloadQuality(value: unknown): DownloadQuality {
  return value === '1080p' || value === '720p' ? value : 'auto';
}

export function qualityToMinPixels(quality: DownloadQuality): number {
  if (quality === '1080p') return 1080;
  if (quality === '720p') return 720;
  return 0;
}

export interface VariantLike {
  width?: number;
  height?: number;
  codec?: string;
  pixels?: number;
}

/** 短边像素：只有宽高都有效时才算数，避免窄高压倒横屏。 */
export function shortEdge(variant: VariantLike): number {
  const width = Number(variant.width);
  const height = Number(variant.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    return Math.min(width, height);
  return Number(variant.pixels) || 0;
}

export function meetsQuality(variant: VariantLike, quality: DownloadQuality): boolean {
  const min = qualityToMinPixels(quality);
  return min === 0 || shortEdge(variant) >= min;
}

export function codecRank(codec: unknown): 0 | 1 | 2 {
  const value = String(codec ?? '').toLowerCase();
  if (['h264', 'avc', 'avc1'].includes(value)) return 0;
  if (['h265', 'h265_hvc1', 'hevc', 'hvc1', 'hev1', 'bytevc1'].includes(value)) return 1;
  return 2;
}
