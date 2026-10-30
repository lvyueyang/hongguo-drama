/**
 * 公开详情 / 剧评（迁移自 4.5 `src/native/public-details.test.cjs` 与 `check-public-details.cjs`）。
 *
 * 这里守的是两类容易出错的行为：
 * - 条数上限（默认 50 / 显式 1000）互不污染缓存，同一上限的并发请求只打一次；
 * - 「锁集」与「普通失败」必须区分：只有同源同剧的锁定跳转才算来源未开放，
 *   跨站、跨剧、404/503、超时都不能冒充「来源未开放」。
 */

import http from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicDetails, parsePublicDetails } from './details.ts';

const SID = '7503745441910017049';
const VID = '7503780574541122622';

const page = (seriesId = SID, vid = ''): string => {
  const reviews = {
    total_count: '15536',
    reviews: Array.from({ length: 1200 }, (_, index) => ({
      content: `评${index}`,
      user_name: `u${index}`,
      create_time: '123',
      digg_count: '2',
      rating: 5,
    })),
  };
  return `window._ROUTER_DATA=${JSON.stringify({
    loaderData: {
      detail: {
        seriesDetail: { series_id: seriesId },
        vid,
        seriesSocialInfo: { reviews },
        episodeSocialInfo: { reviews },
      },
    },
  })};`;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePublicDetails', () => {
  it('默认每侧 50 条，显式上限可到 1000 条，字段协议不变', () => {
    const small = parsePublicDetails(page(SID, VID), SID, VID);
    expect(small.reviews.items).toHaveLength(50);
    expect(small.episode_reviews?.items).toHaveLength(50);

    const big = parsePublicDetails(page(SID, VID), SID, VID, { reviewsLimit: 1000 });
    expect(big.reviews.items).toHaveLength(1000);
    expect(big.episode_reviews?.items).toHaveLength(1000);
    expect(big.reviews.total).toBe(15536);
    expect(big.reviews.items[0]).toEqual({
      author: 'u0',
      avatar: '',
      content: '评0',
      created_at: 123000,
      likes: 2,
      rating: 5,
    });
  });

  it('剧集或分集不匹配时报错，而不是返回别人的剧评', () => {
    expect(() => parsePublicDetails(page(), '1234567')).toThrow(/剧集不匹配/);
    expect(() => parsePublicDetails(page(SID, VID), SID, '1234567')).toThrow(/分集不匹配/);
  });
});

describe('fetchPublicDetails：缓存与去重', () => {
  it('50 与 1000 条缓存独立，同上限并发只请求一次，失败后可重试', async () => {
    let calls = 0;
    let offline = false;
    vi.spyOn(http, 'get').mockImplementation((async (url: string) => {
      calls += 1;
      if (offline) throw new Error('offline');
      return { data: page(new URL(url).searchParams.get('series_id') ?? '') };
    }) as never);

    const small = await fetchPublicDetails(SID);
    expect(small.reviews.items).toHaveLength(50);

    const [a, b] = await Promise.all([
      fetchPublicDetails(SID, '', { reviewsLimit: 1000 }),
      fetchPublicDetails(SID, '', { reviewsLimit: 1000 }),
    ]);
    expect(a.reviews.items).toHaveLength(1000);
    expect(b).toEqual(a);
    expect(calls).toBe(2);

    await fetchPublicDetails(SID);
    expect(calls).toBe(2);

    // 换一部剧 + 先失败后成功：失败不写缓存
    offline = true;
    const other = '7503745441910017050';
    expect((await fetchPublicDetails(other, '', { reviewsLimit: 1000 })).success).toBe(false);
    offline = false;
    expect((await fetchPublicDetails(other, '', { reviewsLimit: 1000 })).reviews.items).toHaveLength(1000);
  });
});

