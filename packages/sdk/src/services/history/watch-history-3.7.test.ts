/**
 * 分季家族与续作匹配（迁移自 4.5 `scripts/check-watch-history-3.7.cjs` 的「家族分组」部分）。
 *
 * 4.5 的这条检查跑的是 `main.js` 里的刷新编排：三季进一个家族、基名只搜一次、
 * 低季拿到比自己高的季、已完成低季在自动刷新时跳过。5.0 把算法搬到纯函数
 * （`watch-history.ts` 的 `seasonTitle` / `familyKey` / `findSequels` / `listHistory`），
 * 编排在 `refresh.ts`。这里锁住「家族怎么分、续作怎么认、哪些记录算看过」，
 * 也就是旧检查里**有 5.0 对应实现**的那半：
 *
 * - 家族分组、季数排序、同来源同基名（旧检查第 1 条）；
 * - 低季只得比自己高的季（旧检查第 1 条）；
 * - 只有「看过」的记录参与（旧检查的检测范围语义）；
 * - 完成证据（`completedEpisode`）参与列表展示（旧检查 fixture 里第一季已完成）。
 *
 * 旧检查另一半（scope=latest 只查最新季、单行 `check-watch-history-item`、
 * 自动刷新跳过已完成低季、`lastEpisodeCheckError`/`lastSequelCheckError` 拆分）
 * 在 5.0 没有对应实现，见迁移报告，不在此文件里编造等价断言。
 */
import { describe, expect, it } from 'vitest';
import {
  familyKey,
  filterHistory,
  findSequels,
  listHistory,
  mergeSequelUpdates,
  recordPlayback,
  seasonOf,
  seasonTitle,
  sequelKeyword,
} from './watch-history.ts';

/** 与旧检查同一套 fixture：同一部剧的三季，编号形如 `<来源数字 id>`。 */
const BASE = '聚宝仙盆之杂灵根才是真BOSS';
const SEASON_SUFFIX = ['第一季', '第二季', '第三季'];
const family = SEASON_SUFFIX.map((suffix, index) => ({
  series_id: `100000${index + 1}`,
  series_title: `${BASE}${suffix}`,
  total: 10,
  episodes: Array.from({ length: 10 }, (_, position) => ({
    vid: `${index + 1}-${position + 1}`,
    vid_index: position + 1,
  })),
}));

/** 旧检查的播放记录：三季都看过，第一季已看完，第 1 季最新。 */
const now = 1_700_000_000_000;
const playbackOf = () =>
  Object.fromEntries(
    family.map((item, index) => [
      item.series_id,
      {
        watched: true,
        vid_index: 1,
        currentTime: 5,
        updatedAt: now - index,
        knownTotal: 10,
        acknowledgedTotal: 10,
        completedEpisode: index === 0 ? 10 : 0,
      },
    ]),
  );

describe('家族分组（旧 check-watch-history-3.7.cjs 第 1 条）', () => {
  it('同一基名的三季归入一个家族，只有最高季是「最新季」，其余标记有更高季', () => {
    const rows = listHistory(family as never, playbackOf() as never, false) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(new Set(family.map((item) => familyKey(item))).size).toBe(1);
    for (const row of rows) {
      expect(row.isLatestSeason).toBe(row.series_id === '1000003');
      expect(row.hasHigherSeason).toBe(row.series_id !== '1000003');
      // 旧检查按「每剧最近」排序：updatedAt 越大越靠前
      expect(row.season).toBe(Number(String(row.series_id).slice(-1)));
    }
    expect(rows.map((row) => row.series_id)).toEqual(['1000001', '1000002', '1000003']);
  });

  it('基名相同但来源不同、或季数无法判定时，不当作同一个家族', () => {
    expect(familyKey({ series_id: 'custom:abc', series_title: `${BASE}第二季` })).toBe('');
    expect(familyKey({ series_id: '1000009', series_title: '剧名第零季' })).toBe('');
    expect(seasonOf({ series_title: '剧名第零季' })).toBe(0);
    // 无法判定的季不进家族，但列表里仍然独立出现
    const rows = listHistory(
      [{ series_id: '1000009', series_title: '剧名第零季', total: 1 } as never],
      { '1000009': { watched: true, vid_index: 1, currentTime: 1, updatedAt: now } } as never,
      false,
    ) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ isLatestSeason: false, hasHigherSeason: false, season: 0 });
  });

  it('每季用同一个基名做续作搜索关键词（4.5 「同家族只搜一次基名」能成立的前提）', () => {
    const keywords = family.map((item) => sequelKeyword(item));
    expect(new Set(keywords).size).toBe(1);
    expect(keywords[0]).toBe(BASE.toLowerCase());
  });
});

