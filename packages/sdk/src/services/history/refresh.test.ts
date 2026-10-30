/**
 * 观看记录后台续作刷新（迁移自 4.5 `scripts/check-watch-history-backend.cjs`）。
 *
 * 守三条：24 小时检查点内不重复查；同一来源、有限次查询；
 * 部分失败保留已找到的续作但**不推进检查点**，并留下可读原因。
 */
import { describe, expect, it, vi } from 'vitest';
import { refreshWatchHistory, SEQUEL_CHECK_INTERVAL_MS } from './refresh.ts';

const now = 10 * SEQUEL_CHECK_INTERVAL_MS;

function setup(options: {
  sid?: string;
  title?: string;
  lastSequelCheckAt?: number;
  results?: Array<{ series_id: string; series_title: string }>;
  success?: boolean;
  error?: string;
}) {
  const sid = options.sid ?? '1000002';
  const series = [
    {
      series_id: sid,
      series_title: options.title ?? '春日来信第二季',
      total: 1,
      episodes: [{ vid_index: 1 }],
    },
  ];
  const playback: Record<string, Record<string, unknown>> = {
    [sid]: {
      watched: true,
      vid_index: 1,
      currentTime: 3,
      updatedAt: 1,
      lastSequelCheckAt: options.lastSequelCheckAt ?? 1,
    },
  };
  const searchSequels = vi.fn(async () => ({
    success: options.success !== false,
    results: options.results ?? [],
    error: options.error,
  }));
  return { sid, series, playback, searchSequels };
}

describe('续作刷新：查询边界', () => {
  it('检查点内的剧不再查询，也不写记录', async () => {
    const deps = setup({ lastSequelCheckAt: now - 1000 });
    const result = await refreshWatchHistory({ ...deps, now });
    expect(result.checked).toBe(0);
    expect(deps.searchSequels).not.toHaveBeenCalled();
    expect(result.updates).toEqual({});
  });

  it('用剧名基名做关键词，一次刷新只查一次', async () => {
    const deps = setup({ results: [] });
    const result = await refreshWatchHistory({ ...deps, now });
    expect(result.checked).toBe(1);
    expect(deps.searchSequels).toHaveBeenCalledTimes(1);
    const firstCall = deps.searchSequels.mock.calls[0] as unknown as [unknown, string] | undefined;
    expect(firstCall?.[1]).toBe('春日来信');
  });

  it('只检查已看过的剧，且受 limit 限制', async () => {
    const series = [
      { series_id: '1000002', series_title: '甲第一季' },
      { series_id: '1000003', series_title: '乙第一季' },
    ];
    const playback = { '1000002': { lastSequelCheckAt: 1, updatedAt: 1 }, '1000003': { updatedAt: 1 } };
    const searchSequels = vi.fn(async () => ({ success: true, results: [] }));
    const result = await refreshWatchHistory({ series, playback, searchSequels, now, limit: 1 });
    expect(result.checked).toBe(1);
    expect(searchSequels).toHaveBeenCalledTimes(1);
    expect(result.updates['1000003']).toBeUndefined();
  });
});

describe('续作刷新：结果与检查点', () => {
  it('成功时写入更高季数的续作并推进检查点', async () => {
    const deps = setup({
      results: [{ series_id: '1000004', series_title: '春日来信第四季' }],
    });
    const result = await refreshWatchHistory({ ...deps, now });
    const record = result.updates['1000002'] as Record<string, unknown>;
    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect((record.sequels as Array<{ series_title: string }>).map((row) => row.series_title)).toEqual([
      '春日来信第四季',
    ]);
    expect(record.lastSequelCheckAt).toBe(now);
    expect(record.lastCheckError).toBe('');
  });

  it('部分失败：保留已找到的续作，但不推进检查点，并写清原因', async () => {
    const deps = setup({
      success: false,
      error: 'fixture offline',
      results: [{ series_id: '1000004', series_title: '春日来信第四季' }],
    });
    const result = await refreshWatchHistory({ ...deps, now });
    const record = result.updates['1000002'] as Record<string, unknown>;
    expect(result.failed).toBe(1);
    expect((record.sequels as Array<{ series_title: string }>).map((row) => row.series_title)).toEqual([
      '春日来信第四季',
    ]);
    expect(record.lastCheckError).toMatch(/续作检查.*未完成/);
    // 关键：失败的检查不能变成 24 小时成功检查点
    expect(record.lastSequelCheckAt).toBe(1);
  });

  it('搜索抛异常也算未完成，不会让整次刷新崩掉', async () => {
    const deps = setup({});
    const searchSequels = vi.fn(async () => {
      throw new Error('网络不可用');
    });
    const result = await refreshWatchHistory({ ...deps, searchSequels, now });
    expect(result.failed).toBe(1);
    expect((result.updates['1000002'] as Record<string, unknown>).lastCheckError).toMatch(/网络不可用/);
  });

  it('不把低季数或别的剧名当续作', async () => {
    const deps = setup({
      results: [
        { series_id: '1000001', series_title: '春日来信第一季' },
        { series_id: '1000002', series_title: '春日来信第二季' },
        { series_id: '1000009', series_title: '另一部剧第三季' },
      ],
    });
    const result = await refreshWatchHistory({ ...deps, now });
    expect((result.updates['1000002'] as Record<string, unknown>).sequels).toEqual([]);
  });

  it('重复刷新时旧续作不会被一次空结果抹掉', async () => {
    const deps = setup({ results: [] });
    deps.playback['1000002']!.sequels = [{ series_id: '1000004', series_title: '春日来信第四季' }];
    const result = await refreshWatchHistory({ ...deps, now });
    expect(
      ((result.updates['1000002'] as Record<string, unknown>).sequels as Array<{ series_title: string }>).map(
        (row) => row.series_title,
      ),
    ).toEqual(['春日来信第四季']);
  });
});
