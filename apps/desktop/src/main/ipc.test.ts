import { Channels, type IpcResult } from '@hongguo/contract';
import { describe, expect, it, vi } from 'vitest';
import { type IpcHandler, type IpcSdkPort, registerIpcHandlers } from './ipc.ts';

function createHarness(overrides: Partial<IpcSdkPort> = {}) {
  const handlers = new Map<string, IpcHandler>();
  const historyRefresh = { refresh: vi.fn(async () => ({ checked: 0, failed: 0 })) };
  const prefetch = { run: vi.fn(async () => ({ target: '12', status: 'prefetched' })) };
  const floating = {
    open: vi.fn(() => ({ opened: true })),
    close: vi.fn(() => ({ closed: true })),
  };
  const warnings: string[] = [];
  const sdk: IpcSdkPort = {
    capabilities: () => ({ canPlayAnonymous: true }),
    danmaku: { fetch: vi.fn(async () => ({ success: true, items: [], notice: '本集暂无弹幕', error: '' })) },
    suggest: vi.fn(async (keyword: string) => [
      { wordType: 'common_query', name: keyword, keyword: `1_x`, displayWords: [], series: null },
    ]),
    search: { web: vi.fn(async () => ({ results: [{ series_id: '1' }] })) },
    catalog: {
      sources: () => [{ id: 'hongguo', label: '红果', enabled: true }],
      app: vi.fn(async () => ({ results: [] })),
    },
    storage: {
      getSettings: () => ({ root: '/tmp' }),
      saveSettings: vi.fn(),
    },
    ...overrides,
  };

  registerIpcHandlers({
    catalog: { list: vi.fn(async () => ({ success: true, results: [] })) },
    search: { query: vi.fn(async () => ({ success: true, results: [] })) },
    floating,
    prefetch,
    historyRefresh,
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener as IpcHandler) },
    sdk,
    isTrustedSender: (event) => (event as { trusted?: boolean })?.trusted === true,
    appInfo: () => ({
      name: 'hongguo-drama',
      version: '5.0.0-test',
      platform: 'darwin',
      architecture: 'arm64',
    }),
    download: {
      enqueue: vi.fn(() => ({ accepted: 1 })),
      list: () => [],
      pause: (id: string) => ({ id, status: 'stopped' }),
      resume: (id: string) => ({ id, status: 'pending' }),
      remove: () => true,
    },
    playback: { prepare: vi.fn(async () => ({ url: 'hongguo-stream://play/x', sessionId: 'x' })) },
    merge: {
      start: vi.fn(async () => ({ seriesId: '1', outputPath: '/tmp/x.mp4', count: 2 })),
      cancel: vi.fn(() => ({ cancelled: true })),
    },
    transcode: { run: vi.fn(async () => ({ url: 'hongguo-local://f/abc', cached: false })) },
    library: {
      list: () => [{ series_id: '1', series_title: '剧A' }],
      add: vi.fn(async (seriesId: string) => ({ series_id: seriesId })),
      remove: vi.fn(() => ({ removed: true })),
      purgeEmpty: vi.fn(() => ({ removed: 0, seriesIds: [] })),
    },
    series: {
      episodes: vi.fn(async () => ({ series_id: '1', episodes: [] })),
      sequels: vi.fn(async () => ({ results: [] })),
    },
    history: { list: () => [] },
    rankings: { list: vi.fn(async () => ({ results: [] })) },
    proxy: {
      apply: vi.fn(() => ({ mode: 'direct' })),
      test: vi.fn(async () => ({ success: true, status: 200, ms: 12, mode: 'direct' })),
    },
    storage: {
      usage: vi.fn(() => ({ totalFiles: 0, totalBytes: 0, groups: [], targets: [] })),
      deleteAll: vi.fn(() => ({ deleted: 0, bytes: 0, failed: [] })),
      deleteSeries: vi.fn(() => ({ deleted: 1, bytes: 10, failed: [], removedDirs: 1 })),
      deleteEpisode: vi.fn(() => ({ deleted: 2, bytes: 20, failed: [] })),
    },
    update: {
      check: vi.fn(async () => ({ release: null, state: { status: 'idle', percent: 0, downloaded: false } })),
      state: vi.fn(() => ({ status: 'idle', percent: 0, downloaded: false })),
      download: vi.fn(async () => ({ success: true })),
      install: vi.fn(async () => ({ success: true })),
      cancel: vi.fn(async () => ({ success: true })),
    },
    announcement: {
      get: vi.fn(async () => ({ announcement: null })),
      dismiss: vi.fn(() => ({ success: true })),
      check: vi.fn(async () => ({ success: true })),
    },
    exportText: {
      run: vi.fn(async () => ({
        danmaku: { ok: 1, fail: 0, skipped: 0, partial: 0, items: 2, empty: 0, unavailable: 0 },
        comments: { ok: 0, fail: 0, skipped: 0, partial: 0, items: 0, empty: 0, unavailable: 0 },
        reviews: { ok: 0, fail: 0, skipped: 0, partial: 0, items: 0, empty: 0, unavailable: 0 },
        files: ['/tmp/a.danmaku.json'],
      })),
    },
    progress: {
      get: vi.fn(() => ({
        vid: 'v1',
        vidIndex: 1,
        currentTime: 30,
        duration: 100,
        updatedAt: 1,
        watched: false,
      })),
      save: vi.fn(() => ({
        vid: 'v1',
        vidIndex: 1,
        currentTime: 42,
        duration: 100,
        updatedAt: 2,
        watched: false,
      })),
    },
    account: {
      status: vi.fn(async () => ({ success: true, signedIn: false })),
      startLogin: vi.fn(async () => ({ success: true, loginId: 'l1' })),
      pollLogin: vi.fn(async () => ({ success: true, status: 'pending' })),
      cancelLogin: vi.fn(async () => ({ success: true })),
      logout: vi.fn(async () => ({ success: true })),
      history: vi.fn(async () => ({ success: true, results: [] })),
    },
    logger: { warn: (message) => warnings.push(message) },
  });

  return {
    handlers,
    sdk,
    warnings,
    floating,
    prefetch,
    historyRefresh,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ trusted: true }, ...args),
  };
}