describe('续作匹配（旧 check-watch-history-3.7.cjs 第 1 条）', () => {
  const candidates = family.map((item) => ({ series_id: item.series_id, series_title: item.series_title }));

  it('低季只匹配比自己高的同基名前缀，数量随季数递减', () => {
    expect(findSequels(family[0], candidates).map((row) => row.series_id)).toEqual(['1000002', '1000003']);
    expect(findSequels(family[1], candidates).map((row) => row.series_id)).toEqual(['1000003']);
    expect(findSequels(family[2], candidates)).toEqual([]);
  });

  it('候选里的自己、更低季、别的剧名、无季标题、别的来源都不算续作', () => {
    const noisy = [
      { series_id: '1000001', series_title: `${BASE}第一季` },
      { series_id: '1000002', series_title: `${BASE}第二季` },
      { series_id: '1000009', series_title: `${BASE}` },
      { series_id: '1000010', series_title: `别的剧第三季` },
      { series_id: 'xifan:abc:def', series_title: `${BASE}第四季` },
      { series_id: '1000011', series_title: `${BASE}第三季` },
    ];
    expect(findSequels(family[1], noisy).map((row) => row.series_id)).toEqual(['1000011']);
  });

  it('候选里的剧名带阿拉伯数字、全角括号与「部」也算季数', () => {
    const rows = [
      { series_id: '1000020', series_title: `${BASE}第3部` },
      { series_id: '1000021', series_title: `${BASE}（二）` },
      { series_id: '1000022', series_title: `${BASE} season4` },
    ];
    // 按季数升序：二（1000021）→ 三（1000020）→ season4（1000022）
    expect(findSequels(family[0], rows).map((row) => row.series_id)).toEqual([
      '1000021',
      '1000020',
      '1000022',
    ]);
  });

  it('最多只保留 10 部，按季数升序', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      series_id: `10001${String(index + 2).padStart(2, '0')}`,
      series_title: `${BASE}第${index + 2}季`,
    }));
    const found = findSequels(family[0], many);
    expect(found).toHaveLength(10);
    expect(found.map((row) => seasonTitle(row.series_title).season)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });
});

describe('季数解析边界', () => {
  it('中文/阿拉伯数字/括号/season 四种写法都认得', () => {
    expect(seasonTitle(`${BASE}第二季`)).toMatchObject({
      base: BASE.toLowerCase(),
      season: 2,
      explicit: true,
    });
    expect(seasonTitle(`${BASE} 第3季`)).toMatchObject({ season: 3, explicit: true });
    expect(seasonTitle(`${BASE}第十季`)).toMatchObject({ season: 10, explicit: true });
    expect(seasonTitle(`${BASE}（二）`)).toMatchObject({ season: 2, explicit: true });
    expect(seasonTitle(`${BASE} season4`)).toMatchObject({ season: 4, explicit: true });
    expect(seasonTitle(BASE)).toMatchObject({ season: 1, explicit: false });
  });

  it('括号里的年份不当季数，季数非法（第零季）单独标记', () => {
    const year = seasonTitle(`${BASE} (2024)`);
    expect(year.explicit).toBe(false);
    expect(year.season).toBe(1);
    expect(year.base).toBe(`${BASE.toLowerCase()}(2024)`);
    expect(seasonTitle(`${BASE}第零季`)).toMatchObject({ season: 1, explicit: false, invalid: true });
  });
});

describe('检测范围：只有看过的记录参与（旧 check-watch-history-3.7.cjs 的记录口径）', () => {
  const series = [
    family[0],
    { series_id: '1000004', series_title: '只看过封面', total: 3, episodes: [] },
    { series_id: '1000005', series_title: '打开过但没看', total: 3, episodes: [] },
  ] as never[];

  it('watched=true 或 currentTime>0 才算看过；缺 updatedAt、集号非法一律排除', () => {
    const rows = listHistory(
      series,
      {
        '1000001': { watched: true, vid_index: 1, currentTime: 0, updatedAt: now },
        '1000004': { watched: false, vid_index: 1, currentTime: 0, updatedAt: now },
        '1000005': { watched: false, vid_index: 0, currentTime: 12, updatedAt: now },
      } as never,
      false,
    ) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.series_id)).toEqual(['1000001']);
  });

  it('完成证据只认 completedEpisode >= 总集数', () => {
    const rows = listHistory(
      [family[0] as never, family[1] as never],
      {
        '1000001': { watched: true, vid_index: 10, currentTime: 100, updatedAt: now, completedEpisode: 10 },
        '1000002': { watched: true, vid_index: 9, currentTime: 100, updatedAt: now, completedEpisode: 9 },
      } as never,
      false,
    ) as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.series_id === '1000001')?.completed).toBe(true);
    expect(rows.find((row) => row.series_id === '1000002')?.completed).toBe(false);
    expect(rows.every((row) => row.total === 10)).toBe(true);
  });

  it('续作开关关闭时不返回续作，也就不会因为「没见过的续作」平白出现红点', () => {
    const record = {
      watched: true,
      vid_index: 1,
      currentTime: 5,
      updatedAt: now,
      sequels: [{ series_id: '1000003', series_title: `${BASE}第三季` }],
    };
    const shown = listHistory([family[0] as never], { '1000001': record } as never, true) as Array<
      Record<string, unknown>
    >;
    const hidden = listHistory([family[0] as never], { '1000001': record } as never, false) as Array<
      Record<string, unknown>
    >;
    expect(shown[0]).toMatchObject({ hasUpdates: true });
    expect(hidden[0]).toMatchObject({ sequels: [], hasUpdates: false });
  });
});

