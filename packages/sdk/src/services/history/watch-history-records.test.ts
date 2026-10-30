/**
 * 观看记录的落盘与已读语义（迁移自 4.5 `scripts/check-watch-history-integration.cjs` 中
 * **有 5.0 对应实现**的部分）。
 *
 * 4.5 这条检查走「真 IPC + 真 store」，验的六件事里：
 *
 * 1. 只保存看过的条目、续播位置跨重启保留 → 5.0 由 `store.ts` + `listHistory` 承担（本文件 A/B）；
 * 2. 完成证据落盘后不回退 → 5.0 由 `recordPlayback` 承担（本文件 C）；
 * 3. 确认旧快照后，之后新发现的续作仍然未读 → 5.0 由 `acknowledge` 承担（本文件 D）；
 * 4. 慢刷新不回滚已保存的分集总数 → 5.0 由 `applyEpisodeUpdate` 承担（本文件 E）；
 * 5. 刷新只写续作与检查点，不动播放位置（本文件 F）。
 *
 * 另一半（`save-playback-position` 的主进程校验与 max 合并、通知可选且去重、
 * `play-series` 显式转发 resume、dismissed 恢复）**在 5.0 没有对应实现或没有接线**，
 * 见迁移报告；这里不写等价断言，免得把缺口锁成"期望行为"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../storage/store.ts';
import { refreshWatchHistory } from './refresh.ts';
import { acknowledge, applyEpisodeUpdate, listHistory, recordPlayback } from './watch-history.ts';

const dirs: string[] = [];
function storeFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-history-records-'));
  dirs.push(dir);
  return path.join(dir, 'store.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SID = '1000001';
const now = 1_700_000_000_000;
const series = (total = 3) => ({
  series_id: SID,
  series_title: '春日来信',
  total,
  episodes: Array.from({ length: total }, (_, index) => ({ vid: `video${index + 1}`, vid_index: index + 1 })),
});

describe('只保存看过的条目 + 续播位置跨重启保留（旧 check-watch-history-integration 第 1 条）', () => {
  it('看过的一集落盘后，重启仍读得到同一集的续播位置', () => {
    const file = storeFile();
    const store = createStore();
    store.init(file);
    store.saveSeries([series(), { ...series(), series_id: '1000003', series_title: '仅打开' }] as never);
    store.savePlayback({} as never);
    expect(listHistory(store.getSeries(), store.getPlayback(), false)).toEqual([]);

    const record = recordPlayback(undefined, series() as never, 2, 17.5, now);
    store.savePlayback({ [SID]: record } as never);

    // 模拟重启：换一个 store 实例重新读同一个文件
    const reopened = createStore();
    reopened.init(file);
    expect(reopened.getPlayback()[SID]).toMatchObject({ vid_index: 2, currentTime: 17.5, watched: true });
    const rows = listHistory(reopened.getSeries(), reopened.getPlayback(), false) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ series_id: SID, vid_index: 2, currentTime: 17.5 });
  });

  it('没看过的剧（只有档案没有进度）不会出现在记录里，也不进盘', () => {
    const file = storeFile();
    const store = createStore();
    store.init(file);
    store.saveSeries([series(), { ...series(), series_id: '1000003', series_title: '仅打开' }] as never);
    store.savePlayback({
      '1000003': { watched: false, vid_index: 1, currentTime: 0, updatedAt: now },
    } as never);
    expect(listHistory(store.getSeries(), store.getPlayback(), false)).toEqual([]);

    const reopened = createStore();
    reopened.init(file);
    expect(listHistory(reopened.getSeries(), reopened.getPlayback(), false)).toEqual([]);
  });

  it('listHistory 是纯读：不修改传入的剧表与播放记录', () => {
    const registry = [series()];
    const playback = { [SID]: recordPlayback(undefined, series() as never, 1, 3, now) };
    const snapshot = JSON.stringify({ registry, playback });
    listHistory(registry as never, playback as never, true);
    expect(JSON.stringify({ registry, playback })).toBe(snapshot);
  });
});

describe('完成证据跨持久化（旧 check-watch-history-integration 第 3 条）', () => {
  const last = (total: number) => Math.max(total, 0);

  it('末集播到结尾才算完成；完成证据写进记录并让列表显示「已看完」', () => {
    const completed = recordPlayback(undefined, series() as never, last(3), 100, now, {
      duration: 100,
      ended: true,
    });
    expect(completed.completedEpisode).toBe(3);
    const rows = listHistory([series() as never], { [SID]: completed } as never, false) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.completed).toBe(true);
  });

  it('非末集、未播到结尾、时长不可信都不算完成；之后回到第一集也不会把完成证据抹掉', () => {
    const notEnded = recordPlayback(undefined, series(4) as never, 3, 1, now, {
      duration: 100,
      ended: false,
    });
    expect(notEnded.completedEpisode).toBeUndefined();

    const middle = recordPlayback(undefined, series() as never, 2, 100, now, { duration: 100, ended: true });
    expect(middle.completedEpisode).toBeUndefined();

    const unknownDuration = recordPlayback(undefined, series() as never, 3, 100, now, { ended: true });
    expect(unknownDuration.completedEpisode).toBeUndefined();

    const finished = recordPlayback(undefined, series() as never, 3, 100, now, {
      duration: 100,
      ended: true,
    });
    const replayed = recordPlayback(finished as never, series() as never, 1, 5, now + 1_000);
    expect(replayed.completedEpisode).toBe(3);
    expect(replayed.vid_index).toBe(1);
    expect(replayed.currentTime).toBe(5);
  });

  it('分集变多（第 4 集上线）后，原来的完成标记不再算「已看完」', () => {
    const finished = recordPlayback(undefined, series() as never, 3, 100, now, {
      duration: 100,
      ended: true,
    });
    const rows = listHistory([series(4) as never], { [SID]: finished } as never, false) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.total).toBe(4);
    expect(rows[0]?.completed).toBe(false);
  });

  it('非法进度（集号非正整数、时间非有限数）直接拒绝，不写半条记录', () => {
    for (const [index, time] of [
      [0, 1],
      [1.5, 1],
      [-1, 1],
      [1, -1],
      [1, Number.POSITIVE_INFINITY],
      [1, Number.NaN],
    ] as Array<[number, number]>) {
      expect(() => recordPlayback(undefined, series() as never, index, time, now)).toThrow(/无效的播放进度/);
    }
  });
});

describe('确认旧快照不吞掉后续发现（旧 check-watch-history-integration 第 8 条）', () => {
  const laterSequel = { series_id: '1000004', series_title: '春日来信第四季' };

  function watchedSnapshot() {
    const record = {
      watched: true,
      vid_index: 1,
      currentTime: 10,
      updatedAt: now,
      knownTotal: 6,
      acknowledgedTotal: 5,
      completedEpisode: 0,
      sequels: [{ series_id: '1000002', series_title: '春日来信第二季' }, laterSequel],
      seenSequelIds: ['1000002'],
    };
    return record;
  }

  it('按旧快照确认：只把快照里出现过的剧确认掉，未出现的新发现仍然未读', () => {
    // 关键：快照是**旧**的——当时只看到第二季，第四季是这次刷新之后才发现的
    const confirmed = acknowledge(watchedSnapshot() as never, {
      total: 5,
      sequelIds: ['1000002'],
    }) as Record<string, unknown>;
    expect(confirmed.acknowledgedTotal).toBe(5);
    expect(confirmed.unreadEpisodes).toBe(1);
    expect(confirmed.seenSequelIds).toEqual(['1000002']);

    const rows = listHistory([{ ...series(6) } as never], { [SID]: confirmed } as never, true) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.hasUpdates).toBe(true);
  });

  it('不带快照时确认当前可见的全部内容，红点消失', () => {
    // 不带快照 = 确认当前已知的全部内容（第二个参数是可选快照）
    const confirmed = acknowledge(watchedSnapshot() as never, null as never) as Record<string, unknown>;
    expect(confirmed.acknowledgedTotal).toBe(6);
    expect(confirmed.unreadEpisodes).toBe(0);
    const rows = listHistory([series(6) as never], { [SID]: confirmed } as never, true) as Array<
      Record<string, unknown>
    >;
    // 快照缺省视为"已看到全部续作"，红点只由未读集数决定
    expect(rows[0]?.hasUpdates).toBe(false);
  });

  it('确认不会把已确认总数改小（重复确认旧快照是幂等的）', () => {
    const once = acknowledge(watchedSnapshot() as never, { total: 5, sequelIds: [] });
    const twice = acknowledge(once as never, { total: 5, sequelIds: [] });
    expect(twice.acknowledgedTotal).toBe(5);
    const stale = acknowledge(twice as never, { total: 2, sequelIds: [] });
    expect(stale.acknowledgedTotal).toBe(5);
  });
});

describe('慢刷新不回滚已存分集（旧 check-watch-history-integration 第 6 条）', () => {
  it('刷新拿到的分集比缓存的少时不回退总数；拿到的多时才更新未读数', () => {
    const record = {
      watched: true,
      vid_index: 1,
      currentTime: 10,
      updatedAt: now,
      knownTotal: 5,
      acknowledgedTotal: 3,
    };
    const slower = applyEpisodeUpdate(record as never, series(5) as never, series(4) as never, now);
    expect(slower.knownTotal).toBe(5);
    expect(slower.acknowledgedTotal).toBe(3);
    expect(slower.unreadEpisodes).toBe(2);
    expect(slower.lastCheckedAt).toBe(now);
    expect(slower.lastEpisodeCheckError).toBe('');
    // 分集检查成功不该顺手清掉续作检查的失败原因
    expect(slower.lastCheckError).toBe('');

    const withSequelError = applyEpisodeUpdate(
      { ...record, lastSequelCheckError: '搜索超时' } as never,
      series(5) as never,
      series(6) as never,
      now,
    );
    expect(withSequelError.knownTotal).toBe(6);
    expect(withSequelError.unreadEpisodes).toBe(3);
    expect(withSequelError.lastCheckError).toBe('搜索超时');
  });
});

describe('刷新只写续作与检查点（旧 check-watch-history-integration 第 4 条的正向部分）', () => {
  it('刷新结果合并落盘后：续作与检查点写入，播放位置字段原样保留', async () => {
    const file = storeFile();
    const store = createStore();
    store.init(file);
    store.saveSeries([series(6) as never] as never);
    const record = recordPlayback(undefined, series(6) as never, 2, 12, now);
    store.savePlayback({ [SID]: record } as never);

    const playback = store.getPlayback() as Record<string, Record<string, unknown>>;
    const result = await refreshWatchHistory({
      series: store.getSeries() as never[],
      playback: playback as never,
      searchSequels: async () => ({
        success: true,
        results: [{ series_id: '1000002', series_title: '春日来信第二季' }],
      }),
      now,
    });
    expect(result).toMatchObject({ checked: 1, failed: 0 });
    store.savePlayback({ ...playback, ...result.updates } as never);

    const reopened = createStore();
    reopened.init(file);
    const saved = reopened.getPlayback()[SID] as Record<string, unknown>;
    expect(saved.vid_index).toBe(2);
    expect(saved.currentTime).toBe(12);
    expect(saved.sequels).toEqual([{ series_id: '1000002', series_title: '春日来信第二季' }]);
    expect(saved.lastSequelCheckAt).toBe(now);
    expect(saved.lastCheckError).toBe('');
  });
});
