/**
 * App「近期上新」的字段映射、去重合并与缓存深度（迁移自 4.5 `src/native/hongguo-app-new.test.cjs`）。
 *
 * 已有 `new-releases.test.ts` 压的是两类目并行、分页收口与 partial 传递（走真实 loopback HTTP）。
 * 这里补的是它没压的另一半：一条上游行怎么变成结果项（今天标记、封面可显示性、标签）、
 * 两类目重复的同一部剧怎么合并，以及**缓存深度**——一页的缓存不能满足要两页的请求，
 * 否则第二页的当天新剧会永远搜不到。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNewReleaseCache,
  collectRows,
  DEFAULT_PAGES,
  listNewReleases,
  MAX_RESULTS,
  matchNewReleases,
  newReleaseFromRow,
  searchNewReleases,
} from './new-releases.ts';

const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  series_id: id,
  title,
  content_type: 1,
  episode_cnt: 24,
  cover:
    'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-81nmtwyey9-superreso-aifit:400:0.heic?lk3s=1',
  video_desc: '短剧简介',
  tag_info: { text: '新剧' },
  sub_title_list: [{ content: '今日上新' }, { content: '都市' }],
  ...extra,
});

const page = (rows: unknown[], more = false, next = rows.length, session = 'session-1') => ({
  code: 0,
  data: { video_data: rows, has_more: more, next_offset: next, session_id: session },
});

beforeEach(() => {
  clearNewReleaseCache();
});

describe('newReleaseFromRow：一行上游数据变成一条可展示结果', () => {
  it('保留「今日上新」标记、清洗标题、封面换成可显示的格式', () => {
    const item = newReleaseFromRow(row('7700000000000000001', '<b>当天</b>新剧')) as any;
    expect(item).toMatchObject({
      series_id: '7700000000000000001',
      series_title: '当天新剧',
      released_today: true,
      new_release: true,
      episode_count: 24,
      source: 'hongguo',
      url: 'https://hongguoduanju.com/detail?series_id=7700000000000000001',
    });
    // HEIC 直链在 Chromium 上渲染不出来，必须换成等价的 webp/JPEG 变体。
    expect(item.cover).toBe('https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image');
  });

  it('标签只留题材（去掉「新剧」「今日上新」），最多四条', () => {
    const item = newReleaseFromRow(
      row('1', '多标签', {
        tag_info: { text: '新剧' },
        sub_title_list: [
          { content: '今日上新' },
          { content: '都市' },
          { content: '言情' },
          { content: '爽文' },
          { content: '复仇' },
        ],
      }),
    ) as any;
    expect(item.tags).toEqual(['都市', '言情', '爽文', '复仇']);
    expect(item.released_today).toBe(true);
  });

  it('没有编号、没有标题或标题只有标记的行直接丢弃', () => {
    expect(newReleaseFromRow({ title: '缺编号' })).toBeNull();
    expect(newReleaseFromRow({ series_id: '1', title: '  ' })).toBeNull();
    expect(newReleaseFromRow({ series_id: 'xifan:1', title: '第三方' })).toBeNull();
    expect(newReleaseFromRow(null)).toBeNull();
  });
});

describe('collectRows：同一个剧出现在两类目时合并而不是重复', () => {
  it('合并「今日上新」标记与更完整的字段，不丢已取到的简介', () => {
    const items = collectRows([
      row('1', '同一部剧', { sub_title_list: [{ content: '新剧' }] }),
      row('1', '同一部剧', { description: '另一份简介' }),
      row('2', '另一部'),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ series_id: '1', released_today: true, description: '短剧简介' });
    expect(items[1].released_today).toBe(true);
  });
});

describe('matchNewReleases：同名新剧不能被更长的剧名遮住', () => {
  const items = [
    null,
    'not-a-row',
    newReleaseFromRow(row('1', '言出法随，诸天万界')),
    newReleaseFromRow(row('2', '西北往事之我与我家第一季')),
    newReleaseFromRow(row('3', '闪婚')),
    newReleaseFromRow(row('4', '无关剧名')),
  ] as never;

  it('标点、空白与季数后缀都不影响匹配', () => {
    expect(matchNewReleases(items, '言出法随 诸天万界').map((item: any) => item.series_id)).toEqual(['1']);
    expect(matchNewReleases(items, '西北往事之我与我家').map((item: any) => item.series_id)).toEqual(['2']);
    expect(matchNewReleases(items, '我想看闪婚').map((item: any) => item.series_id)).toEqual(['3']);
  });

  it('单字与完全无关的词不匹配（补搜没有意义）', () => {
    expect(matchNewReleases(items, '闪')).toEqual([]);
    expect(matchNewReleases(items, '完全不存在的剧')).toEqual([]);
    expect(matchNewReleases(items, '   ')).toEqual([]);
    expect(matchNewReleases(null as never, '闪婚')).toEqual([]);
  });

  it('同分时「今日上新」排在前面', () => {
    const same = [
      newReleaseFromRow(row('1', '重生第一季', { sub_title_list: [{ content: '都市' }] })),
      newReleaseFromRow(row('2', '重生第一季', { sub_title_list: [{ content: '今日上新' }] })),
    ] as never;
    expect(matchNewReleases(same, '重生第一季').map((item: any) => item.series_id)).toEqual(['2', '1']);
  });

  it('结果条数有上限，不会把整个新剧列表倒给搜索页', () => {
    expect(MAX_RESULTS).toBe(20);
    expect(DEFAULT_PAGES).toBe(2);
  });
});

describe('listNewReleases：缓存深度必须匹配请求深度', () => {
  const shallow = () =>
    vi.fn(async (signed: any) => {
      const body = JSON.parse(signed.body.toString());
      return page(
        [
          row(
            body.select_items.genre[0] === 'short_play' ? '7300000000000000001' : '7300000000000000002',
            '第一页',
          ),
        ],
        true,
        50,
      );
    });

  it('一页的缓存不能满足要两页的请求，第二页的当天新剧仍能被搜到', async () => {
    const first = await listNewReleases({ pages: 1, request: shallow() });
    expect(first.items).toHaveLength(2);

    const deepCalls: Array<{ genre: string; offset: number }> = [];
    const deep = vi.fn(async (signed: any) => {
      const body = JSON.parse(signed.body.toString());
      deepCalls.push({ genre: body.select_items.genre[0], offset: body.offset });
      return body.offset === 0
        ? page([row('7400000000000000001', '深页第一页')], true, 50)
        : page([row('7400000000000000002', '深页第二页')], false, 0);
    });
    const second = await listNewReleases({ pages: 2, request: deep });
    expect(deepCalls).toHaveLength(4);
    expect(second.items.map((item: any) => item.series_id).sort()).toEqual([
      '7400000000000000001',
      '7400000000000000002',
    ]);
  });

  it('两页的缓存可以服务一页的请求（更浅的查询直接复用）', async () => {
    await listNewReleases({ pages: 2, request: shallow() });
    const request = vi.fn(async () => {
      throw new Error('must use cache');
    });
    const result = await listNewReleases({ pages: 1, request: request as never });
    expect(result.cached).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('缓存命中时按标题搜索也不再联网', async () => {
    await listNewReleases({ pages: 2, request: shallow() });
    const matched = await searchNewReleases('第一页', {
      request: async () => {
        throw new Error('must use cache');
      },
    });
    expect(matched.map((item: any) => item.series_id)).toEqual([
      '7300000000000000001',
      '7300000000000000002',
    ]);
  });
});
