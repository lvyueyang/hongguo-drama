// SPDX-License-Identifier: MIT
/**
 * 清晰度策略：SDK 只做「归一 + 判定」，规则本体在 @hongguo/shared。
 *
 * 4.5 里这条判断（短边 >= 目标像素、auto 不设下限）散落在 `main.js` 的
 * `verifyDownloadQuality` 与 App 取源排序里，两处各写一份；迁到 SDK 后
 * 下载校验、取源排序、门面共用同一个实现，避免「校验按 1080 判、取源按 720 选」。
 */
import {
  type DownloadQuality,
  meetsQuality,
  normalizeDownloadQuality as normalizeQuality,
  type VariantLike,
} from '@hongguo/shared';

export type { DownloadQuality, VariantLike };

/** 非法值一律归一为 auto（永不因为设置里存了个脏值就拒绝下载）。 */
export function normalizeDownloadQuality(value: unknown): DownloadQuality {
  return normalizeQuality(value);
}

/** 变体是否满足目标清晰度；auto 恒为 true（auto = 要片源能给的最好的）。 */
export function meetsDownloadQuality(variant: VariantLike, quality: unknown): boolean {
  return meetsQuality(variant, normalizeQuality(quality));
}

/** 目标清晰度的像素下限，用于提示文案（1080P / 720P）。 */
export function qualityPixels(quality: unknown): number {
  return normalizeQuality(quality) === '1080p' ? 1080 : normalizeQuality(quality) === '720p' ? 720 : 0;
}
