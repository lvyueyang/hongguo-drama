/**
 * 红果官网搜索接口（迁移自 4.5 `scripts/check-hongguo-search-ipc.cjs` 的接口层）。
 *
 * 旧检查压的是「接口优先 → 结构变化才回退页面 → 超时不再等页面」这条链路。
 * 5.0 不再有隐藏窗口嗅探（页面兜底整段随实现消失），但**驱动那条链路的判断依据**还在：
 * 错误被分成 timeout / upstream / format 三类，只有 `fallback: true` 才允许调用方换路子。
 * 所以这里改用真实 loopback HTTP 压接口层：解析、空结果、重试、缓存、以及错误分类。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyRequestError, clearSearchCache, HongguoSearchError, searchHongguo } from './search.ts';

type Scenario = 'list' | 'empty' | 'unrecognized' | 'business-error' | 'null' | 'html';

let server: http.Server;
let port = 0;
let scenario: Scenario = 'list';
let requests: Array<{ query: string; page: string }> = [];

const payloadFor = () => {
  switch (scenario) {
    case 'empty':
      return { searchList: [], totalCount: 0, pageNum: 1, totalPages: 0, hasMore: false };
    case 'unrecognized':
      // 有数据但一条都认不出 = 字段改名，属于解析失败而不是「没有结果」。
      return { searchList: [{ keyword: '字段全没了' }], totalCount: 1 };
    case 'business-error':
      return { code: '10001', message: '内部错误' };
    case 'null':
      return null;
    case 'html':
      return '<html>bad gateway</html>';
    default:
      return {
        searchList: [
          {
            video_data: {
              series_id: '5000002',
              series_name: '官网第二页',
              series_cover: 'https://example.com/cover.jpg',
              episode_cnt: 88,
              tags: ['爱情', '都市'],
            },
          },
        ],
        totalCount: 3,
        pageNum: 2,
        totalPages: 3,
        hasMore: true,
      };
  }
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      query: url.searchParams.get('query') ?? '',
      page: url.searchParams.get('page') ?? '',
    });
    res.setHeader('content-type', scenario === 'html' ? 'text/html' : 'application/json');
    res.end(JSON.stringify(payloadFor()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearSearchCache();
  requests = [];
  scenario = 'list';
});

/** 真实 loopback HTTP：注入的只是「发哪个地址」，解析与重试都走生产代码。 */
async function request(keyword: string, page: number) {
  const url = `http://127.0.0.1:${port}/api/search/result?query=${encodeURIComponent(keyword)}&page=${page}`;
  const response = await fetch(url);
  return response.json();
}

describe('官网接口优先', () => {
  it('按关键词与页码请求接口，并把响应解析成应用内结果', async () => {
    const result = (await searchHongguo('测试剧', { page: 2, request, cache: false })) as any;
    expect(requests).toEqual([{ query: '测试剧', page: '2' }]);
    expect(result.page).toBe(2);
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        series_id: '5000002',
        series_title: '官网第二页',
        cover: 'https://example.com/cover.jpg',
        episode_count: 88,
        tags: ['爱情', '都市'],
      }),
    ]);
  });

  it('接口返回空列表是「成功空结果」，不是错误', async () => {
    scenario = 'empty';
    const result = (await searchHongguo('没有这部剧', { request, cache: false })) as any;
    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('非空但认不出的条目算解析失败，必须标 fallback 而不是伪装成空结果', async () => {
    scenario = 'unrecognized';
    await expect(searchHongguo('测试剧', { request, cache: false })).rejects.toMatchObject({
      kind: 'format',
      fallback: true,
    });
  });

  it('空响应与业务错误属于上游异常，不允许触发换路子', async () => {
    scenario = 'null';
    await expect(searchHongguo('测试剧', { request, cache: false })).rejects.toMatchObject({
      kind: 'upstream',
    });
    scenario = 'business-error';
    const error = await searchHongguo('测试剧', { request, cache: false }).catch((e) => e);
    expect(error).toBeInstanceOf(HongguoSearchError);
    expect(error.kind).toBe('upstream');
    expect(error.fallback).toBeFalsy();
    expect(error.message).toMatch(/内部错误/);
  });

  it('返回网页内容说明接口已不可用，报上游异常', async () => {
    scenario = 'html';
    const error = await searchHongguo('测试剧', { request, cache: false }).catch((e) => e);
    expect(error.kind).toBe('upstream');
    expect(error.fallback).toBeFalsy();
  });
});

