/**
 * App 搜索通道（迁移自 4.5 `scripts/check-app-search-ipc.cjs` 的分页部分）。
 *
 * 旧检查在 IPC 层压的是「channel 必须钉在 App 上：翻页要带同一份游标、页码非法先拒、
 * 第 50 页收口」。5.0 里这段钉在 `searchApp` 上，这里用真实 loopback HTTP 压它，
 * 设备身份用替身注册（注册地址是外网固定域名，本机无法真连）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 只替身「设备注册接口」；签名、分页、解析全走生产代码。
vi.mock('./ticket.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ticket.ts')>();
  return {
    ...actual,
    requestJson: async () => ({
      code: 0,
      device_id_str: '700000000000000001',
      install_id_str: '700000000000000002',
      cdid: '00000000-0000-4000-8000-000000000001',
    }),
  };
});

const { searchApp } = await import('./search.ts');

let server: http.Server;
let port = 0;
let payload: unknown = null;
let hits = 0;
let signedUrls: string[] = [];

function searchPayload(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    search_tabs: [
      {
        tab_type: 11,
        search_id: 'sid',
        passback: 'pb',
        next_offset: 20,
        has_more: true,
        data: [
          // 表头/广告位没有 video_data；book_id 不是短剧编号。
          { cell_name: '广告位', book_id: '99999999' },
          {
            video_data: [
              {
                series_id: '2000002',
                title: '测试剧&amp;第二页',
                series_cover: 'https://example.com/cover.heic',
                episode_cnt: 12,
              },
            ],
          },
          { video_data: [] },
        ],
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  payload = searchPayload();
  hits = 0;
  signedUrls = [];
});

/** 真实 loopback HTTP：签名后的地址被记录下来，响应体走真实传输。 */
async function request(signed: { url: string }) {
  signedUrls.push(signed.url);
  const response = await fetch(`http://127.0.0.1:${port}/app/search`);
  return response.json();
}

const params = () => new URL(signedUrls[signedUrls.length - 1]).searchParams;

describe('App 搜索：游标钉在通道上', () => {
  it('第一页：解析结果、清洗标题、HEIC 封面置空、跳过广告位', async () => {
    const result = (await searchApp('测试剧', { request, deadline: Date.now() + 5_000 })) as any;
    expect(hits).toBe(1);
    expect(result).toMatchObject({ success: true, channel: 'app', page: 1, hasMore: true, nextPage: 2 });
    expect(result.results).toEqual([
      expect.objectContaining({
        series_id: '2000002',
        series_title: '测试剧&第二页',
        cover: '',
        episode_count: 12,
        source: 'hongguo',
      }),
    ]);
    expect(result.cursor).toEqual({ search_id: 'sid', passback: 'pb', next_offset: 20 });
    expect(params().get('query')).toBe('测试剧');
    expect(params().get('offset')).toBe('0');
  });

  it('第二页：游标原样回传，偏移取游标里的 next_offset', async () => {
    const result = (await searchApp('测试剧', {
      page: 2,
      cursor: { search_id: 'sid', passback: 'pb', next_offset: 20 },
      request,
      deadline: Date.now() + 5_000,
    })) as any;
    expect(result.page).toBe(2);
    expect(hits).toBe(1);
    expect(params().get('search_id')).toBe('sid');
    expect(params().get('passback')).toBe('pb');
    expect(params().get('offset')).toBe('20');
  });

  it('翻页偏移优先取游标里的 next_offset，而不是页码推算值', async () => {
    await searchApp('测试剧', {
      page: 2,
      cursor: { next_offset: 40 },
      request,
      deadline: Date.now() + 5_000,
    });
    expect(params().get('offset')).toBe('40');
  });

  it('第 50 页收口：上游就算还有更多也不再翻', async () => {
    const result = (await searchApp('测试剧', {
      page: 50,
      cursor: { search_id: 'sid', next_offset: 980 },
      request,
      deadline: Date.now() + 5_000,
    })) as any;
    expect(result.page).toBe(50);
    expect(result.hasMore).toBe(false);
    expect(result.nextPage).toBeNull();
  });

  it('上游 has_more 为假时不编造下一页', async () => {
    payload = searchPayload();
    (payload as any).search_tabs[0].has_more = false;
    const result = (await searchApp('测试剧', { request, deadline: Date.now() + 5_000 })) as any;
    expect(result.hasMore).toBe(false);
    expect(result.nextPage).toBeNull();
  });
});

describe('App 搜索：非法输入与预算先在本地拦下', () => {
  it('非法页码直接拒绝，且不发出请求', async () => {
    for (const page of [0, 51, -1, 2.5, 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        searchApp('测试剧', { page, request, deadline: Date.now() + 5_000 }),
        String(page),
      ).rejects.toMatchObject({ code: 'APP_INPUT' });
    }
    expect(hits).toBe(0);
    expect(signedUrls).toEqual([]);
  });

  it('空关键词与超长关键词拒绝，不发请求', async () => {
    await expect(searchApp('  ', { request })).rejects.toMatchObject({ code: 'APP_INPUT' });
    await expect(searchApp('红'.repeat(81), { request })).rejects.toMatchObject({ code: 'APP_INPUT' });
    expect(signedUrls).toEqual([]);
  });

  it('第二页没有游标时拒绝，不发请求（不能静默回到第一页）', async () => {
    await expect(
      searchApp('测试剧', { page: 2, cursor: null, request, deadline: Date.now() + 5_000 }),
    ).rejects.toMatchObject({ code: 'APP_CURSOR' });
    expect(signedUrls).toEqual([]);
  });

  it('预算已用尽时直接超时，不发请求', async () => {
    await expect(searchApp('测试剧', { request, deadline: Date.now() - 1 })).rejects.toMatchObject({
      code: 'APP_TIMEOUT',
    });
    expect(signedUrls).toEqual([]);
  });
});

describe('App 搜索：响应结构异常要说清是哪种异常', () => {
  it('正常空结果仍然是成功的空列表', async () => {
    payload = searchPayload();
    (payload as any).search_tabs[0].data = [{ cell_name: '无结果' }];
    const result = (await searchApp('测试剧', { request, deadline: Date.now() + 5_000 })) as any;
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
  });

  it('业务错误码、缺短剧 tab、结构异常各有独立错误码', async () => {
    payload = { code: 10001 };
    await expect(searchApp('测试剧', { request })).rejects.toMatchObject({ code: 'APP_BUSINESS' });
    payload = { code: 0, search_tabs: [{ tab_type: 7 }] };
    await expect(searchApp('测试剧', { request })).rejects.toMatchObject({ code: 'APP_TAB_MISSING' });
    payload = { code: 0 };
    await expect(searchApp('测试剧', { request })).rejects.toMatchObject({ code: 'APP_SCHEMA' });
    payload = null;
    await expect(searchApp('测试剧', { request })).rejects.toMatchObject({ code: 'APP_EMPTY' });
  });
});
