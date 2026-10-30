import { describe, expect, it } from 'vitest';
import { codecRank, meetsQuality, normalizeDownloadQuality, shortEdge } from './quality.ts';

describe('quality policy', () => {
  it('未知或缺失的清晰度回落到 auto', () => {
    expect(normalizeDownloadQuality(undefined)).toBe('auto');
    expect(normalizeDownloadQuality('4k')).toBe('auto');
    expect(normalizeDownloadQuality('1080p')).toBe('1080p');
  });

  it('短边取宽高较小值，缺宽高才退回 pixels', () => {
    expect(shortEdge({ width: 1920, height: 1080 })).toBe(1080);
    expect(shortEdge({ width: 1080, height: 1920 })).toBe(1080);
    expect(shortEdge({ pixels: 720 })).toBe(720);
    expect(shortEdge({})).toBe(0);
  });

  it('auto 一律满足，1080p 需短边达 1080', () => {
    expect(meetsQuality({ width: 640, height: 360 }, 'auto')).toBe(true);
    expect(meetsQuality({ width: 1280, height: 720 }, '1080p')).toBe(false);
    expect(meetsQuality({ width: 1920, height: 1080 }, '1080p')).toBe(true);
  });

  it('H.264 优先于 HEVC', () => {
    expect(codecRank('avc1')).toBe(0);
    expect(codecRank('bytevc1')).toBe(1);
    expect(codecRank('av1')).toBe(2);
  });
});