describe('预算与重试', () => {
  it('预算已用尽时立刻超时，一个请求都不发（超时后不再等第二次机会）', async () => {
    scenario = 'list';
    const started = Date.now();
    const error = await searchHongguo('测试剧', {
      request,
      cache: false,
      deadline: Date.now() - 1,
    }).catch((e) => e);
    expect(error.kind).toBe('timeout');
    expect(error.fallback).toBeFalsy();
    expect(requests).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('剩余预算不足 1 秒时不再发请求，直接报超时', async () => {
    const error = await searchHongguo('测试剧', {
      request,
      cache: false,
      deadline: Date.now() + 500,
    }).catch((e) => e);
    expect(error.kind).toBe('timeout');
    expect(requests).toEqual([]);
  });

  it('格式变化不重试（等页面兜底更有意义），网络异常才重试一次', async () => {
    scenario = 'unrecognized';
    await searchHongguo('格式变化', { request, cache: false }).catch(() => {});
    const formatAttempts = requests.length;
    expect(formatAttempts).toBe(1);

    requests = [];
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    };
    const error = await searchHongguo('断网', { request: flaky as never, cache: false }).catch((e) => e);
    expect(calls).toBe(2);
    expect(error.kind).toBe('upstream');
  });

  it('超时错误不会被当成「可以换路子」', async () => {
    const timeout = new HongguoSearchError('搜索超时，请稍后重试', 'timeout');
    const error = await searchHongguo('测试剧', {
      request: (async () => {
        throw timeout;
      }) as never,
      cache: false,
      retries: 0,
    }).catch((e) => e);
    expect(error.kind).toBe('timeout');
    expect(error.fallback).toBeFalsy();
    expect(error.message).toMatch(/超时/);
  });
});

describe('短缓存', () => {
  it('同词同页第二次不再请求接口，cache:false 可绕过', async () => {
    await searchHongguo('测试剧', { request, page: 1 });
    await searchHongguo('测试剧', { request, page: 1 });
    expect(requests).toHaveLength(1);
    await searchHongguo('测试剧', { request, page: 1, cache: false });
    expect(requests).toHaveLength(2);
    await searchHongguo('测试剧', { request, page: 2 });
    expect(requests).toHaveLength(3);
  });
});

describe('classifyRequestError：错误分类决定上层走哪条路', () => {
  const axiosError = (patch: Record<string, any>) => Object.assign(new Error('request failed'), patch);

  it('超时类（ECONNABORTED / ETIMEDOUT / HTTP 408）→ timeout，且不允许换路子', () => {
    for (const error of [
      axiosError({ code: 'ECONNABORTED' }),
      axiosError({ code: 'ETIMEDOUT' }),
      axiosError({ response: { status: 408 } }),
    ]) {
      const classified = classifyRequestError(error) as any;
      expect(classified.kind).toBe('timeout');
      expect(classified.fallback).toBeFalsy();
    }
  });

  it('限流与服务端错误 → upstream（由调用方决定是否改用 App 搜索）', () => {
    const throttled = classifyRequestError(axiosError({ response: { status: 429 } })) as any;
    expect(throttled.kind).toBe('upstream');
    expect(throttled.fallback).toBeFalsy();
    expect(throttled.message).toMatch(/频繁/);
    for (const status of [500, 502, 503]) {
      const classified = classifyRequestError(axiosError({ response: { status } })) as any;
      expect(classified.kind).toBe('upstream');
      expect(classified.fallback).toBeFalsy();
      expect(classified.message).toContain(String(status));
    }
  });

  it('4xx 说明接口形态变了 → format 且允许换路子', () => {
    const classified = classifyRequestError(axiosError({ response: { status: 404 } })) as any;
    expect(classified.kind).toBe('format');
    expect(classified.fallback).toBe(true);
  });

  it('普通网络错误 → upstream，消息里带原因', () => {
    const classified = classifyRequestError(
      axiosError({ code: 'ECONNRESET', message: 'socket hang up' }),
    ) as any;
    expect(classified.kind).toBe('upstream');
    expect(classified.message).toMatch(/socket hang up/);
  });
});
