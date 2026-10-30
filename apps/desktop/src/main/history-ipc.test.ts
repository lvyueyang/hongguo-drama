/**
 * 观看记录 / 进度 / 分集档案三条通道（迁移自 4.5 `scripts/check-watch-history-integration.cjs`
 * 与 `scripts/check-calendar-playback.cjs` 里**属于装配层**的部分）。
 *
 * 旧检查靠「vm 跑 main.js + 手写假 Electron」验 `save-playback-position` /
 * `get-playback-position` / `play-series` 几个通道的入参规则与透传。5.0 的通道少了两个
 * （没有 `play-series`、没有 `remove-watch-history`），但属于装配层的规则还在，只是换了名字：
 * `progress:save` / `progress:get` / `history:list` / `series:episodes` / `series:sequels`。
 * 本文件锁住这些通道的契约与透传；端到端持久化（真 store + 真 listHistory）在
 * `packages/sdk/src/services/history/watch-history-records.test.ts`。
 *
 * 只实现被测通道用到的端口：`registerIpcHandlers` 只做注册，端口都在 handler 闭包内才被解引用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Channels, type IpcResult } from '@hongguo/contract';
import { describe, expect, it, vi } from 'vitest';
import { type IpcHandler, registerIpcHandlers } from './ipc.ts';

interface Harness {
  call(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>>;
  callAs(trusted: boolean, channel: string, ...args: unknown[]): Promise<IpcResult<unknown>>;
  history: { list: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  historyRefresh: { refresh: ReturnType<typeof vi.fn> };
  progress: { get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  series: { episodes: ReturnType<typeof vi.fn>; sequels: ReturnType<typeof vi.fn> };
}

function harness(overrides: Partial<Record<'history' | 'progress' | 'series', unknown>> = {}): Harness {
  const handlers = new Map<string, IpcHandler>();
  const history = (overrides.history ?? {
    list: vi.fn(() => []),
    remove: vi.fn(() => ({ removed: true })),
  }) as Harness['history'];
  const progress = (overrides.progress ?? {
    get: vi.fn(() => null),
    save: vi.fn(() => null),
  }) as Harness['progress'];
  const historyRefresh = { refresh: vi.fn(async () => ({ checked: 0, failed: 0 })) };
  const series = (overrides.series ?? {
    episodes: vi.fn(async () => ({ episodes: [] })),
    sequels: vi.fn(async () => ({ results: [] })),
  }) as Harness['series'];
  const deps = {
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, listener as IpcHandler),
    },
    isTrustedSender: (event: unknown) => (event as { trusted?: boolean })?.trusted === true,
    logger: { warn: vi.fn() },
    history,
    historyRefresh,
    progress,
    series,
  };
  registerIpcHandlers(deps as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const callAs = (trusted: boolean, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`未注册通道：${channel}`);
    return handler({ trusted }, ...args);
  };
  return {
    history,
    historyRefresh,
    progress,
    series,
    callAs,
    call: (channel, ...args) => callAs(true, channel, ...args),
  };
}

describe('观看记录列表通道（旧 check-watch-history-integration 的记录口径）', () => {
  it('scope 原样交给端口，缺省为 all', async () => {
    const h = harness();
    await h.call(Channels.historyList, { scope: 'unfinished' });
    await h.call(Channels.historyList, {});
    expect(h.history.list.mock.calls.map((call) => call[0])).toEqual(['unfinished', 'all']);
  });

  it('未知 scope 在契约层被拒，不触达端口', async () => {
    const h = harness();
    const result = await h.call(Channels.historyList, { scope: 'whatever' });
    expect(result.ok).toBe(false);
    expect(h.history.list).not.toHaveBeenCalled();
  });

  it('非可信发送者一律拒绝，历史/进度/分集三条都不例外', async () => {
    const h = harness();
    for (const channel of [Channels.historyList, Channels.progressGet, Channels.seriesEpisodes]) {
      const blocked = await h.callAs(false, channel, { scope: 'all', seriesId: '900001' });
      expect(blocked).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
    }
    expect(h.history.list).not.toHaveBeenCalled();
    expect(h.progress.get).not.toHaveBeenCalled();
    expect(h.series.episodes).not.toHaveBeenCalled();
  });
});

describe('进度通道（旧 save-playback-position / get-playback-position 的入参规则）', () => {
  it('集号必须是非零整数，时间与时长必须在 0 到 86400 秒之间', async () => {
    const h = harness();
    const bad = [
      { seriesId: '900001', vid: 'v1', vidIndex: 0, currentTime: 1 },
      { seriesId: '900001', vid: 'v1', vidIndex: Number.NaN, currentTime: 1 },
      { seriesId: '900001', vid: 'v1', vidIndex: 1, currentTime: Number.POSITIVE_INFINITY },
      { seriesId: '900001', vid: 'v1', vidIndex: 1, currentTime: 86_401 },
      { seriesId: '900001', vid: 'v1', vidIndex: 1, currentTime: 1, duration: 86_401 },
      { seriesId: '900001', vid: '', vidIndex: 1, currentTime: 1 },
      { seriesId: '', vid: 'v1', vidIndex: 1, currentTime: 1 },
    ];
    for (const payload of bad) {
      const result = await h.call(Channels.progressSave, payload);
      expect(result.ok).toBe(false);
    }
    expect(h.progress.save).not.toHaveBeenCalled();
  });

  it('合法进度透传给端口并回读端口的结果（续播位置以端口落盘值为准）', async () => {
    const save = vi.fn(() => ({ vid: 'v1', vidIndex: 2, currentTime: 17.5, duration: 100, watched: true }));
    const h = harness({ progress: { get: vi.fn(() => null), save } });
    const result = (await h.call(Channels.progressSave, {
      seriesId: '900001',
      vid: 'v1',
      vidIndex: 2,
      currentTime: 17.5,
      duration: 100,
    })) as IpcResult<{ currentTime: number }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.currentTime).toBe(17.5);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: '900001', vidIndex: 2, currentTime: 17.5, watched: false }),
    );
  });

  it('读取未看过的剧必须返回成功信封里的 null，而不是报错', async () => {
    const h = harness({ progress: { get: vi.fn(() => null), save: vi.fn() } });
    const result = await h.call(Channels.progressGet, { seriesId: '900001' });
    expect(result).toMatchObject({ ok: true, data: null });
  });
});

describe('分集档案/续集通道（旧 check-calendar-playback 的数据来源）', () => {
  it('分集编号必须是合法剧集编号，非法编号不触达端口', async () => {
    const h = harness();
    const result = await h.call(Channels.seriesEpisodes, '');
    expect(result.ok).toBe(false);
    expect(h.series.episodes).not.toHaveBeenCalled();
  });

  it('分集与续集都透传端口结果（日历页据此找续集、剧库页据此列分集）', async () => {
    const episodes = vi.fn(async () => ({ series_id: '900001', episodes: [{ vid: 'v1', vid_index: 1 }] }));
    const sequels = vi.fn(async () => ({ results: [{ series_id: '900002', series_title: '第二季' }] }));
    const h = harness({ series: { episodes, sequels } });
    const one = (await h.call(Channels.seriesEpisodes, '900001')) as IpcResult<{ episodes: unknown[] }>;
    const two = (await h.call(Channels.seriesSequels, '900001')) as IpcResult<{ results: unknown[] }>;
    expect(episodes).toHaveBeenCalledWith('900001');
    expect(sequels).toHaveBeenCalledWith('900001');
    expect(one.ok && one.data.episodes).toHaveLength(1);
    expect(two.ok && two.data.results).toHaveLength(1);
  });
});

/**
 * 主进程接线（源码断言）。
 *
 * 允许用字符串断言的原因只有一条：`apps/desktop/src/main/index.ts` 直接 import electron，
 * 在本机 node 测试里起不来，这几个端口（历史列表/续作刷新/进度落盘/转码/合并）
 * 的接线只能这样核对「接线存在」。断言只写「用了哪个函数」，不把实现细节锁成期望。
 */
