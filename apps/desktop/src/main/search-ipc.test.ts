/**
 * 搜索 / 目录 IPC 入口（迁移自 4.5 `scripts/check-app-search-ipc.cjs` 与
 * `scripts/check-catalog.cjs` 的**入口层**断言）。
 *
 * 旧检查在 IPC 入口压两件事：
 *   1) 非法页码/关键词必须在叫来源之前就被拒（不能静默夹到别的页去）；
 *   2) 一次请求只允许开一个超时预算——目录已经超时了不能再开第二个 10 秒；
 * 另有一条安全边界：渲染层不能自己决定「可信 DNS 直连」，那由主进程按代理模式定。
 *
 * 说明：5.0 的搜索入口收敛为单一 `search:web`（旧的 `search-series` / `search-series-more`
 * 已不存在），分页与来源参数由契约层校验，这里压的就是这层契约与装配。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Channels, type IpcResult } from '@hongguo/contract';
import { describe, expect, it, vi } from 'vitest';
import { type IpcHandler, type IpcSdkPort, registerIpcHandlers } from './ipc.ts';

function createHarness(overrides: Partial<IpcSdkPort> = {}) {
  const handlers = new Map<string, IpcHandler>();
  const warnings: string[] = [];
  const sdk: IpcSdkPort = {
    capabilities: () => ({ canPlayAnonymous: true }),
    suggest: vi.fn(async () => []),
    search: { web: vi.fn(async () => ({ results: [] })) },
    catalog: {
      sources: () => [],
      app: vi.fn(async () => ({ results: [] })),
      saveCustomSource: vi.fn(async () => ({ success: true })),
    },
    storage: { getSettings: () => ({ root: '/tmp' }), saveSettings: vi.fn() },
    danmaku: { fetch: vi.fn(async () => ({ success: true, items: [] })) },
    ...overrides,
  };
  const catalogList = vi.fn(async (_input: Record<string, unknown>) => ({ results: [] }));
  const searchQuery = vi.fn(async (_input: Record<string, unknown>) => ({ results: [] }));
  const rankingsList = vi.fn(async () => ({ results: [] }));
  const seriesSequels = vi.fn(async () => ({ results: [] }));

  const deps: Parameters<typeof registerIpcHandlers>[0] = {
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as IpcHandler) },
    sdk,
    catalog: { list: catalogList },
    search: { query: searchQuery },
    rankings: { list: rankingsList },
    series: { episodes: vi.fn(async () => ({ episodes: [] })), sequels: seriesSequels },
    floating: { open: () => ({ opened: true }), close: () => ({ closed: true }) },
    prefetch: { run: vi.fn(async () => ({ target: '1', status: 'prefetched' })) },
    historyRefresh: { refresh: vi.fn(async () => ({ checked: 0, failed: 0 })) },
    isTrustedSender: (event) => (event as { trusted?: boolean })?.trusted === true,
    appInfo: () => ({ name: 'hongguo-drama', version: 'test', platform: 'darwin' }),
    download: {
      enqueue: vi.fn(() => ({ accepted: 0 })),
      list: () => [],
      pause: vi.fn(),
      resume: vi.fn(),
      remove: vi.fn(),
    },
    playback: {
      prepare: vi.fn(async () => ({ url: 'x', sessionId: 'x' })),
      cancel: vi.fn(() => ({ released: true })),
    },
    merge: { start: vi.fn(async () => ({})), cancel: vi.fn(() => ({})) },
    transcode: { run: vi.fn(async () => ({ url: 'x', cached: false })) },
    library: {
      list: () => [],
      add: vi.fn(async () => ({})),
      remove: vi.fn(() => ({})),
      purgeEmpty: vi.fn(() => ({})),
    },
    history: { list: () => [], remove: vi.fn(() => ({ removed: true })) },
    account: {
      status: vi.fn(async () => ({})),
      startLogin: vi.fn(async () => ({})),
      pollLogin: vi.fn(async () => ({})),
      cancelLogin: vi.fn(async () => ({})),
      logout: vi.fn(async () => ({})),
      history: vi.fn(async () => ({})),
    },
    progress: { get: vi.fn(() => ({})), save: vi.fn(() => ({})) },
    exportText: { run: vi.fn(async () => ({})) },
    announcement: {
      get: vi.fn(async () => ({})),
      dismiss: vi.fn(() => ({})),
      check: vi.fn(async () => ({})),
    },
    update: {
      check: vi.fn(async () => ({})),
      state: vi.fn(() => ({})),
      download: vi.fn(() => ({})),
      install: vi.fn(() => ({})),
      cancel: vi.fn(() => ({})),
    },
    storage: {
      usage: vi.fn(() => ({})),
      deleteAll: vi.fn(() => ({})),
      deleteSeries: vi.fn(() => ({})),
      deleteEpisode: vi.fn(() => ({})),
    },
    proxy: { apply: vi.fn(() => ({})), test: vi.fn(async () => ({})) },
    logger: { warn: (message: string) => warnings.push(message) },
  };
  registerIpcHandlers(deps);

  return {
    sdk,
    warnings,
    catalogList,
    searchQuery,
    rankingsList,
    seriesSequels,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ trusted: true }, ...args),
    callUntrusted: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({ trusted: false }, ...args),
  };
}

describe('search:web 入口', () => {
  it('非法页码与关键词在叫来源之前就被拒（不静默夹到别的页）', async () => {
    const { call, searchQuery } = createHarness();
    const bad = [
      { keyword: '测试剧', page: 0 },
      { keyword: '测试剧', page: 51 },
      { keyword: '测试剧', page: -1 },
      { keyword: '测试剧', page: 2.5 },
      { keyword: '测试剧', page: 'invalid' },
      { keyword: '测试剧', page: Number.NaN },
      { keyword: '测试剧', page: Number.POSITIVE_INFINITY },
      { keyword: '', page: 1 },
      { keyword: '红'.repeat(81), page: 1 },
    ];
    for (const input of bad) {
      const result = (await call(Channels.searchWeb, input)) as IpcResult<unknown>;
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INPUT_INVALID');
    }
    expect(searchQuery).not.toHaveBeenCalled();
  });

  it('合法页码透传，缺省为第一页', async () => {
    const { call, searchQuery } = createHarness();
    await call(Channels.searchWeb, { keyword: '测试剧' });
    await call(Channels.searchWeb, { keyword: '测试剧', page: 50 });
    // 入口把页码与来源交给 search 端口（端口再决定默认来源与总预算）
    expect(searchQuery).toHaveBeenNthCalledWith(1, { keyword: '测试剧', page: 1, source: undefined });
    expect(searchQuery).toHaveBeenNthCalledWith(2, { keyword: '测试剧', page: 50, source: undefined });
  });

  it('来源失败只发起一次请求，错误码原样回传（不重开预算）', async () => {
    const boom = Object.assign(new Error('搜索服务暂不可用（HTTP 503）'), { code: 'UPSTREAM' });
    const { call, warnings, searchQuery } = createHarness();
    searchQuery.mockRejectedValueOnce(boom);
    const result = (await call(Channels.searchWeb, { keyword: '测试剧', page: 2 })) as IpcResult<unknown>;
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: { code: 'UPSTREAM', message: '搜索服务暂不可用（HTTP 503）' },
    });
    expect(warnings[0]).toContain(Channels.searchWeb);
  });

  it('非可信发送者拿不到搜索结果', async () => {
    const { callUntrusted, searchQuery } = createHarness();
    const result = (await callUntrusted(Channels.searchWeb, { keyword: '测试剧' })) as IpcResult<unknown>;
    expect(result).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
    expect(searchQuery).not.toHaveBeenCalled();
  });
});

describe('catalog:list 入口', () => {
  it('渲染层不能自己指定 allowTrustedDns（契约层丢弃未知字段）', async () => {
    const { call, catalogList } = createHarness();
    await call(Channels.browseList, {
      source: 'hongguo',
      category: 'real-drama',
      page: 2,
      allowTrustedDns: true,
    });
    const passed = catalogList.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).not.toHaveProperty('allowTrustedDns');
    expect(passed).toMatchObject({ category: 'real-drama', page: 2, cursor: null });
  });

  it('目录失败只开一次预算：端口被调用一次，错误原样回传', async () => {
    const { call, catalogList } = createHarness();
    catalogList.mockRejectedValueOnce(new Error('目录加载超时，请重试'));
    const result = (await call(Channels.browseList, { source: 'hongguo' })) as IpcResult<unknown>;
    // 入口只调一次端口：预算在端口内部，不允许再开第二个超时窗口
    expect(catalogList).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/超时/);
  });

  it('非法页码/来源被契约拦下，端口一次都不调', async () => {
    const { call, catalogList } = createHarness();
    for (const input of [
      { source: 'hongguo', page: 0 },
      { source: 'hongguo', page: 51 },
      { source: '', page: 1 },
      { source: 'hongguo', catalogChannel: 'nope' },
    ]) {
      const result = (await call(Channels.browseList, input)) as IpcResult<unknown>;
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
    expect(catalogList).not.toHaveBeenCalled();
  });
});

describe('catalog:rankings 入口', () => {
  it('只接受四个热播榜与 1..50 页', async () => {
    const { rankingsList, call } = createHarness();
    for (const kind of ['hot-drama', 'hot-real-drama', 'hot-comic-drama', 'hot-ai-drama']) {
      const result = (await call(Channels.rankings, { kind, page: 3 })) as IpcResult<unknown>;
      expect(result.ok, kind).toBe(true);
      expect(rankingsList).toHaveBeenLastCalledWith(kind, 3);
    }
    for (const input of [
      { kind: 'comic', page: 1 },
      { kind: 'hot-drama', page: 0 },
      { kind: 'hot-drama', page: 51 },
    ]) {
      const result = (await call(Channels.rankings, input)) as IpcResult<unknown>;
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
    expect(rankingsList).toHaveBeenCalledTimes(4);
  });
});

describe('series:sequels 入口', () => {
  it('剧名编号先过契约再进端口', async () => {
    const { seriesSequels, call } = createHarness();
    const okResult = (await call(Channels.seriesSequels, '1000001')) as IpcResult<unknown>;
    expect(okResult.ok).toBe(true);
    expect(seriesSequels).toHaveBeenCalledWith('1000001');
    for (const bad of ['', 'x'.repeat(65), 123 as never, null as never]) {
      const result = (await call(Channels.seriesSequels, bad)) as IpcResult<unknown>;
      expect(result.ok, String(bad)).toBe(false);
    }
    expect(seriesSequels).toHaveBeenCalledTimes(1);
  });

  it('接线：续集端口在挂接时排除了标记 forgotten 的剧集', () => {
    // 源码断言仅用于「接线存在」：这一条属于装配层（apps/desktop/src/main/index.ts），
    // 5.0 没有可以注入宿主依赖的等价端口，只能在源码里确认过滤仍在。
    const index = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(index).toMatch(/seriesList\(\)\.filter\(\(item\) => item\.forgotten !== true\)/);
    expect(index).toMatch(/sdk\.search\.sequels\(entry, registry/);
  });
});
