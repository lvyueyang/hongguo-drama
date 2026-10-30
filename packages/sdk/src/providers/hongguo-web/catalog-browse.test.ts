/**
 * 官网目录浏览（迁移自 4.5 `scripts/check-catalog.cjs`）。
 *
 * 夹具是**真实 loopback HTTP**（node:http + 127.0.0.1）：注入的只是 Electron `net` 适配层，
 * 传输、状态码、分块、超时中止都走真 socket。覆盖四组不变量：
 *   1) 传输隔离：公开目录不带登录 Cookie、必须重新验证缓存、代理认证交回主进程；
 *   2) 每条 URL 各自成请求：挂起的漫画页不能阻塞真人剧，同 URL 并发合并为一次；
 *   3) 只有能解析出内容的页面才算成功：快而无效的页面不能取消有效线路；
 *   4) 边界与失败：超大页面、HTTP 错误、连接重置、超时、结构缺失都要有可读失败。
 *
 * 旧检查里「主进程再包一层 10 秒超时 / DNS 预热路由」两条随实现消失：5.0 的目录只有
 * `browseList` 自己一次 10 秒预算，主进程不再重开计时，也没有 warmOfficialDns 接线。
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browseList, setNetTransport } from './catalog.ts';

const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const catalogItem = (id = '1234567890123456789', name = '示例剧') => ({
  series_id: id,
  series_name: name,
  series_cover: 'https://example.com/cover.jpg',
  episode_cnt: 77,
  episode_right_text: '全77集',
  tags: ['爱情'],
});

const ssrHtml = (category: string, page = 1, list?: unknown[]) =>
  `<script>_ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      category_$: {
        isSuccess: true,
        categoryRoute: { contentType: category },
        seo: { title: '目录 } ; 测试' },
        recommendList: list ?? [catalogItem()],
        pagination: { pageNum: page, total: 800, totalPages: 34 },
        selectorList: [{ items: [{ selector_item_id: 'romance', show_name: '爱情' }] }],
      },
    },
  })};function runWindowFn(){throw Error('远程脚本不得执行')}</script>`;

const RANKING_HTML =
  '<article><h2 id="rank-title-1234567">热播测试</h2><a href="/detail?series_id=1234567">详情</a><span>1</span></article>';

let server: http.Server;
let port = 0;
let stalls: http.ServerResponse[] = [];
let hits: string[] = [];
let loginAuth: unknown = null;

const pageOf = (url: URL) => Number(url.searchParams.get('page')) || 1;

/** 等一个真实事件循环条件成立（配合只伪造计时器的 fake timers 使用，不能依赖 Date）。 */
async function until(predicate: () => boolean, attempts = 5_000) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('等待条件超时');
}

