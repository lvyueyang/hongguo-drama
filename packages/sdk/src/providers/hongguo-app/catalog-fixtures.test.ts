/**
 * App 目录离线夹具（迁移自 4.5 `scripts/check-app-catalog.cjs`）。
 *
 * 全部用例只喂合成的 App 响应，不发任何上游请求。守的不变量：
 *   1) 目录会话按「消费者作用域 + 分类 + 题材」隔离，未知作用域不发请求；
 *   2) 封面只把 HEIC 换成已验证的公开 JPEG 对象变体，其它地址原样或留空；
 *   3) 三个分类用动态题材编号，元数据如实（不编造总数/游标）；
 *   4) 四个榜单只用各自的显式热播榜 ID，内容类型不符宁可失败；
 *   5) 分页只用服务端游标，第 1 页常驻，刷新老页要丢掉后续游标；
 *   6) 会话有上限、请求去重、4 秒预算到点就取消且不换线路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOX = 'https://api5-normal-sinfonlineb.fqnovel.com';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface RecordedCall {
  url: string;
  method: string;
  body: any;
  deadline: number;
  signal: AbortSignal;
}

const state = vi.hoisted(() => ({
  respond: null as unknown as (call: RecordedCall, count: number) => unknown,
  calls: [] as RecordedCall[],
  values: [] as Record<string, any>[],
}));

// catalog 只通过 ticket 的签名/传输两个入口与外界接触；把这两个换成夹具，
// 签名本身（x-gorgon/x-medusa 等）已在 ticket.test.ts 覆盖。
vi.mock('./ticket.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    signedMetadataRequest: (apiPath: string, values: any, body: any) => {
      state.values.push(clone(values ?? {}));
      return {
        url: `${BOX}${apiPath}`,
        headers: {},
        body: body == null ? null : Buffer.from(JSON.stringify(body)),
      };
    },
    requestJson: (url: string, options: any, deadline: number, signal: AbortSignal) => {
      const call: RecordedCall = {
        url,
        method: options.method,
        body: options.data ? JSON.parse(String(options.data)) : null,
        deadline,
        signal,
      };
      state.calls.push(call);
      return Promise.resolve(state.respond(call, state.calls.length));
    },
  };
});

type Browse = (options?: any) => Promise<any>;

/** 目录会话是模块级状态：每条用例都拿一份干净模块。 */
async function fixture(respond: (call: RecordedCall, count: number) => unknown = () => categoryPayload()) {
  vi.resetModules();
  state.respond = respond;
  state.calls = [];
  state.values = [];
  const module = await import('./catalog.ts');
  return { browse: module.browseList as Browse, catalogCover: module.catalogCover };
}

const video = (id = '7697209269287914521') => ({
  series_id: id,
  title: '<b>测试</b> &amp; 剧',
  cover: 'https://img.example/cover.jpg',
  episode_cnt: 100,
  video_desc: '完整简介',
  content_type: 1004,
  sub_title_list: [{ content: '脑洞' }],
});

const categoryPayload = (id?: string, next = 37, more = true, contentType = 1) => ({
  code: 0,
  data: {
    video_data: [{ ...video(id), content_type: contentType }],
    has_more: more,
    next_offset: next,
    session_id: 'fixture-session',
    selector_rows: [
      {
        type: 'category_dim_theme',
        items: [
          { selector_item_id: 'cate_165', show_name: '悬疑' },
          { selector_item_id: 'cate_1219', show_name: '恐怖' },
        ],
      },
      { type: 'category_dim_role', items: [{ selector_item_id: 'cate_36', show_name: '重生' }] },
    ],
  },
});

const RANKS: Record<string, [string, string]> = {
  'hot-drama': ['all', 'ranklist_hot_play_sc'],
  'hot-real-drama': ['human', 'human_hot_play'],
  'hot-comic-drama': ['comic_series_rank', 'comic_series_hot_play'],
  'hot-ai-drama': ['ai_playlet', 'ai_playlet_hot_play'],
};