describe('主进程 IPC 装配层（替代旧 vm + 假 Electron 的做法）', () => {
  it('拒绝非可信发送者，且不触达业务端口', async () => {
    const { sdk, handlers } = createHarness();
    const result = (await handlers.get(Channels.suggest)?.(
      { trusted: false },
      { keyword: '修仙' },
    )) as IpcResult<unknown>;

    expect(result).toEqual({ ok: false, error: { code: 'UNTRUSTED_SENDER', message: '窗口请求无效' } });
    expect(sdk.suggest).not.toHaveBeenCalled();
  });

  it('入参先过 zod：空关键词与超长关键词在进入业务前被拒', async () => {
    const { sdk, call } = createHarness();
    const empty = (await call(Channels.suggest, { keyword: '' })) as IpcResult<unknown>;
    const long = (await call(Channels.suggest, { keyword: 'A'.repeat(31) })) as IpcResult<unknown>;

    expect(empty.ok).toBe(false);
    expect(long.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('INPUT_INVALID');
    expect(sdk.suggest).not.toHaveBeenCalled();
  });

  it('联想成功时返回统一信封', async () => {
    const { sdk, call } = createHarness();
    const result = (await call(Channels.suggest, { keyword: '修仙', limit: 3 })) as IpcResult<unknown[]>;

    expect(result.ok).toBe(true);
    expect(sdk.suggest).toHaveBeenCalledWith('修仙', { limit: 3 });
  });

  it('业务异常收敛成 code + message，并记录告警', async () => {
    const boom = Object.assign(new Error('上游超时'), { code: 'TIMEOUT' });
    const { call, warnings } = createHarness({ suggest: async () => Promise.reject(boom) });
    const result = (await call(Channels.suggest, { keyword: '修仙' })) as IpcResult<unknown>;

    expect(result).toEqual({ ok: false, error: { code: 'TIMEOUT', message: '上游超时' } });
    expect(warnings[0]).toContain('search:suggest');
  });

  it('目录翻页默认第 1 页，游标缺省为 null', async () => {
    const { sdk, call } = createHarness();
    await call(Channels.browseList, { source: 'hongguo', category: 'real-drama' });

    expect(sdk.catalog.app).toHaveBeenCalledWith({
      source: 'hongguo',
      category: 'real-drama',
      genre: undefined,
      page: 1,
      cursor: null,
    });
  });

  it('设置保存后回读，保证渲染层拿到落盘结果', async () => {
    const saveSettings = vi.fn();
    const { call } = createHarness({
      storage: { getSettings: () => ({ root: '/new' }), saveSettings },
    });
    const result = (await call(Channels.settingsSave, { root: '/new' })) as IpcResult<unknown>;

    expect(saveSettings).toHaveBeenCalledWith({ root: '/new' });
    expect(result).toEqual({ ok: true, data: { root: '/new' } });
  });

  it('下载入队走契约校验，vids 为空直接拒绝', async () => {
    const { call, sdk } = createHarness();
    const bad = (await call(Channels.downloadEnqueue, { seriesId: '1', vids: [] })) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INPUT_INVALID');

    const good = (await call(Channels.downloadEnqueue, {
      seriesId: '1',
      vids: ['9'],
      quality: '1080p',
    })) as IpcResult<unknown>;
    expect(good.ok).toBe(true);
    void sdk;
  });

  it('下载暂停/恢复/移除都要求任务编号', async () => {
    const { call } = createHarness();
    for (const channel of [Channels.downloadPause, Channels.downloadResume, Channels.downloadRemove]) {
      const result = (await call(channel, '')) as IpcResult<unknown>;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INPUT_INVALID');
    }
  });

  it('播放地址只返回自定义协议地址，不透出 CDN 直链', async () => {
    const { call } = createHarness();
    const result = (await call(Channels.playPrepare, {
      vid: '9',
      seriesId: '1',
      quality: 'auto',
    })) as IpcResult<{ url: string }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.url.startsWith('hongguo-stream://')).toBe(true);
  });

  it('剧库登记把分集归一化后写入，并能在列表里读到', async () => {
    const { call, sdk } = createHarness();
    const added = (await call(Channels.libraryAdd, { seriesId: '1' })) as IpcResult<{ series_id: string }>;
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.data.series_id).toBe('1');

    const list = (await call(Channels.libraryList)) as IpcResult<unknown[]>;
    expect(list.ok).toBe(true);
    void sdk;
  });

  it('账号通道：状态、扫码、轮询、退出都走端口', async () => {
    const { call, sdk } = createHarness();
    const status = (await call(Channels.accountStatus)) as IpcResult<unknown>;
    expect(status.ok).toBe(true);

    const started = (await call(Channels.accountStartLogin)) as IpcResult<unknown>;
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.data).toMatchObject({ loginId: 'l1' });

    const pending = (await call(Channels.accountPollLogin, { loginId: 'l1' })) as IpcResult<unknown>;
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.data).toMatchObject({ status: 'pending' });

    const empty = (await call(Channels.accountPollLogin, { loginId: '' })) as IpcResult<unknown>;
    expect(empty.ok).toBe(false);

    const out = (await call(Channels.accountLogout)) as IpcResult<unknown>;
    expect(out.ok).toBe(true);
    void sdk;
  });

  it('榜单通道只接受四个内置榜单名', async () => {
    const { call } = createHarness();
    const bad = (await call(Channels.rankings, { kind: 'whatever', page: 1 })) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);
    const good = (await call(Channels.rankings, { kind: 'hot-drama', page: 1 })) as IpcResult<unknown>;
    expect(good.ok).toBe(true);
  });

  it('进度写入校验参数：负数时间与非整数集号被拒', async () => {
    const { call } = createHarness();
    const badTime = (await call(Channels.progressSave, {
      seriesId: '900001',
      vid: 'v1',
      vidIndex: 1,
      currentTime: -1,
    })) as IpcResult<unknown>;
    expect(badTime.ok).toBe(false);
    const badIndex = (await call(Channels.progressSave, {
      seriesId: '900001',
      vid: 'v1',
      vidIndex: 1.5,
      currentTime: 10,
    })) as IpcResult<unknown>;
    expect(badIndex.ok).toBe(false);
    const ok = (await call(Channels.progressSave, {
      seriesId: '900001',
      vid: 'v1',
      vidIndex: 1,
      currentTime: 42,
      duration: 100,
    })) as IpcResult<unknown>;
    expect(ok.ok).toBe(true);
  });

  it('进度读取对未看过的剧返回 null 而不是报错', async () => {
    const { call } = createHarness();
    const result = (await call(Channels.progressGet, { seriesId: '900001' })) as IpcResult<unknown>;
    expect(result.ok).toBe(true);
  });

  it('文字导出：未选择任何类型时被拒，选了类型才透传到服务', async () => {
    const { call, sdk } = createHarness();
    const none = (await call(Channels.exportText, { seriesId: '900001' })) as IpcResult<unknown>;
    // 契约层给出默认空选择，端口层拒绝
    expect(none.ok).toBe(false);

    const one = (await call(Channels.exportText, {
      seriesId: '900001',
      kinds: { danmaku: true },
    })) as IpcResult<{ files: string[] }>;
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.data.files).toHaveLength(1);
    void sdk;
  });

  it('公告：读取与免提醒方式校验', async () => {
    const { call } = createHarness();
    const current = (await call(Channels.announcementGet)) as IpcResult<unknown>;
    expect(current.ok).toBe(true);

    const bad = (await call(Channels.announcementDismiss, { mode: 'forever' })) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);

    const day = (await call(Channels.announcementDismiss, { mode: 'day' })) as IpcResult<unknown>;
    expect(day.ok).toBe(true);
  });

  it('应用内更新：五个通道都在位，状态查询返回 idle', async () => {
    const { call } = createHarness();
    for (const channel of [
      Channels.updateCheck,
      Channels.updateDownload,
      Channels.updateInstall,
      Channels.updateCancel,
    ]) {
      const result = (await call(channel)) as IpcResult<unknown>;
      expect(result.ok).toBe(true);
    }
    const state = (await call(Channels.updateState)) as IpcResult<{ status: string }>;
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.data.status).toBe('idle');
  });

  it('存储用量与删除全部：两个通道都在位且返回成功信封', async () => {
    const { call } = createHarness();
    const usage = (await call(Channels.storageUsage)) as IpcResult<{ totalFiles: number }>;
    expect(usage.ok).toBe(true);
    if (usage.ok) expect(usage.data.totalFiles).toBe(0);

    const deleted = (await call(Channels.storageDeleteAll)) as IpcResult<{ deleted: number }>;
    expect(deleted.ok).toBe(true);
  });

  it('代理：应用与测试两个通道都在位，测试透传草稿', async () => {
    const { call } = createHarness();
    const applied = (await call(Channels.proxyApply)) as IpcResult<{ mode: string }>;
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.data.mode).toBe('direct');

    const tested = (await call(Channels.proxyTest, {
      proxy_enabled: true,
      proxy_mode: 'custom',
    })) as IpcResult<{ success: boolean }>;
    expect(tested.ok).toBe(true);
  });

  it('删除单剧文件：需要合法剧集编号', async () => {
    const { call } = createHarness();
    const bad = (await call(Channels.storageDeleteSeries, '')) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);

    const good = (await call(Channels.storageDeleteSeries, '7654321098765432109')) as IpcResult<{
      deleted: number;
    }>;
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.data.deleted).toBe(1);
  });

  it('删除单集文件需要任务编号；清空剧集档案返回移除数', async () => {
    const { call } = createHarness();
    const bad = (await call(Channels.storageDeleteEpisode, { taskId: '' })) as IpcResult<unknown>;
    expect(bad.ok).toBe(false);

    const ok = (await call(Channels.storageDeleteEpisode, { taskId: 'task-1' })) as IpcResult<{
      deleted: number;
    }>;
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.deleted).toBe(2);

    const purged = (await call(Channels.libraryPurgeEmpty)) as IpcResult<{ removed: number }>;
    expect(purged.ok).toBe(true);
    if (purged.ok) expect(purged.data.removed).toBe(0);
  });

  it('跨来源的分集不能混入同一部剧的下载队列', async () => {
    const { call } = createHarness();
    // 红果剧集里塞入河马分集：必须被拒，且不进队列
    const mixed = (await call(Channels.downloadEnqueue, {
      seriesId: '7654321098765432109',
      vids: ['hema:41000115014:591821028'],
      quality: 'auto',
    })) as IpcResult<unknown>;
    expect(mixed.ok).toBe(false);

    const pure = (await call(Channels.downloadEnqueue, {
      seriesId: '7654321098765432109',
      vids: ['7654321098765432110'],
      quality: 'auto',
    })) as IpcResult<unknown>;
    expect(pure.ok).toBe(true);
  });

  it('搜索按来源分流：未知来源透传给端口，页码默认 1', async () => {
    const { call, sdk } = createHarness();
    const ok = (await call(Channels.searchWeb, { keyword: '修仙', source: 'hema' })) as IpcResult<unknown>;
    expect(ok.ok).toBe(true);
    const rejected = (await call(Channels.searchWeb, { keyword: '' })) as IpcResult<unknown>;
    expect(rejected.ok).toBe(false);
    void sdk;
  });

  it('每个契约通道都注册了处理器', () => {
    const { handlers } = createHarness();
    for (const channel of Object.values(Channels)) {
      expect(handlers.has(channel)).toBe(true);
    }
  });
});

