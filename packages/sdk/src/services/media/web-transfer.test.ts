/**
 * 官网片源（`source: 'web'`）的传输身份、重试策略与失效记账。
 *
 * 等价于 4.5 `scripts/check-streaming.cjs` 里「身份与重试」那一组断言：
 * - 官网片源必须带浏览器身份（4.5 里服务端对 UA/Referer 都做校验）；
 * - 官网 404/410/5xx 才翻一次重试，且**第二次请求与第一次逐字段一致**（方法、Range、身份）；
 * - 第三方/未知来源绝不冒充 App 身份去取 Referer；
 * - 只有可重试的失败才标记该集官网片源失效，取消不算。
 *
 * 夹具走 loopback；真实守卫的边界有自己的测试（`internal/net/guard-runtime.test.ts`），这里放行回环地址。
 * 官网页面的取源链路不在这里验证，用模块替身隔离（这是传输层的用例）。
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../internal/net/guard.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const loopback = (url: string) => /127\.0\.0\.1|localhost/.test(String(url));
  return {
    ...actual,
    webMediaRequestOptions: (url: string) => (loopback(url) ? {} : actual.webMediaRequestOptions(url)),
  };
});

const { markFailure } = vi.hoisted(() => ({ markFailure: vi.fn() }));

vi.mock('../../providers/hongguo-web/player.ts', () => ({
  UA: 'app-agent/1.0',
  WEB_UA: 'browser-agent/2.0',
  WEB_REFERER: 'https://hongguoduanju.com/',
  VIDEO_REFERER: 'https://example.invalid/',
  fetchPlayUrlSingle: async () => ({ url: null, error: 'stub' }),
  markWebMediaFailure: markFailure,
}));

const { requestMedia, withMediaRecovery } = await import('./transfer.ts');

interface Recorded {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let base = '';
const requests: Recorded[] = [];
const hitCount = new Map<string, number>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = String(request.url);
    requests.push({ url, method: String(request.method), headers: request.headers });
    hitCount.set(url, (hitCount.get(url) ?? 0) + 1);
    // 前两次交替失败：模拟 CDN 短暂 404/410/503（重试一次即可成功）。
    const unstable = /^\/unstable-(\d{3})$/.exec(url);
    if (unstable && hitCount.get(url) === 1) {
      response.writeHead(Number(unstable[1])).end('temporary');
      return;
    }
    const fixed = /^\/status-(\d{3})$/.exec(url);
    if (fixed) {
      response.writeHead(Number(fixed[1])).end('unavailable');
      return;
    }
    if (url === '/missing') {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '2' });
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  hitCount.clear();
  markFailure.mockReset();
});

const info = (path: string, extra: Record<string, unknown> = {}) =>
  ({ url: base + path, vid: '11', ...extra }) as never;

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('取流身份', () => {
  it('官网片源带浏览端身份；App 片源带 App 身份', async () => {
    const web = await requestMedia(info('/ok', { source: 'web' }));
    expect(await drain(web.data)).toBe('ok');
    expect(requests.at(-1)!.headers['user-agent']).toBe('browser-agent/2.0');
    expect(requests.at(-1)!.headers.referer).toBe('https://hongguoduanju.com/');

    const app = await requestMedia(info('/ok', { source: 'app' }));
    await drain(app.data);
    expect(requests.at(-1)!.headers['user-agent']).toBe('app-agent/1.0');
    expect(requests.at(-1)!.headers.referer).toBeUndefined();
  });

  it('未知/第三方来源不冒充 App 身份：全程不带 Referer，403 也只重试一次', async () => {
    for (const source of [undefined, 'xifan', 'hema', 'custom']) {
      requests.length = 0;
      await expect(requestMedia(info('/status-403', { source }))).rejects.toMatchObject({ mediaStatus: 403 });
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.headers.referer === undefined)).toBe(true);
      expect(requests[0]!.headers['user-agent']).toBe('app-agent/1.0');
    }
  });
});

describe('重试策略', () => {
  it('官网 404/410/5xx 各重试一次，且两次请求逐字段一致（方法、地址、Range、身份）', async () => {
    for (const status of [404, 410, 503]) {
      requests.length = 0;
      const response = await requestMedia(info(`/unstable-${status}`, { source: 'web' }), {
        headers: { Range: 'bytes=0-1' },
      });
      expect(await drain(response.data)).toBe('ok');
      expect(requests).toHaveLength(2);
      // 重试必须是「同一个请求再来一次」：换方法或丢 Range 会让 CDN 返回另一份内容。
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]!.method).toBe('GET');
      expect(requests[0]!.headers.range).toBe('bytes=0-1');
      expect(requests[0]!.headers['user-agent']).toBe('browser-agent/2.0');
    }
  });

  it('非暂时性状态不重试：官网 401/429 与 App 片源 404 都只请求一次', async () => {
    for (const [source, status] of [
      ['web', 401],
      ['web', 429],
      ['app', 404],
    ] as const) {
      requests.length = 0;
      await expect(requestMedia(info(`/status-${status}`, { source }))).rejects.toMatchObject({
        mediaStatus: status,
      });
      expect(requests, `${source}/${status}`).toHaveLength(1);
    }
  });

  it('可重试的传输失败标记该片源失效；取消不标记', async () => {
    const playInfo = {
      url: base + '/missing',
      source: 'web',
      vid: '11',
    } as never;
    await expect(
      withMediaRecovery('11', '1', { playInfo, open: async () => null as never }, async (candidate) => {
        const response = await requestMedia(candidate);
        return drain(response.data);
      }),
    ).rejects.toThrow();
    expect(markFailure).toHaveBeenCalled();
    expect(markFailure.mock.calls[0]![0]).toMatchObject({ source: 'web', vid: '11' });

    markFailure.mockReset();
    const controller = new AbortController();
    controller.abort();
    await expect(
      withMediaRecovery('11', '1', { playInfo, signal: controller.signal }, async () => 'never'),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(markFailure).not.toHaveBeenCalled();
  });
});
