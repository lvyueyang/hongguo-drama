/**
 * 红果搜索编排（迁移自 `scripts/check-app-search-ipc.cjs` 的主链路断言）。
 * 不变量：渠道顺序、游标回传、5xx 救场、上新的「查过/查到」分开、三档预算。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  hasKeywordMatch,
  isUpstreamFailure,
  mergeResults,
  NEW_RELEASE_BUDGET_MS,
  SEARCH_BUDGET_MS,
  searchSeriesWithFallback,
  WEB_BUDGET_MS,
} from './orchestrate.ts';

const cursorOf = (offset = 20) => ({ search_id: 'sid', passback: 'pb', next_offset: offset });

function harness(
  options: {
    appEnabled?: boolean;
    app?: (keyword: string, opts: { page: number; cursor: unknown; deadline: number }) => Promise<any>;
    web?: (keyword: string, opts: { page: number; deadline: number }) => Promise<any>;
    newReleases?: (keyword: string, opts: { deadline: number }) => Promise<any>;
  } = {},
) {
  const calls = { app: [] as any[], web: [] as any[], fresh: [] as any[] };
  const deps = {
    isAppEnabled: () => options.appEnabled !== false,
    app: vi.fn(async (keyword: string, opts: any) => {
      calls.app.push({ keyword, ...opts });
      if (!options.app) throw Object.assign(new Error('没有配置 App 搜索'), { code: 'APP_EMPTY' });
      return options.app(keyword, opts);
    }),
    web: vi.fn(async (keyword: string, opts: any) => {
      calls.web.push({ keyword, ...opts });
      if (!options.web) throw new Error('没有配置官网搜索');
      return options.web(keyword, opts);
    }),
    newReleases: vi.fn(async (keyword: string, opts: any) => {
      calls.fresh.push({ keyword, ...opts });
      return options.newReleases ? options.newReleases(keyword, opts) : { results: [] };
    }),
  };
  return { deps, calls };
}

describe('searchSeriesWithFallback', () => {
  it('App 打开时先走 App，并把游标原样带回去（分页靠游标不靠页码）', async () => {
    const h = harness({
      app: async (keyword, { page, cursor }) => ({
        results: [{ series_id: '2000001', series_title: keyword }],
        cursor: cursorOf(),
        hasMore: true,
        page: Number(page),
      }),
    });
    const result = await searchSeriesWithFallback('测试剧', {}, h.deps);
    expect(result.channel).toBe('app');
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toMatchObject({ search_id: 'sid', next_offset: 20 });
    expect(h.calls.web).toHaveLength(0);

    // 第二页：把上一页的游标传回去，页码也一起传
    await searchSeriesWithFallback('测试剧', { page: 2, cursor: cursorOf(), channel: 'app' }, h.deps);
    expect(h.calls.app.at(-1)).toMatchObject({ page: 2, cursor: cursorOf() });
  });

  it('App 失败时落到官网，并带上 App 的错误原因', async () => {
    const h = harness({
      app: async () => {
        throw Object.assign(new Error('app down'), { code: 'APP_EMPTY' });
      },
      web: async () => ({ results: [{ series_id: '3000001', series_title: '官网结果' }], hasMore: true }),
    });
    const result = await searchSeriesWithFallback('测试剧', {}, h.deps);
    expect(result.channel).toBe('web');
    expect(result.results[0]?.series_title).toBe('官网结果');
    expect(result.appError).toMatch(/app down/);
    expect(result.partial).toBe(false);
  });

  it('App 开关关掉时直接走官网，一次都不碰 App', async () => {
    const h = harness({
      appEnabled: false,
      web: async () => ({ results: [{ series_id: '4000001' }], hasMore: false }),
    });
    const result = await searchSeriesWithFallback('测试剧', {}, h.deps);
    expect(result.channel).toBe('web');
    expect(h.calls.app).toHaveLength(0);
  });

  it('官网 5xx 时用 App 救场，并标记 partial 与原因', async () => {
    for (const status of [502, 503]) {
      const h = harness({
        appEnabled: false,
        web: async () => {
          throw Object.assign(new Error(`搜索服务暂不可用（HTTP ${status}）`), { status });
        },
        app: async (keyword, { page, cursor }) => ({
          results: [{ series_id: '8000001', series_title: keyword }],
          cursor: cursorOf(),
          hasMore: true,
          page,
          ...(cursor ? { sawCursor: true } : {}),
        }),
      });
      const result = await searchSeriesWithFallback('接班', {}, h.deps);
      expect(result.channel, String(status)).toBe('app');
      expect(result.partial).toBe(true);
      expect(result.apiError).toMatch(String(status));
      expect(h.calls.app).toHaveLength(1);
    }
  });

  it('官网超时/格式变化不换线路（只有 5xx 与连接中断才值得救场）', async () => {
    for (const error of [
      Object.assign(new Error('取源超时'), { code: 'TIMEOUT' }),
      Object.assign(new Error('解析失败'), { kind: 'format' }),
    ]) {
      const h = harness({
        appEnabled: false,
        web: async () => {
          throw error;
        },
        app: async () => ({ results: [{ series_id: 'x' }], hasMore: false }),
      });
      await expect(searchSeriesWithFallback('测试剧', {}, h.deps)).rejects.toThrow();
      expect(h.calls.app).toHaveLength(0);
    }
  });

  it('一次空结果不会「记住」并跳过 App（换个词仍然先问 App）', async () => {
    const h = harness({
      app: async (keyword) => ({
        results: keyword === '缺席第一季' ? [] : [{ series_id: '8000002', series_title: keyword }],
        hasMore: false,
      }),
      web: async (keyword) => ({
        results: [{ series_id: '8000003', series_title: keyword }],
        hasMore: false,
      }),
    });
    await searchSeriesWithFallback('缺席第一季', {}, h.deps);
    const second = await searchSeriesWithFallback('接班第一季', {}, h.deps);
    expect(second.channel).toBe('app');
    expect(h.calls.app).toHaveLength(2);
  });

  it('主搜没命中时补一次今日上新，合并去重并区分「查过/查到」', async () => {
    const h = harness({
      appEnabled: false,
      web: async () => ({ results: [{ series_id: '6000001', series_title: '无关结果' }], hasMore: false }),
      newReleases: async () => ({
        results: [
          { series_id: '6000002', series_title: '当天新剧', new_release: true, released_today: true },
          { series_id: '6000001', series_title: '重复的不加' },
        ],
      }),
    });
    const result = await searchSeriesWithFallback('当天新剧', {}, h.deps);
    expect(h.calls.fresh).toHaveLength(1);
    expect(result.meta.newReleaseChecked).toBe(true);
    expect(result.meta.newRelease).toBe(1);
    expect(result.results.some((item: any) => item.series_id === '6000002' && item.new_release)).toBe(true);
    expect(result.results.filter((item: any) => item.series_id === '6000001')).toHaveLength(1);
  });

  it('主搜命中时仍补一次上新，但只给 3 秒余量；翻页不补搜', async () => {
    let freshDeadline = 0;
    const started = Date.now();
    const hit = harness({
      appEnabled: false,
      web: async () => ({ results: [{ series_id: '7000001', series_title: '测试剧加长版' }], hasMore: true }),
      newReleases: async (_keyword, { deadline }) => {
        freshDeadline = deadline;
        return { results: [] };
      },
    });
    const result = await searchSeriesWithFallback('测试剧', {}, hit.deps);
    expect(hit.calls.fresh).toHaveLength(1);
    expect(result.meta.newReleaseChecked).toBe(true);
    expect(freshDeadline - started).toBeLessThanOrEqual(3_100);

    const paged = harness({
      appEnabled: false,
      web: async () => ({ results: [], hasMore: true }),
    });
    await searchSeriesWithFallback('测试剧', { page: 2, channel: 'web' }, paged.deps);
    expect(paged.calls.fresh).toHaveLength(0);
  });

  it('预算：官网 ≤12.5s，上新留 ≥7s 的可请求时间，且都在总预算内', async () => {
    const started = Date.now();
    let webDeadline = 0;
    let freshDeadline = 0;
    const h = harness({
      appEnabled: false,
      web: async (_keyword, { deadline }) => {
        webDeadline = deadline;
        return { results: [], hasMore: false };
      },
      newReleases: async (_keyword, { deadline }) => {
        freshDeadline = deadline;
        return { results: [] };
      },
    });
    await searchSeriesWithFallback('当天新剧', {}, h.deps);
    expect(webDeadline - started).toBeLessThanOrEqual(WEB_BUDGET_MS + 5);
    expect(webDeadline - started).toBeGreaterThan(0);
    expect(freshDeadline - started).toBeGreaterThanOrEqual(NEW_RELEASE_BUDGET_MS - 5);
    expect(freshDeadline - started).toBeLessThanOrEqual(SEARCH_BUDGET_MS);
  });

  it('翻页钉住线路：App 线路失败时不会偷偷换到官网（游标会失效）', async () => {
    const h = harness({
      app: async () => {
        throw Object.assign(new Error('游标失效'), { code: 'APP_CURSOR' });
      },
      web: async () => ({ results: [{ series_id: 'should-not-happen' }], hasMore: false }),
    });
    await expect(searchSeriesWithFallback('测试剧', { page: 2, channel: 'app' }, h.deps)).rejects.toThrow(
      /游标失效/,
    );
    expect(h.calls.web).toHaveLength(0);
  });
});

describe('辅助判定', () => {
  it('isUpstreamFailure 只认 5xx 与服务端/连接类错误', () => {
    expect(isUpstreamFailure({ status: 503 })).toBe(true);
    expect(isUpstreamFailure({ kind: 'upstream' })).toBe(true);
    expect(isUpstreamFailure(new Error('搜索服务暂不可用（HTTP 502）'))).toBe(true);
    expect(isUpstreamFailure({ kind: 'format' })).toBe(false);
    expect(isUpstreamFailure({ code: 'TIMEOUT' })).toBe(false);
    expect(isUpstreamFailure(null)).toBe(false);
  });

  it('hasKeywordMatch 只认标题里确实有关键词的条目', () => {
    expect(hasKeywordMatch([{ series_title: '当天新剧加长版' }], '当天新剧')).toBe(true);
    expect(hasKeywordMatch([{ series_title: '无关结果' }], '当天新剧')).toBe(false);
    expect(hasKeywordMatch([], '当天新剧')).toBe(false);
    expect(hasKeywordMatch([{ series_title: 'x' }], '   ')).toBe(false);
  });

  it('mergeResults 按剧号去重，保留上新的额外字段', () => {
    const merged = mergeResults(
      [{ series_id: 'a' }, { series_id: 'b' }],
      [
        { series_id: 'b', new_release: true },
        { series_id: 'c', new_release: true },
      ],
    );
    expect(merged.results.map((item) => item.series_id)).toEqual(['a', 'b', 'c']);
    expect(merged.added).toBe(1);
    expect(merged.results[1]!.new_release).toBeUndefined();
  });
});
