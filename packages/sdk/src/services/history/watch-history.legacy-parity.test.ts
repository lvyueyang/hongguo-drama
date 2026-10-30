// SPDX-License-Identifier: MIT
/**
 * 观看记录的残余不变量（迁自 4.5 `scripts/check-watch-history.cjs` 与
 * `scripts/check-watch-history-display.cjs` 里**5.0 仍有对应实现**、且既有测试没锁住的那一半）。
 *
 * 已经由别的文件覆盖、这里不重复：看过才算记录 / 续播位置跨重启（`watch-history-records.test.ts`）、
 * 分季家族与续作排序（`watch-history-3.7.test.ts`）、`listHistory` 纯读（同 records）。
 *
 * 本文件补的六件事：
 *   1. 日常播放保存不许顺手吞掉「有新集」的红点，也不许把已知总集数写小；
 *   2. 完成证据的残余分支：不可信时长、不在片尾、目录缩短后重看片尾（完成上限只升不降）；
 *   3. 列表按 `updatedAt` 倒序（4.5「最近看的在前」）；
 *   4. 续作匹配的边界候选：番外/同基名前缀的衍生、伪协议 id、别的来源、第十二季→第十三季；
 *   5. 剧库少了一季之后，剩下那一季的「有更高季」要跟着重算（4.5 移出最高季会提升低季）；
 *   6. 刷新拿到的分集比缓存少时不回退未读基线（`applyEpisodeUpdate`）。
 *
 * 4.5 旧检查里的**渲染层**部分（续作行内播放、`searchResolve` 兜底、逐行检测、
 * 批量检测 scope、低季隐藏开关、已看完计数、逐行移出）在 5.0 没有对应 UI，判 obsolete，
 * 存活的部分见 `apps/desktop/src/renderer/src/pages/History.scope.test.tsx`。
 */
import { describe, expect, it } from 'vitest';
import { applyEpisodeUpdate, findSequels, listHistory, recordPlayback } from './watch-history.ts';

const now = 1_700_000_000_000;

function series(total: number, id = '1000001', title = '春日来信') {
  return {
    series_id: id,
    series_title: title,
    total,
    episodes: Array.from({ length: total }, (_, index) => ({
      vid: `${id}-${index + 1}`,
      vid_index: index + 1,
    })),
  };
}

describe('更新基线：日常保存不吞红点、不回退总集数', () => {
  it('发现新集后记录变成未读 2；随后日常保存仍保留未读 2 与已知 14 集', () => {
    const recorded = recordPlayback(undefined, series(12) as never, 2, 0, now);
    expect(recorded.knownTotal).toBe(12);

    // 刷新发现多了两集：基线推进到 14，已确认仍是 12 → 未读 2
    const updated = applyEpisodeUpdate(
      recorded as never,
      series(12) as never,
      series(14) as never,
      now + 100,
    );
    expect(updated).toMatchObject({ knownTotal: 14, acknowledgedTotal: 12, unreadEpisodes: 2 });
    expect(listHistory([series(14) as never], { '1000001': updated } as never, false)[0]).toMatchObject({
      unreadEpisodes: 2,
      hasUpdates: true,
    });

    // 只是继续看第 2 集：不许把红点洗掉，也不许把已知总集数写回旧值
    const saved = recordPlayback(updated as never, series(14) as never, 2, 34, now + 200);
    expect(saved).toMatchObject({ knownTotal: 14, acknowledgedTotal: 12, unreadEpisodes: 2 });

    // 慢刷新回来只有 11 集：已知总集数不回退
    expect(
      applyEpisodeUpdate(saved as never, series(14) as never, series(11) as never, now + 300),
    ).toMatchObject({ knownTotal: 14, acknowledgedTotal: 12, unreadEpisodes: 2 });
  });
});

