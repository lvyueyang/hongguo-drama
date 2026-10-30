/**
 * 下一集预取（迁移自 4.5 播放器的预取行为，决策改到主进程）。
 * 不变量：只取紧随的未锁定集、同一集不并发重复取、失败静默、超时算失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextPrefetchTarget, prefetchNextEpisode, resetPrefetchState } from './prefetch.ts';

const episodes = [
  { vid: '1', vid_index: 1 },
  { vid: '2', vid_index: 2 },
  { vid: '3', vid_index: 3, locked: true },
  { vid: '4', vid_index: 4 },
];

beforeEach(() => resetPrefetchState());

describe('nextPrefetchTarget', () => {
  it('取紧随其后的那一集', () => {
    expect(nextPrefetchTarget(episodes, '1')?.vid).toBe('2');
  });

  it('紧随的那集被锁定就不预取（锁定的取了也播不了）', () => {
    expect(nextPrefetchTarget(episodes, '2')).toBeNull();
  });

  it('已是最后一集、当前集不在列表、列表为空都返回 null', () => {
    expect(nextPrefetchTarget(episodes, '4')).toBeNull();
    expect(nextPrefetchTarget(episodes, 'unknown')).toBeNull();
    expect(nextPrefetchTarget([], '1')).toBeNull();
    expect(nextPrefetchTarget([{ vid: '1' }], '1')).toBeNull();
  });

  it('顺序以传入列表为准，不按 vid_index 猜', () => {
    const shuffled = [
      { vid: 'b', vid_index: 7 },
      { vid: 'a', vid_index: 9 },
    ];
    expect(nextPrefetchTarget(shuffled, 'b')?.vid).toBe('a');
  });
});

describe('prefetchNextEpisode', () => {
  it('成功返回 prefetched，并把目标集交给 load', async () => {
    const load = vi.fn(async () => ({ url: 'x' }));
    const result = await prefetchNextEpisode({ episodes, currentVid: '1', load });
    expect(result).toEqual({ target: '2', status: 'prefetched' });
    expect(load).toHaveBeenCalledWith('2', expect.objectContaining({ vid: '2' }));
  });

  it('同一集在飞时不重复取（进度事件会重复触发）', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      if (calls === 1)
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      return Promise.resolve({});
    });
    const first = prefetchNextEpisode({ episodes, currentVid: '1', load });
    const second = await prefetchNextEpisode({ episodes, currentVid: '1', load });
    expect(second.status).toBe('skipped');
    release?.();
    expect((await first).status).toBe('prefetched');
    expect(load).toHaveBeenCalledTimes(1);
    // 完成后允许再预取（例如用户重开这一集）。
    await prefetchNextEpisode({ episodes, currentVid: '1', load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('失败静默：不抛错，只回报 failed', async () => {
    const result = await prefetchNextEpisode({
      episodes,
      currentVid: '1',
      load: async () => {
        throw new Error('network down');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('network down');
  });

  it('超时算失败，且不会一直挂着', async () => {
    const result = await prefetchNextEpisode({
      episodes,
      currentVid: '1',
      timeoutMs: 10,
      load: () => new Promise(() => {}),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/超时/);
  });

  it('已取消就不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const load = vi.fn(async () => ({}));
    const result = await prefetchNextEpisode({
      episodes,
      currentVid: '1',
      load,
      signal: controller.signal,
    });
    expect(result.status).toBe('canceled');
    expect(load).not.toHaveBeenCalled();
  });

  it('没有可预取目标时返回 skipped', async () => {
    const load = vi.fn(async () => ({}));
    expect(await prefetchNextEpisode({ episodes, currentVid: '4', load })).toEqual({
      target: '',
      status: 'skipped',
    });
    expect(load).not.toHaveBeenCalled();
  });
});