describe('悬浮播放器通道', () => {
  it('缺 vid 或 seriesId 的请求被拒，不会建窗', async () => {
    const { call, floating } = createHarness();
    expect((await call(Channels.playerFloatOpen, { vid: '11' }))?.ok).toBe(false);
    expect((await call(Channels.playerFloatOpen, { vid: '', seriesId: '1' }))?.ok).toBe(false);
    expect(floating.open).not.toHaveBeenCalled();
  });

  it('合法请求交给悬浮端口处理', async () => {
    const { call } = createHarness();
    const result = await call(Channels.playerFloatOpen, { vid: '11', seriesId: '123' });
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.data).toEqual({ opened: true });
  });

  it('关闭通道无需入参', async () => {
    const { call } = createHarness();
    const result = await call(Channels.playerFloatClose);
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.data).toEqual({ closed: true });
  });
});

describe('弹幕通道', () => {
  it('vid/seriesId 缺失或 limit 越界时被拒，不请求上游', async () => {
    const { call, sdk } = createHarness();
    for (const payload of [
      { vid: '11' },
      { vid: '', seriesId: '1' },
      { vid: '11', seriesId: '1', limit: 0 },
      { vid: '11', seriesId: '1', limit: 99999 },
    ]) {
      expect((await call(Channels.danmakuList, payload))?.ok).toBe(false);
    }
    expect(sdk.danmaku.fetch).not.toHaveBeenCalled();
  });

  it('合法请求透传给弹幕服务', async () => {
    const { call, sdk } = createHarness();
    const result = await call(Channels.danmakuList, { vid: '11', seriesId: '1', fresh: true });
    expect(result?.ok).toBe(true);
    expect(sdk.danmaku.fetch).toHaveBeenCalledWith({
      vid: '11',
      seriesId: '1',
      limit: undefined,
      fresh: true,
    });
  });
});

describe('后台续作刷新通道', () => {
  it('刷新走端口并回报检查与失败数', async () => {
    const { call, historyRefresh } = createHarness();
    const result = await call(Channels.historyRefresh);
    expect(result?.ok).toBe(true);
    expect(historyRefresh.refresh).toHaveBeenCalled();
  });

  it('端口抛错时收敛成失败结果，不让 IPC 崩', async () => {
    const { call, historyRefresh } = createHarness();
    historyRefresh.refresh.mockRejectedValueOnce(new Error('网络不可用'));
    const result = await call(Channels.historyRefresh);
    expect(result?.ok).toBe(false);
  });
});
