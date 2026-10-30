/**
 * 续集查找（迁移自 4.5 `scripts/check-series-search.cjs`）：
 * 有界搜索 + 严格的续集身份判断。核心契约是「不能把别家剧当成同一部剧的下一季」。
 */
import { describe, expect, it, vi } from 'vitest';
import { findSeriesSequels, searchSeries } from './series-search.ts';

const hit = (series_id: string, series_title: string, extra: Record<string, unknown> = {}) => ({
  series_id,
  series_title,
  source: 'hongguo',
  ...extra,
});

describe('searchSeries：有界搜索', () => {
  it('空关键词或超长关键词不发请求', async () => {
    const search = vi.fn();
    await expect(searchSeries('', search as never)).resolves.toMatchObject({ success: false });
    await expect(searchSeries('A'.repeat(201), search as never)).resolves.toMatchObject({ success: false });
    expect(search).not.toHaveBeenCalled();
  });

  it('主搜失败时把失败原样返回，不静默变空结果', async () => {
    const search = vi.fn(async () => ({ success: false, error: '搜索暂不可用', results: [] }));
    const result = await searchSeries('某剧', search as never);
    expect(result.success).toBe(false);
    expect(result.error).toBe('搜索暂不可用');
  });

  it('未带季数时以主搜为主，补搜次数有上限', async () => {
    const search = vi.fn(async () => ({ success: true, results: [hit('900001', '某剧')] }));
    const result = await searchSeries('某剧', search as never);
    expect(result.results).toHaveLength(1);
    // 主搜 + 至多两次补搜（避免把来源打爆），但不保证只搜一次
    expect(search.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('带季数时最多补搜两次（主搜 + 2，不递归展开）', async () => {
    const search = vi.fn(async () => ({ success: true, results: [hit('1', '某剧第一季')] }));
    await searchSeries('某剧第三季', search as never);
    expect(search.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('findSeriesSequels：严格的续集身份', () => {
  const entry = { series_id: '900001', series_title: '一村人养一个神第一季', episodes: [] };

  it('找不到比当前季更高的季时返回空，不硬凑', async () => {
    const search = vi.fn(async () => ({
      success: true,
      results: [hit('900001', '一村人养一个神第一季'), hit('900002', '完全不相关的剧')],
    }));
    const result = await findSeriesSequels(entry as never, [], search as never);
    expect(result.results).toHaveLength(0);
  });

  it('只接受同剧名、更高季的结果', async () => {
    const search = vi.fn(async () => ({
      success: true,
      results: [
        hit('900001', '一村人养一个神第一季'),
        hit('900002', '一村人养一个神第二季'),
        hit('900003', '一村人养一个神第三季'),
        hit('900004', '别家剧第二季'),
      ],
    }));
    const result = await findSeriesSequels(entry as never, [], search as never);
    expect(result.results.map((row: { series_id: string }) => row.series_id).sort()).toEqual([
      '900002',
      '900003',
    ]);
  });

  it('当前季自身永远不出现在结果里', async () => {
    const search = vi.fn(async () => ({
      success: true,
      results: [hit('900001', '一村人养一个神第一季'), hit('900002', '一村人养一个神第二季')],
    }));
    const result = await findSeriesSequels(entry as never, [], search as never);
    expect(result.results.map((row: { series_id: string }) => row.series_id)).toEqual(['900002']);
  });
});