/**
 * 范围筛选与续作写回（迁移自 `check-watch-history-3.7.cjs` / `check-watch-history-integration.cjs`
 * 的筛选与「刷新不回滚进度」部分）。
 */
describe('filterHistory', () => {
  const rows = [
    {
      series_id: 'A',
      season: 1,
      isLatestSeason: false,
      hasHigherSeason: true,
      currentTime: 10,
      duration: 100,
    },
    {
      series_id: 'B',
      season: 2,
      isLatestSeason: true,
      hasHigherSeason: false,
      currentTime: 100,
      duration: 100,
      completed: true,
    },
    {
      series_id: 'C',
      season: 1,
      isLatestSeason: true,
      hasHigherSeason: false,
      currentTime: 30,
      duration: 100,
    },
    { series_id: 'D', season: 1, isLatestSeason: true, hasHigherSeason: false, currentTime: 0, duration: 0 },
  ];

  it('all 原样返回', () => {
    expect(filterHistory(rows, 'all')).toHaveLength(4);
  });

  it('latest 丢掉同家族还有更高季的行（不是按剧号去重）', () => {
    expect(filterHistory(rows, 'latest').map((row) => row.series_id)).toEqual(['B', 'C', 'D']);
  });

  it('unfinished 排除已看完的，时长缺失时保留', () => {
    expect(filterHistory(rows, 'unfinished').map((row) => row.series_id)).toEqual(['A', 'C', 'D']);
  });

  it('skip-completed-low 只跳过「已看完且还有更高季」的行', () => {
    const withCompletedLow = [
      ...rows,
      { series_id: 'E', hasHigherSeason: true, completed: true, currentTime: 90, duration: 100 },
    ];
    expect(filterHistory(withCompletedLow, 'skip-completed-low').map((row) => row.series_id)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('空输入与未知范围不崩', () => {
    expect(filterHistory(null, 'latest')).toEqual([]);
    expect(filterHistory(rows, undefined)).toHaveLength(4);
  });
});

describe('mergeSequelUpdates', () => {
  const current = {
    A: { vid: 'a2', vid_index: 2, currentTime: 77, duration: 100, knownTotal: 10, updatedAt: 5 },
    B: { vid: 'b1', vid_index: 1, currentTime: 3, updatedAt: 1 },
  };

  it('只合并续作相关字段：刷新期间的进度不会被退回旧值', () => {
    const merged = mergeSequelUpdates(current, {
      A: {
        vid_index: 2,
        currentTime: 12,
        duration: 100,
        knownTotal: 12,
        updatedAt: 4,
        sequels: [{ series_id: 'A2' }],
        lastCheckedAt: 9,
      },
    });
    expect(merged.A).toMatchObject({
      vid_index: 2,
      currentTime: 77, // 没被 update 里的旧时间覆盖
      updatedAt: 5,
      knownTotal: 12,
      sequels: [{ series_id: 'A2' }],
      lastCheckedAt: 9,
    });
  });

  it('刷新期间被移除的记录不复活（用户删了历史就不该再出现）', () => {
    const merged = mergeSequelUpdates({ A: current.A }, { A: { sequels: [] }, B: { knownTotal: 3 } });
    expect(Object.keys(merged)).toEqual(['A']);
  });

  it('knownTotal 只增不减；失败原因如实写回', () => {
    const merged = mergeSequelUpdates(current, { A: { knownTotal: 8, lastCheckError: '搜索超时' } });
    expect(merged.A?.knownTotal).toBe(10);
    expect(merged.A?.lastCheckError).toBe('搜索超时');
  });

  it('空输入不崩', () => {
    expect(mergeSequelUpdates(null, {})).toEqual({});
    expect(mergeSequelUpdates({ A: current.A }, null)).toEqual({ A: current.A });
  });
});

describe('recordPlayback 的完成证据', () => {
  const series = { series_id: 'A', total: 3 };

  it('播到结尾且是最后一集才算「看完这一集」', () => {
    const record = recordPlayback({}, series, 3, 100, 1, { duration: 100, ended: true });
    expect(record.completedEpisode).toBe(3);
  });

  it('暂停/拖到结尾但没播完（ended=false）不算看完', () => {
    expect(
      recordPlayback({}, series, 2, 100, 1, { duration: 100, ended: false }).completedEpisode,
    ).toBeUndefined();
    expect(recordPlayback({}, series, 2, 99, 1, { duration: 100, ended: true })).toBeTruthy();
  });

  it('只看了一半不算；回到第一集也不会把完成集数降下来', () => {
    const half = recordPlayback({}, series, 1, 50, 1, { duration: 100, ended: true });
    expect(half.completedEpisode).toBeUndefined();
    const advanced = recordPlayback({ completedEpisode: 3 }, series, 1, 100, 2, {
      duration: 100,
      ended: true,
    });
    expect(advanced.completedEpisode).toBe(3);
  });

  it('非法进度直接拒绝', () => {
    expect(() => recordPlayback({}, series, 0, 10)).toThrow();
    expect(() => recordPlayback({}, series, 1, -1)).toThrow();
  });
});