describe('主进程接线（源码断言）', () => {
  const main = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');

  it('历史列表走 sdk.history.list，并带上「续作开关」设置', () => {
    expect(main).toContain('sdk.history.list(');
    expect(main).toContain('watch_sequels_enabled');
  });

  it('续作刷新走 refreshWatchHistory，并把更新写回播放记录', () => {
    expect(main).toContain('refreshWatchHistory({');
    expect(main).toContain('sdk.storage.savePlayback(');
  });

  it('进度保存落盘播放记录（4.5 的 save-playback-position）', () => {
    expect(main).toContain('progressPort');
    expect(main).toContain('sdk.storage.getPlayback()');
  });

  it('兼容转码产物挨着下载成品（<成品>.compat.mp4），合并走 mergeSeries 且取消只置标记', () => {
    expect(main).toContain('transcodeForCompat({');
    // 用模板字面量写，避免 biome 的 noTemplateCurlyInString（这里断言的正是这串源码）
    expect(main).toContain(`\${task.savePath}.compat.mp4`);
    expect(main).toContain('mergeSeries({');
    expect(main).toContain('mergeRuns.get(seriesId)');
  });
});

describe('历史记录：移除单条与时长透传', () => {
  it('移除观看记录只删记录，返回 removed 并刷新列表', async () => {
    const remove = vi.fn(() => ({ removed: true }));
    const { call } = harness({ history: { list: vi.fn(() => []), remove } });
    const result = (await call(Channels.historyRemove, { seriesId: 'A' })) as IpcResult<{ removed: boolean }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.removed).toBe(true);
    expect(remove).toHaveBeenCalledWith('A');
  });

  it('剧号非法时在契约层被拒，端口一次都不调', async () => {
    const remove = vi.fn(() => ({ removed: true }));
    const { call } = harness({ history: { list: vi.fn(() => []), remove } });
    for (const seriesId of ['', 'x'.repeat(100)]) {
      const result = (await call(Channels.historyRemove, { seriesId })) as IpcResult<unknown>;
      expect(result.ok).toBe(false);
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it('列表把 duration 一起交给渲染层（界面要显示秒数、筛选要用它）', async () => {
    const list = vi.fn(() => [
      { series_id: 'A', series_title: '测试剧', vid_index: 2, currentTime: 30, duration: 100 },
    ]);
    const { call } = harness({ history: { list, remove: vi.fn(() => ({ removed: false })) } });
    const result = (await call(Channels.historyList, { scope: 'unfinished' })) as IpcResult<unknown[]>;
    expect(result.ok).toBe(true);
    // 端口做了 unfinished 过滤，这里只验证透传与形状
    if (result.ok) expect(result.data).toEqual(list());
  });
});

describe('历史记录：单行重检与后台检查接线', () => {
  it('带 seriesId 时只重检那一部（端口收到该剧号）', async () => {
    const h = harness();
    const result = (await h.call(Channels.historyRefresh, { seriesId: 'A' })) as IpcResult<unknown>;
    expect(result.ok).toBe(true);
    expect(h.historyRefresh.refresh).toHaveBeenCalledWith('A');
  });

  it('不传参数即全量检查（端口收到 undefined）', async () => {
    const h = harness();
    const result = (await h.call(Channels.historyRefresh)) as IpcResult<unknown>;
    expect(result.ok).toBe(true);
    expect(h.historyRefresh.refresh).toHaveBeenCalledWith(undefined);
  });

  it('seriesId 非法（空串/超长）在契约层被拒，端口一次都不调', async () => {
    const h = harness();
    for (const seriesId of ['', 'x'.repeat(100)]) {
      const result = (await h.call(Channels.historyRefresh, { seriesId })) as IpcResult<unknown>;
      expect(result.ok).toBe(false);
    }
    expect(h.historyRefresh.refresh).not.toHaveBeenCalled();
  });
});
