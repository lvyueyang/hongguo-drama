/**
 * 清晰度判定（替代 4.5 散落在 main.js 里的两处判断）。
 * 不变量：短边达标才算达标、auto 恒为真、脏值一律归一为 auto。
 */
import { describe, expect, it } from 'vitest';
import { meetsDownloadQuality, normalizeDownloadQuality, qualityPixels } from './quality.ts';

describe('normalizeDownloadQuality', () => {
  it('只认 1080p/720p，其余一律 auto', () => {
    expect(normalizeDownloadQuality('1080p')).toBe('1080p');
    expect(normalizeDownloadQuality('720p')).toBe('720p');
    for (const value of [undefined, null, '', 'auto', '4k', '1080', 1080, {}, []]) {
      expect(normalizeDownloadQuality(value)).toBe('auto');
    }
  });
});

describe('meetsDownloadQuality', () => {
  it('竖屏按短边算：1080×1920 达标 1080p，720×1280 不达标', () => {
    expect(meetsDownloadQuality({ width: 1080, height: 1920 }, '1080p')).toBe(true);
    expect(meetsDownloadQuality({ width: 720, height: 1280 }, '1080p')).toBe(false);
    expect(meetsDownloadQuality({ width: 720, height: 1280 }, '720p')).toBe(true);
    expect(meetsDownloadQuality({ width: 480, height: 854 }, '720p')).toBe(false);
  });

  it('横屏同样按短边算，不会被宽度骗过去', () => {
    expect(meetsDownloadQuality({ width: 1920, height: 1080 }, '1080p')).toBe(true);
    expect(meetsDownloadQuality({ width: 1920, height: 720 }, '1080p')).toBe(false);
  });

  it('auto 不设下限，但脏值不会因此变成必须达标', () => {
    expect(meetsDownloadQuality({ width: 360, height: 640 }, 'auto')).toBe(true);
    expect(meetsDownloadQuality({ width: 360, height: 640 }, 'nonsense')).toBe(true);
  });

  it('尺寸缺失时用 pixels 兜底；都没有就按不达标处理', () => {
    expect(meetsDownloadQuality({ pixels: 1080 }, '1080p')).toBe(true);
    expect(meetsDownloadQuality({ pixels: 720 }, '1080p')).toBe(false);
    expect(meetsDownloadQuality({}, '720p')).toBe(false);
  });
});

describe('qualityPixels', () => {
  it('给出提示文案要用的像素下限', () => {
    expect(qualityPixels('1080p')).toBe(1080);
    expect(qualityPixels('720p')).toBe(720);
    expect(qualityPixels('auto')).toBe(0);
    expect(qualityPixels('4k')).toBe(0);
  });
});
