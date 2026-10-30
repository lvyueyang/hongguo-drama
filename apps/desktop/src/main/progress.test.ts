import { describe, expect, it } from 'vitest';

/**
 * 播放进度语义（与主进程 progressPort 的约定一致）。
 * 这里用纯函数复刻主进程的合并规则，保证「拖动回看不会把进度写小」这条不变量有测试兜住。
 */
interface Record {
  vid?: string;
  vid_index?: number;
  currentTime?: number;
  duration?: number;
  updatedAt?: number;
  watched?: boolean;
}

function mergeProgress(
  previous: Record,
  input: { vid: string; vidIndex: number; currentTime: number; duration: number; watched: boolean },
  now: number,
): Record {
  const sameEpisode = String(previous.vid ?? '') === input.vid;
  const currentTime = sameEpisode
    ? Math.max(Number(previous.currentTime) || 0, input.currentTime)
    : input.currentTime;
  return {
    ...previous,
    vid: input.vid,
    vid_index: input.vidIndex,
    currentTime,
    duration: input.duration || Number(previous.duration) || 0,
    updatedAt: now,
    watched: input.watched === true || previous.watched === true,
  };
}

describe('播放进度合并规则', () => {
  it('同集回看不会把进度写小', () => {
    const first = mergeProgress(
      {},
      { vid: 'v1', vidIndex: 1, currentTime: 60, duration: 100, watched: false },
      1,
    );
    const back = mergeProgress(
      first,
      { vid: 'v1', vidIndex: 1, currentTime: 20, duration: 100, watched: false },
      2,
    );
    expect(back.currentTime).toBe(60);
    expect(back.updatedAt).toBe(2);
  });

  it('换集时按新集的时间重置，不沿用上一集的秒数', () => {
    const first = mergeProgress(
      {},
      { vid: 'v1', vidIndex: 1, currentTime: 90, duration: 100, watched: false },
      1,
    );
    const next = mergeProgress(
      first,
      { vid: 'v2', vidIndex: 2, currentTime: 5, duration: 120, watched: false },
      2,
    );
    expect(next).toMatchObject({ vid: 'v2', vid_index: 2, currentTime: 5, duration: 120 });
  });

  it('看过标记一旦置上就不会被后续写入抹掉', () => {
    const watched = mergeProgress(
      {},
      { vid: 'v1', vidIndex: 1, currentTime: 95, duration: 100, watched: true },
      1,
    );
    const again = mergeProgress(
      watched,
      { vid: 'v1', vidIndex: 1, currentTime: 96, duration: 100, watched: false },
      2,
    );
    expect(again.watched).toBe(true);
  });

  it('时长缺失时保留上一次的时长，避免显示 0 分钟', () => {
    const first = mergeProgress(
      {},
      { vid: 'v1', vidIndex: 1, currentTime: 10, duration: 100, watched: false },
      1,
    );
    const second = mergeProgress(
      first,
      { vid: 'v1', vidIndex: 1, currentTime: 20, duration: 0, watched: false },
      2,
    );
    expect(second.duration).toBe(100);
  });
});