describe('fetchPublicDetails：锁集与失败区分', () => {
  it('同源同剧锁集跳转判为来源未开放，且不返回其它分集评论', async () => {
    vi.spyOn(http, 'get').mockImplementation((async (_url: string, options: { maxRedirects?: number }) => {
      expect(options.maxRedirects).toBe(0);
      throw {
        response: { status: 302, headers: { location: `/player/${SID}/1234567?pc_locked_episode=${VID}` } },
      };
    }) as never);

    const result = (await fetchPublicDetails(SID, VID)) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.code).toBe('EPISODE_COMMENTS_UNAVAILABLE');
    expect(result.source_limited).toBe(true);
    expect(result.items).toBeUndefined();
    expect(String(result.error)).toMatch(/未开放/);
  });

  it('跨站、跨剧、普通跳转、HTTP 错误与超时都不冒充“来源未开放”', async () => {
    const locations = [
      `https://example.com/player/${SID}/1234567?pc_locked_episode=${VID}`,
      `/player/1234567/1234567?pc_locked_episode=${VID}`,
      `/player/${SID}/1234567`,
      `/player/${SID}/1234567?pc_locked_episode=1234567`,
      `/detail?series_id=${SID}&pc_locked_episode=${VID}`,
      `https://user:pass@hongguoduanju.com/player/${SID}/1234567?pc_locked_episode=${VID}`,
    ];
    const spy = vi.spyOn(http, 'get');
    for (const location of locations) {
      spy.mockImplementation((async () => {
        throw { response: { status: 302, headers: { location } } };
      }) as never);
      const result = (await fetchPublicDetails(SID, VID)) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(result.code, location).toBeUndefined();
    }

    for (const status of [404, 503]) {
      spy.mockImplementation((async () => {
        throw {
          response: { status, headers: { location: `/player/${SID}/1234567?pc_locked_episode=${VID}` } },
        };
      }) as never);
      const result = (await fetchPublicDetails(SID, VID)) as Record<string, unknown>;
      expect(result.code).toBeUndefined();
    }

    spy.mockImplementation((async () => {
      throw { code: 'ECONNABORTED' };
    }) as never);
    expect(String(((await fetchPublicDetails(SID, VID)) as Record<string, unknown>).error)).toMatch(/超时/);
  });

  it('编号非法时直接拒绝，不发请求', async () => {
    const spy = vi.spyOn(http, 'get');
    const result = (await fetchPublicDetails('abc')) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('parsePublicDetails：元数据与不可信内容', () => {
  const detailPage = (detail: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    `<script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: {
        detail_page: {
          isSuccess: true,
          seriesDetail: detail,
          seriesSocialInfo: {
            rating: 9.4,
            series_like_count: '42',
            reviews: {
              total_count: '1',
              reviews: [
                {
                  user_name: '测试读者',
                  content: '括号 } 保留；<script>只是文字',
                  create_time: '1700000000',
                  digg_count: '2',
                  user_avatar: 'javascript:alert(1)',
                },
              ],
            },
          },
          ...extra,
        },
      },
    })};throw Error('remote script must not execute');</script>`;

  it('评分、点赞数、首播时间取自各自字段，录入时间不冒充首播时间', () => {
    const result = parsePublicDetails(
      detailPage({ series_id: '123456789', first_visible_time: '1700000000' }),
      '123456789',
    );
    expect(result.published_at).toBe(1700000000000);
    expect(result.rating).toBe(9.4);
    expect(result.like_count).toBe(42);
    expect(result.favorite_count).toBeNull();
  });

  it('评论正文保留花括号与类脚本文本，javascript: 头像被清空', () => {
    const result = parsePublicDetails(detailPage({ series_id: '123456789' }), '123456789');
    expect(result.reviews.items[0]?.content).toBe('括号 } 保留；<script>只是文字');
    expect(result.reviews.items[0]?.avatar).toBe('');
  });

  it('没有单集信息时 episode_reviews 为 null，有则解析真实评论', () => {
    const plain = parsePublicDetails(detailPage({ series_id: '123456789' }), '123456789');
    expect(plain.episode_reviews).toBeNull();

    const withEpisode = parsePublicDetails(
      detailPage(
        { series_id: '123456789' },
        {
          vid: '987654321',
          episodeSocialInfo: {
            episode_like_count: '3',
            reviews: { total_count: '1', reviews: [{ content: '单集真实评论' }] },
          },
        },
      ),
      '123456789',
      '987654321',
    );
    expect(withEpisode.episode_reviews?.items[0]?.content).toBe('单集真实评论');
  });

  it('页面不是目录数据时抛错', () => {
    expect(() => parsePublicDetails('<html>登录或错误页面</html>', '123456789')).toThrow();
  });
});