describe('完成证据：残余分支', () => {
  const finalSeries = () => series(3, 'last', '完结剧');

  it('末集播到片尾才算完成', () => {
    const complete = recordPlayback(undefined, finalSeries() as never, 3, 100, now, {
      duration: 100,
      ended: true,
    });
    expect(complete.completedEpisode).toBe(3);
    const rows = listHistory([finalSeries() as never], { last: complete } as never, false);
    expect(rows[0]?.completed).toBe(true);
  });

  it('旧记录/不可信时长/没播到片尾一律不算完成', () => {
    // 与 4.5 同一组 metadata：没给、时长非有限、没播完、时长是字符串
    const metadataList = [
      undefined,
      { duration: Number.POSITIVE_INFINITY, ended: true },
      { duration: 100, ended: false },
      { duration: '100', ended: true },
    ] as never[];
    for (const metadata of metadataList) {
      const record = recordPlayback(undefined, finalSeries() as never, 3, 100, now, metadata);
      expect(record.completedEpisode, JSON.stringify(metadata)).toBeUndefined();
      expect(listHistory([finalSeries() as never], { last: record } as never, false)[0]?.completed).toBe(
        false,
      );
    }
    const early = recordPlayback(undefined, finalSeries() as never, 3, 5, now, {
      duration: 100,
      ended: true,
    });
    expect(listHistory([finalSeries() as never], { last: early } as never, false)[0]?.completed).toBe(false);
  });

  it('重看不会丢掉完成状态；新增集后重新算未看完', () => {
    const complete = recordPlayback(undefined, finalSeries() as never, 3, 100, now, {
      duration: 100,
      ended: true,
    });
    const replay = recordPlayback(complete as never, finalSeries() as never, 1, 5, now + 10, {
      duration: 100,
      ended: false,
    });
    expect(replay.completedEpisode).toBe(3);
    expect(listHistory([finalSeries() as never], { last: replay } as never, false)[0]?.completed).toBe(true);
    // 第 4 集上线：完成标记只在 3，不再算看完
    expect(
      listHistory([series(4, 'last', '完结剧') as never], { last: complete } as never, false)[0],
    ).toMatchObject({ total: 4, completed: false });
  });

  it('目录暂时缩短时重看片尾，不会把完成上限降下来', () => {
    const complete = recordPlayback(undefined, finalSeries() as never, 3, 100, now, {
      duration: 100,
      ended: true,
    });
    const fourth = recordPlayback(complete as never, series(4, 'last', '完结剧') as never, 4, 100, now + 10, {
      duration: 100,
      ended: true,
    });
    expect(fourth.completedEpisode).toBe(4);
    // 上游只回了 3 集，用户在「第 3 集」播到片尾：已完成的第 4 集证据必须保住
    const shorter = recordPlayback(fourth as never, finalSeries() as never, 3, 100, now + 20, {
      duration: 100,
      ended: true,
    });
    expect(shorter.completedEpisode).toBe(4);
    expect(
      listHistory([series(4, 'last', '完结剧') as never], { last: shorter } as never, false)[0],
    ).toMatchObject({ completed: true });
  });
});

describe('列表排序', () => {
  it('按最近观看倒序，与剧表顺序无关', () => {
    const registry = [
      series(5, '1000001', '最早'),
      series(5, '1000002', '中间'),
      series(5, '1000003', '最近'),
    ];
    const playback = {
      '1000001': { watched: true, vid_index: 1, currentTime: 5, updatedAt: now - 2000 },
      '1000002': { watched: true, vid_index: 1, currentTime: 5, updatedAt: now - 1000 },
      '1000003': { watched: true, vid_index: 1, currentTime: 5, updatedAt: now },
    };
    const rows = listHistory(registry as never, playback as never, false);
    expect(rows.map((row) => row.series_id)).toEqual(['1000003', '1000002', '1000001']);
  });
});

describe('续作匹配：边界候选', () => {
  const candidates = [
    { series_id: '1000002', series_title: '春日来信第二季' },
    { series_id: '1000004', series_title: '春日来信第三季' },
    { series_id: '1000005', series_title: '春日来信番外' },
    { series_id: '1000006', series_title: '春日来信之另一个故事' },
    { series_id: 'xifan:1:7', series_title: '春日来信第二季' },
    { series_id: 'javascript:alert(1)', series_title: '春日来信第二季' },
  ];

  it('只认同来源、同基名、季数更高的候选', () => {
    // 番外 / 之另一个故事 / 别的来源 / 伪协议 id 全部排除
    expect(findSequels(series(12) as never, candidates).map((row) => row.series_id)).toEqual([
      '1000002',
      '1000004',
    ]);
    // 第二季只看比自己高的季
    expect(
      findSequels({ series_id: '1000002', series_title: '春日来信第二季' } as never, candidates).map(
        (row) => row.series_id,
      ),
    ).toEqual(['1000004']);
  });

  it('两位数的中文季数照常解析，且不会把「第十二季」当第一季', () => {
    const found = findSequels({ series_id: '1000001', series_title: '春日来信第十二季' } as never, [
      { series_id: '1000007', series_title: '春日来信第十三季' },
      { series_id: '1000008', series_title: '春日来信第十一季' },
    ]);
    expect(found.map((row) => row.series_id)).toEqual(['1000007']);
  });
});

describe('剧库变化后重算分季标记（4.5 移出最高季会提升低季）', () => {
  const family = [
    series(20, '1000001', '春日来信'),
    series(20, '1000002', '春日来信第二季'),
    series(20, '1000003', '春日来信第三季'),
  ];
  const playback = Object.fromEntries(
    family.map((item) => [item.series_id, { watched: true, vid_index: 1, currentTime: 5, updatedAt: now }]),
  );

  it('最高季在场时低季标记「有更高季」，最高季被移出后低季升为最新季', () => {
    const before = listHistory(family as never, playback as never, false);
    expect(before.find((row) => row.series_id === '1000001')).toMatchObject({
      hasHigherSeason: true,
      isLatestSeason: false,
    });

    const after = listHistory(family.slice(0, 2) as never, playback as never, false);
    expect(after.find((row) => row.series_id === '1000002')).toMatchObject({
      hasHigherSeason: false,
      isLatestSeason: true,
    });
    expect(after.find((row) => row.series_id === '1000003')).toBeUndefined();
  });
});