const rankPayload = (category: string, more = true) => ({
  code: 0,
  data: {
    has_more: more,
    next_offset: 29,
    session_id: 'rank-session',
    cell_view: {
      cell_data: [{ video_data: { ...video(), content_type: category === 'hot-real-drama' ? 1 : 1004 } }],
      cell_selector: {
        outer_row: {
          items: [
            {
              selector_item_id: RANKS[category]?.[0],
              is_selected: true,
              sub_cell_selector: {
                outer_row: { items: [{ selector_item_id: RANKS[category]?.[1], is_selected: true }] },
              },
            },
          ],
        },
      },
    },
  },
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('目录会话作用域', () => {
  it('消费者作用域各自持有游标，刷新默认作用域不影响浏览页', async () => {
    const { browse } = await fixture((call) => categoryPayload('7000001', call.body.offset + 15));
    await browse({ catalogScope: 'browse' });
    await browse({ catalogScope: 'browse', page: 2 });
    await browse({ forceRefresh: true });
    expect((await browse({ catalogScope: 'browse', page: 3 })).success).toBe(true);
  });

  it('未知作用域在发请求前就被拒（不能借机建会话）', async () => {
    const { browse } = await fixture();
    for (const catalogScope of ['arbitrary', {}, 123]) {
      const result = await browse({ catalogScope });
      expect(result.code, String(catalogScope)).toBe('APP_INPUT');
    }
    expect(state.calls).toHaveLength(0);
  });
});

describe('封面只换已验证的 JPEG 对象变体', () => {
  it('HEIC 换成 p3-novel.byteimg.com 的 640 宽 JPEG，其余地址原样或留空', async () => {
    const { catalogCover } = await fixture();
    const cases: Array<[string, string]> = [
      [
        'https://p3-reading-sign.fqnovelpic.com/novel-pic/object123~tplv-example:400:0.heic?x-signature=fixture',
        'https://p3-novel.byteimg.com/novel-pic/object123~tplv-shrink:640:0.image',
      ],
      [
        'https://user:password@p3-novel.byteimg.com/novel-pic/object456~original.HEIC?token=fixture#image',
        'https://p3-novel.byteimg.com/novel-pic/object456~tplv-shrink:640:0.image',
      ],
      [
        'https://fqnovelpic.com/novel-pic/object789~original.heic',
        'https://p3-novel.byteimg.com/novel-pic/object789~tplv-shrink:640:0.image',
      ],
      ['https://unknown.example/novel-pic/object~original.heic', ''],
      ['https://notfqnovelpic.com/novel-pic/object~original.heic', ''],
      ['https://fqnovelpic.com.evil.example/novel-pic/object~original.heic', ''],
      ['https://p3-novel.byteimg.com/other/object~original.heic', ''],
      ['https://p3-novel.byteimg.com/novel-pic/object.heic', ''],
      ['ftp://p3-novel.byteimg.com/novel-pic/object~original.heic', ''],
      [
        'https://img.example/ordinary.jpg?signature=fixture',
        'https://img.example/ordinary.jpg?signature=fixture',
      ],
    ];
    for (const [cover, expected] of cases) {
      expect(catalogCover(cover), cover).toBe(expected);
    }
  });

  it('同一份封面规则在浏览结果里生效', async () => {
    const { browse } = await fixture(() => {
      const payload = categoryPayload();
      payload.data.video_data[0].cover =
        'https://p3-reading-sign.fqnovelpic.com/novel-pic/object999~tplv-example:400:0.heic';
      return payload;
    });
    const result = await browse({});
    expect(result.success).toBe(true);
    expect(result.results[0].cover).toBe(
      'https://p3-novel.byteimg.com/novel-pic/object999~tplv-shrink:640:0.image',
    );
  });
});

describe('分类请求与元数据', () => {
  it('三个分类用各自的场景与动态题材，元数据如实', async () => {
    for (const [category, scene, genre] of [
      ['real-drama', 'default', 'short_play'],
      ['comic-drama', 'comic_series', 'comic_series'],
      ['ai-drama', 'ai_series', 'ai_series'],
    ] as const) {
      const { browse } = await fixture(() =>
        categoryPayload(undefined, 37, true, category === 'real-drama' ? 1 : 1004),
      );
      const result = await browse({ category });
      expect(result.success, result.error).toBe(true);
      expect(state.calls[0].body.req_scene).toBe(scene);
      expect(state.calls[0].body.select_items.genre).toEqual([genre]);
      expect(state.calls[0].body.need_selector_panel).toBe(true);
      expect(result.genres).toEqual([
        { slug: 'cate_165', label: '悬疑' },
        { slug: 'cate_1219', label: '恐怖' },
      ]);
      expect(result.results[0]).toMatchObject({
        series_id: '7697209269287914521',
        series_title: '测试 & 剧',
        description: '完整简介',
        completion_status: 'unknown',
      });
      // 上游没给总数与每页条数：不许编造。
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
      expect('session_id' in result).toBe(false);
      expect('cursor' in result).toBe(false);
      await browse({ category, genre: 'cate_1219' });
      expect(state.calls[1].body.select_items.category_dim_theme).toEqual(['cate_1219']);
      expect(state.calls[1].body.select_items.category_dim_role).toEqual([]);
    }
  });
});

describe('榜单', () => {
  it('四个榜单选中各自的显式热播榜，且只走 cell/change 接口', async () => {
    for (const category of Object.keys(RANKS)) {
      const { browse } = await fixture(() => rankPayload(category));
      expect((await browse({ category })).success).toBe(true);
      expect(state.values[0].selected_items).toBe(RANKS[category]![0]);
      expect(state.values[0].sub_selected_items).toBe(RANKS[category]![1]);
      expect(state.values[0].tab_type).toBe('26');
      expect(state.calls[0].url).toMatch(/bookmall\/cell\/change\/v$/);
    }
  });

  it('上游返回别的榜单、演员榜或错误内容类型时失败', async () => {
    const wrongRank = await fixture(() => rankPayload('hot-real-drama'));
    expect((await wrongRank.browse({ category: 'hot-ai-drama' })).success).toBe(false);

    for (const cell of [
      { ugc_user_data: [{ user_info: { base_info: { actor_id: '1234567' } } }] },
      { video_data: { ...video(), content_type: 2 } },
    ]) {
      const { browse } = await fixture(() => {
        const payload = rankPayload('hot-drama');
        payload.data.cell_view.cell_data = [cell as never];
        return payload;
      });
      expect((await browse({ category: 'hot-drama' })).success).toBe(false);
    }
  });

  it('综合榜保留真人剧；每个分类只接受自己的内容类型', async () => {
    const { browse } = await fixture(() => {
      const payload = rankPayload('hot-drama');
      payload.data.cell_view.cell_data = [
        { video_data: [{ ...video('7000001'), content_type: 1 }, video('7000002')] },
      ] as never;
      return payload;
    });
    const mixed = await browse({ category: 'hot-drama' });
    expect(mixed.success, mixed.error).toBe(true);
    expect(mixed.results.map((item: any) => item.series_id).join(',')).toBe('7000001,7000002');

    const cases: Array<[string, number | undefined]> = [
      ['real-drama', 1004],
      ['comic-drama', 1],
      ['ai-drama', 1],
      ['hot-real-drama', 1004],
      ['hot-comic-drama', 1],
      ['hot-ai-drama', 1],
      ['hot-drama', 99],
      ['hot-drama', undefined],
    ];
    for (const [category, type] of cases) {
      const wrong = await fixture(() => {
        const payload: any = RANKS[category] ? rankPayload(category) : categoryPayload();
        const target = RANKS[category]
          ? payload.data.cell_view.cell_data[0].video_data
          : payload.data.video_data[0];
        (target as any).content_type = type;
        return payload;
      });
      expect((await wrong.browse({ category })).success, `${category} / ${type}`).toBe(false);
    }
  });
});

describe('分页游标', () => {
  it('第 1 页之前没有游标就不发请求；之后只用服务端游标并记住已收题材', async () => {
    const { browse } = await fixture((_call, count) => {
      const payload = categoryPayload(String(7000000 + count), count === 1 ? 37 : 83);
      if (count > 1) payload.data.selector_rows = [];
      return payload;
    });
    expect((await browse({ page: 2 })).success).toBe(false);
    expect(state.calls).toHaveLength(0);
    const first = await browse({ page: 1 });
    const second = await browse({ page: 2 });
    expect(second.success, second.error).toBe(true);
    expect(state.calls[1].body.offset).toBe(37);
    expect(state.calls[1].body.session_id).toBe('fixture-session');
    expect(state.calls[1].body.need_selector_panel).toBe(false);
    // only_content 不重复下发题材面板，但已收到的题材必须还在。
    expect(second.genres).toHaveLength(2);
    expect(await browse({ page: 1 })).toEqual(first);
    expect(state.calls).toHaveLength(2);
  });

  it('榜单第 2 页复用服务端 session 并换 tab_type', async () => {
    const { browse } = await fixture((_call, count) => {
      const payload = rankPayload('hot-drama');
      payload.data.next_offset = count * 29;
      return payload;
    });
    await browse({ category: 'hot-drama' });
    expect((await browse({ category: 'hot-drama', page: 2 })).success).toBe(true);
    expect(state.values[1].offset).toBe('29');
    expect(state.values[1].tab_type).toBe('18');
    expect(state.values[1].session_id).toBe('rank-session');
  });
});

describe('刷新语义', () => {
  it('派发前刷新只取消旧请求一次；刷新老页会丢掉后续游标', async () => {
    const { browse } = await fixture((_call, count) => categoryPayload(String(7000000 + count), count * 37));
    const first = browse({});
    const refresh = browse({ forceRefresh: true });
    const [old, current] = await Promise.all([first, refresh]);
    expect(old.success).toBe(false);
    expect(current.success).toBe(true);
    expect(state.calls).toHaveLength(1);

    await browse({ page: 2 });
    await browse({ page: 3 });
    await browse({ page: 2, forceRefresh: true });
    expect((await browse({ page: 4 })).success).toBe(false);
  });

  it('并发请求去重，第 1 页刷新让旧游标失效', async () => {
    let release: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const { browse } = await fixture((_call, count) => (count === 1 ? slow : categoryPayload('7000009', 61)));
    const first = browse({});
    const duplicate = browse({});
    await Promise.resolve();
    expect(state.calls).toHaveLength(1);

    const refreshed = await browse({ forceRefresh: true });
    expect(refreshed.success).toBe(true);
    expect(state.calls[0]!.signal.aborted).toBe(true);

    release(categoryPayload('7000001', 37));
    await Promise.all([first, duplicate]);
    expect((await browse({})).results[0].series_id).toBe('7000009');
    await browse({ page: 2 });
    expect(state.calls.at(-1)!.body.offset).toBe(61);
    await browse({ forceRefresh: true });
    expect((await browse({ page: 3 })).success).toBe(false);
  });
});

describe('会话上界与失败面', () => {
  it('第 1 页常驻，会话数有上限且不猜游标', async () => {
    const { browse } = await fixture((call) => {
      const payload = categoryPayload(undefined, call.body.offset + 37);
      const themes = call.body.select_items.category_dim_theme as string[];
      if (themes.length)
        payload.data.selector_rows[0]!.items.push({
          selector_item_id: themes[0]!,
          show_name: '动态主题',
        });
      return payload;
    });
    for (let page = 1; page <= 10; page++) expect((await browse({ page })).success).toBe(true);
    await browse({ page: 1 });
    expect(state.calls, '保留第 1 页不会悄悄新开会话').toHaveLength(10);
    for (let i = 0; i < 33; i++) await browse({ genre: `cate_${2000 + i}` });
    expect((await browse({ page: 2 })).success, '被淘汰的会话没有可猜的游标').toBe(false);
  });

  it('TTL、输入与响应错误都不会造出猜测页或重试循环', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1000);
    const { browse } = await fixture();
    await browse({});
    vi.advanceTimersByTime(120001);
    expect((await browse({ page: 2 })).success).toBe(false);
    await browse({});
    expect(state.calls).toHaveLength(2);

    for (const options of [
      { category: 'actor' },
      { genre: 'comeback' },
      { genre: '../outside' },
      { page: 0 },
      { page: 51 },
      { page: 1.5 },
      { category: 'hot-drama', genre: 'cate_165' },
    ]) {
      expect((await browse(options)).success, JSON.stringify(options)).toBe(false);
    }
    expect(state.calls).toHaveLength(2);

    const comic = await browse({ category: 'comic' });
    expect(comic.unsupported).toBe(true);
    expect(state.calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('异常响应一律失败，错误里指向官网且只请求一次', async () => {
    for (const payload of [
      null,
      {},
      { code: 1 },
      { code: 0, data: {} },
      // 数字型 series_id 超出安全整数范围：宁可丢掉这张卡，也不能悄悄改成别的编号。
      {
        code: 0,
        data: {
          video_data: [{ ...video(), content_type: 1, series_id: Number.MAX_SAFE_INTEGER + 2 }],
        },
      },
    ]) {
      const { browse } = await fixture(() => payload);
      const result = await browse({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/官网/);
      expect(state.calls).toHaveLength(1);
    }
  });

  it('4 秒预算到点取消传输，不换线路也不留计时器', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1000);
    const { browse } = await fixture(() => new Promise(() => {}));
    const pending = browse({});
    await Promise.resolve();
    expect(state.calls[0]!.deadline).toBe(5000);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/超时.*官网/);
    expect(state.calls[0]!.signal.aborted).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