/** 让真实 I/O 走几轮（fake timers 下 setImmediate 仍是真实的）。 */
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const page = pageOf(url);
    hits.push(`${url.pathname}?page=${page}`);
    const send = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (url.pathname === '/rank/hot-drama') {
      if (page === 3) return void stalls.push(res); // 挂起
      if (page === 5) return send('<html>CDN 错误页</html>'); // 快而无效
      return send(RANKING_HTML);
    }
    if (url.pathname === '/category/comic') {
      if (page === 9) return void stalls.push(res);
      return send(ssrHtml('comic'));
    }
    if (url.pathname === '/category/comic-drama') {
      if (page === 2) return void stalls.push(res);
      return send(ssrHtml('comic-drama', page, [catalogItem('7000001', '漫剧一')]));
    }
    if (url.pathname === '/category/real-drama' || url.pathname.startsWith('/category/real-drama/')) {
      if (page === 2 && !url.pathname.endsWith('/romance')) return void stalls.push(res);
      if (url.pathname.endsWith('/romance'))
        return send(ssrHtml('real-drama', page, [catalogItem('9000001', '爱情剧')]));
      if (page === 6) return send('<html><body>没有目录数据</body></html>');
      return send(ssrHtml('real-drama', page));
    }
    if (url.pathname === '/category/ai-drama') {
      if (page === 1) return void stalls.push(res); // 挂起 → 超时
      if (page === 2) {
        // 声明过大的 Content-Length，正文不写完。
        res.writeHead(200, { 'content-length': String(MAX_PAGE_BYTES + 1) });
        res.write('x');
        return void stalls.push(res);
      }
      if (page === 3) {
        res.writeHead(200, { 'content-type': 'text/html' });
        for (let i = 0; i < 8; i++) res.write(Buffer.alloc(1024 * 1024));
        res.write(Buffer.alloc(1));
        return void stalls.push(res);
      }
      if (page === 4) return send('unavailable', 503);
      if (page === 5) return void req.socket.destroy();
      if (page === 6) return send('<html><body>没有目录数据</body></html>');
      return send(ssrHtml('ai-drama', page));
    }
    send('<html><body>unknown route</body></html>', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Recorded = { url: string; options: any; aborted: boolean };

/** Electron `net` 的替身：把官方地址映射到 loopback，其余照真 HTTP 走。 */
class LoopbackNet {
  records: Recorded[] = [];
  aborted = 0;
  auth: unknown = null;
  credentials: { user?: string; password?: string } = {};
  emitLogin = false;

  request(options: any) {
    const record: Recorded = { url: options.url, options, aborted: false };
    this.records.push(record);
    const target = new URL(options.url);
    const request = new EventEmitter() as any;
    let pending: http.ClientRequest | null = null;
    let response: http.IncomingMessage | null = null;
    request.abort = () => {
      record.aborted = true;
      this.aborted += 1;
      response?.destroy();
      pending?.destroy();
    };
    request.end = () => {
      if (this.emitLogin) {
        queueMicrotask(() =>
          request.emit('login', { isProxy: true, host: '127.0.0.1', port: 1234 }, (user, password) => {
            this.credentials = { user, password };
          }),
        );
      }
      pending = http.request(
        { host: '127.0.0.1', port, path: `${target.pathname}${target.search}` },
        (incoming) => {
          response = incoming;
          const wrapped = new EventEmitter() as any;
          wrapped.statusCode = incoming.statusCode;
          wrapped.headers = incoming.headers;
          for (const event of ['data', 'end', 'error', 'aborted'] as const) {
            incoming.on(event, (payload?: unknown) => wrapped.emit(event, payload));
          }
          request.emit('response', wrapped);
        },
      );
      pending.on('error', (error) => request.emit('error', error));
      pending.end();
    };
    return request;
  }
}

let net = new LoopbackNet();

beforeEach(() => {
  net = new LoopbackNet();
  setNetTransport(net as never);
  stalls = [];
  hits = [];
  loginAuth = null;
});

afterEach(() => {
  setNetTransport(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('目录传输：复用系统代理的 Chromium 网络层，但不带登录态', () => {
  it('公开目录请求不携带站点 Cookie，且强制重新验证缓存', async () => {
    const result = (await browseList({ category: 'real-drama' })) as any;
    expect(result.success).toBe(true);
    expect(net.records[0].url).toBe('https://hongguoduanju.com/category/real-drama');
    expect(net.records[0].options.useSessionCookies).toBe(false);
    expect(net.records[0].options.headers['Cache-Control']).toBe('no-cache');
    // 允许代理认证（login 事件），但不通过 credentials 打开站点 Cookie。
    expect(net.records[0].options.credentials).toBeUndefined();
    expect(JSON.stringify(net.records[0].options.headers)).not.toMatch(/cookie|authorization/i);
  });

  it('没有允许可信 DNS 时不会偷偷改走直连线路', async () => {
    const get = vi.spyOn(axios, 'get');
    await browseList({ category: 'real-drama', page: 12 });
    expect(get).not.toHaveBeenCalled();
    expect(net.records).toHaveLength(1);
  });

  it('未注入 Chromium 传输时回退 axios，仍带 10 秒超时与取消信号', async () => {
    setNetTransport(null);
    const get = vi.spyOn(axios, 'get').mockImplementation((async (_url: string, options: any) => {
      expect(options.timeout).toBe(10_000);
      expect(options.maxContentLength).toBe(MAX_PAGE_BYTES);
      expect(options.signal).toBeTruthy();
      return { data: ssrHtml('real-drama', 13) };
    }) as never);
    const result = (await browseList({ category: 'real-drama', page: 13 })) as any;
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('代理认证交回主进程匹配，凭据来自主进程而不是页面', async () => {
    net.emitLogin = true;
    const result = (await browseList({ category: 'real-drama', forceRefresh: true }, (auth, callback) => {
      loginAuth = auth;
      callback('fixture-user', 'fixture-pass');
    })) as any;
    expect(result.success).toBe(true);
    expect(loginAuth).toMatchObject({ isProxy: true, host: '127.0.0.1', port: 1234 });
    expect(net.credentials).toEqual({ user: 'fixture-user', password: 'fixture-pass' });
  });
});

describe('目录解析与路由', () => {
  it('分类页：SSR 内嵌数据解析（含字符串里的花括号）、题材、分页、完结状态', async () => {
    const result = (await browseList({ category: 'real-drama' })) as any;
    expect(result.success).toBe(true);
    expect(result.pageTitle).toBe('目录 } ; 测试');
    expect(result.totalPages).toBe(34);
    expect(result.genres).toEqual([{ slug: 'romance', label: '爱情' }]);
    expect(result.results[0]).toMatchObject({
      series_id: '1234567890123456789',
      series_title: '示例剧',
      episode_count: 77,
      completion_status: 'completed',
      episode_label: '全77集',
    });
  });

  it('榜单路由：hot-drama 走 /rank/ 并且在载荷缺失时用语义标题兜底', async () => {
    const result = (await browseList({ category: 'hot-drama' })) as any;
    expect(result.success).toBe(true);
    expect(hits).toEqual(['/rank/hot-drama?page=1']);
    expect(result.results[0]).toMatchObject({
      series_id: '1234567',
      series_title: '热播测试',
      rank: 1,
    });
  });

  it('题材 + 分页拼在 URL 上，页码按页面数据回填', async () => {
    const result = (await browseList({ genre: 'romance', page: 2 })) as any;
    expect(hits).toEqual(['/category/real-drama/romance?page=2']);
    expect(result.page).toBe(2);
    expect(result.results[0].series_title).toBe('爱情剧');
  });

  it('漫画是图文，不转成视频卡片；漫剧仍然是视频', async () => {
    const comic = (await browseList({ category: 'comic' })) as any;
    expect(comic.results).toEqual([]);
    expect(comic.unsupported).toBe(true);
    expect(String(comic.emptyMessage)).toMatch(/图文|图片/);
    const animation = (await browseList({ category: 'comic-drama' })) as any;
    expect(animation.unsupported).toBeUndefined();
    expect(animation.results).toHaveLength(1);
  });

  it('无效分类或题材（含榜单 + 题材组合）在发请求前拒绝', async () => {
    for (const options of [
      { category: '../../outside' },
      { category: 'not-a-category' },
      { genre: '../etc' },
      { category: 'hot-drama', genre: 'romance' },
    ]) {
      const result = (await browseList(options)) as any;
      expect(result.success, JSON.stringify(options)).toBe(false);
    }
    expect(net.records).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('结构缺失的页面是失败，不是成功空态', async () => {
    const result = (await browseList({ category: 'ai-drama', page: 6 })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/目录数据/);
  });
});

describe('目录并发与缓存', () => {
  it('挂起的漫画页不阻塞真人剧；同 URL 并发合并为一次请求', async () => {
    const comic = browseList({ category: 'comic', page: 9 });
    const [real, same] = await Promise.all([
      browseList({ category: 'real-drama', page: 8 }),
      browseList({ category: 'real-drama', page: 8 }),
    ]);
    expect((real as any).success).toBe(true);
    expect((real as any).results[0].series_id).toBe('1234567890123456789');
    expect(same).toEqual(real);
    expect(hits.filter((hit) => hit.startsWith('/category/real-drama'))).toHaveLength(1);
    // 漫画页现在才返回：它自始至终没有挡住真人剧。
    stalls.forEach((response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(ssrHtml('comic'));
    });
    const comicResult = (await comic) as any;
    expect(comicResult.results).toEqual([]);
    expect(comicResult.unsupported).toBe(true);
  });

  it('短缓存复用；forceRefresh 跳过缓存', async () => {
    await browseList({ category: 'real-drama', page: 11 });
    await browseList({ category: 'real-drama', page: 11 });
    expect(hits).toHaveLength(1);
    await browseList({ category: 'real-drama', page: 11, forceRefresh: true });
    expect(hits).toHaveLength(2);
  });
});

describe('目录失败面：每条都要有可读结果', () => {
  it('HTTP 503 如实报错', async () => {
    const result = (await browseList({ category: 'ai-drama', page: 4 })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/503/);
  });

  it('连接被重置时提示切换来源，并带上错误码', async () => {
    const result = (await browseList({ category: 'ai-drama', page: 5 })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/切换来源/);
  });

  it('声明过大的页面直接拒绝，不等正文', async () => {
    const result = (await browseList({ category: 'ai-drama', page: 2 })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/过大/);
  });

  it('没有 Content-Length 的超大响应也拒绝，并中止请求', async () => {
    const result = (await browseList({ category: 'ai-drama', page: 3 })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/过大/);
    expect(net.aborted).toBeGreaterThan(0);
  });

  it('超时中止请求，且迟到的响应不会把结果改成功', async () => {
    // 只伪造计时器与时钟：真正的 socket I/O 仍需真实事件循环。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = browseList({ category: 'ai-drama', page: 1 });
    await until(() => stalls.length > 0);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = (await pending) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/超时/);
    expect(net.aborted).toBeGreaterThan(0);
    const before = hits.length;
    const stalled = stalls.at(-1)!;
    stalled.write(ssrHtml('ai-drama', 1));
    stalled.end();
    await settle();
    // 迟到页面既不改结果，也不触发新请求。
    expect(hits).toHaveLength(before);
    expect(result.success).toBe(false);
    vi.useRealTimers();
  });
});

describe('可信 DNS 直连与 Chromium 线路赛跑', () => {
  it('快而无效的页面不能取消有效线路', async () => {
    // Chromium 线路立刻返回一个 HTTP 200 的错误页；可信 DNS 线路稍后返回真页面。
    const get = vi.spyOn(axios, 'get').mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: RANKING_HTML };
    }) as never);
    const result = (await browseList({
      category: 'hot-drama',
      page: 5,
      allowTrustedDns: true,
      forceRefresh: true,
    })) as any;
    expect(get).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.results[0].series_title).toBe('热播测试');
  });

  it('Chromium 线路挂起时由可信 DNS 线路胜出，并中止被放弃的请求', async () => {
    vi.spyOn(axios, 'get').mockImplementation((async () => ({ data: RANKING_HTML })) as never);
    // 让 Chromium 线路打在挂起的页面上（/rank/hot-drama?page=3）。
    const result = (await browseList({
      category: 'hot-drama',
      page: 3,
      allowTrustedDns: true,
      forceRefresh: true,
    })) as any;
    expect(result.success).toBe(true);
    expect(result.results[0].series_title).toBe('热播测试');
    expect(net.aborted).toBeGreaterThan(0);
    expect(loginAuth).toBeNull();
  });
});
