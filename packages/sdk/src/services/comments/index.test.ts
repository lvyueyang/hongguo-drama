/**
 * 单集评论（迁移自 4.5 `src/native/episode-comments.test.cjs`）。
 *
 * 重点：上限与游标必须校验、分集必须与请求一致（不能泄漏上一集的评论）、
 * id 稳定去重、如实标注「来源只开放部分评论」。
 */

import http from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import commentsApi from './index.ts';

const { fetchEpisodeComments } = commentsApi;
const seriesId = '7503745441910017049';
const episodeId = '7503780574541122622';

function pageFor(targetSeries = seriesId, targetEpisode = episodeId): string {
  const review = { content: '公开评论', user_name: '测试用户', create_time: '123' };
  return `window._ROUTER_DATA=${JSON.stringify({
    loaderData: {
      player: {
        seriesDetail: { series_id: targetSeries },
        vid: targetEpisode,
        episodeSocialInfo: {
          reviews: {
            total_count: '500',
            reviews: [review, { ...review }, { content: '第二条' }, { content: ' ' }],
          },
        },
      },
    },
  })};`;
}

function install() {
  const calls: string[] = [];
  vi.spyOn(http, 'get').mockImplementation((async (url: string, options: any) => {
    calls.push(url);
    expect(url).toMatch(new RegExp(`^https://hongguoduanju.com/player/${seriesId}/[0-9]+$`));
    expect(options.headers.Cookie).toBeUndefined();
    return { data: pageFor() };
  }) as never);
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchEpisodeComments', () => {
  it('非法参数（含非数字分集、带游标、越界上限）在联网前被拒', async () => {
    const harness = install();
    for (const invalid of [
      null,
      {},
      { seriesId, episodeId: '../other' },
      { seriesId, episodeId, cursor: 'next' },
      { seriesId, episodeId, limit: 0 },
      { seriesId, episodeId, limit: 31 },
    ]) {
      expect((await fetchEpisodeComments(invalid as never)).success).toBe(false);
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('返回稳定去重的条目、总数为上游值，并如实标注来源受限', async () => {
    install();
    const page = (await fetchEpisodeComments({ seriesId, episodeId, cursor: null, limit: 30 })) as Record<
      string,
      any
    >;
    expect(page.success).toBe(true);
    expect(page.series_id).toBe(seriesId);
    expect(page.episode_id).toBe(episodeId);
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((item: { id: string }) => item.id)).size).toBe(2);
    expect(page.total).toBe(500);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
    expect(page.source_limited).toBe(true);
    expect(String(page.notice)).toMatch(/部分评论/);
    expect(Object.keys(page.items[0]).sort()).toEqual(['content', 'id']);
  });

  it('复用公开详情缓存，同集第二次不再请求', async () => {
    const harness = install();
    const first = (await fetchEpisodeComments({ seriesId, episodeId })) as Record<string, any>;
    const afterFirst = harness.calls.length;
    const second = (await fetchEpisodeComments({ seriesId, episodeId })) as Record<string, any>;
    expect(second.items).toEqual(first.items);
    // 公开详情有模块级缓存：第二次不应再发请求（首次可能命中更早的缓存，所以比增量而不是绝对值）
    expect(harness.calls.length).toBe(afterFirst);
  });

  it('分集与响应不一致时报错，不泄漏上一集的评论', async () => {
    install();
    const result = (await fetchEpisodeComments({ seriesId, episodeId: '7503780577347128382' })) as Record<
      string,
      any
    >;
    expect(result.success).toBe(false);
    expect(result.items).toBeUndefined();
  });
});
