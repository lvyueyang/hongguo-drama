/**
 * 官网取源的安全与优先级（迁移自 4.5 `scripts/check-streaming.cjs` 的
 * 「官网失效后 5 分钟内改走 App」与 `scripts/check-web-media-guard.cjs` 的
 * 「provider 拒绝私网/凭据媒体地址」两组断言）。
 *
 * 两条不变量：
 * 1. 官网页里给出的媒体地址必须指向公网 http(s)；私网、回环、带账号密码、
 *    非 http(s) 一律当作「本集没有官网片源」（返回 null），绝不把内网地址交给播放器；
 * 2. 一次真实的官网媒体传输失败后，同一个分集在 5 分钟内先试 App（不再优先官网页），
 *    其它分集与过期之后不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AxiosStub {
  (...args: unknown[]): unknown;
  mockReset(): void;
  mockImplementation(fn: (...args: unknown[]) => unknown): void;
  mock: { calls: unknown[][] };
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

const { axiosMock } = vi.hoisted(() => ({ axiosMock: vi.fn() as unknown as AxiosStub }));

vi.mock('axios', () => ({ default: axiosMock }));
// 设备身份走网络注册；这里固定一份，避免注册失败混进取流断言。
vi.mock('../../providers/hongguo-app/device.ts', () => ({
  getPlaybackDevice: async () => ({
    device_id: '7000000000000000001',
    iid: '7000000000000000002',
    cdid: '00000000-0000-4000-8000-000000000003',
  }),
  registerPlaybackDevice: async () => ({}),
}));

const { fetchPlayUrlFromWeb, fetchPlayUrlSingle, markWebMediaFailure } = await import('./player.ts');

/** 官网页夹具：`_ROUTER_DATA` 声明当前播放器分集，ld+json 给出明文直链。 */
function webPage(vid: string, sid: string, contentUrl: string): string {
  return `<script>window._ROUTER_DATA=${JSON.stringify({
    loaderData: {
      'player_(series_id)/(vid)/page': {
        isSuccess: true,
        vid,
        series_id: sid,
        seriesDetail: { series_id: sid, vid_list: [vid] },
        publicVideoSeo: { available: true, itemId: vid, seriesId: sid },
      },
    },
  })}</script><script type="application/ld+json">${JSON.stringify({
    '@type': 'VideoObject',
    url: `https://hongguoduanju.com/player/${sid}/${vid}`,
    contentUrl,
  })}</script>`;
}

const SITE = 'https://hongguoduanju.com/player/1/11';

let now = 1_700_000_000_000;
let clock: { mockRestore(): void };

beforeEach(() => {
  now = 1_700_000_000_000;
  clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  axiosMock.mockReset();
  axiosMock.get = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '' });
  axiosMock.post = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '{}' });
  axiosMock.mockImplementation(async () => {
    throw new Error('App 取源不可用');
  });
});

afterEach(() => {
  clock.mockRestore();
});

describe('官网媒体地址必须是公网', () => {
  it('私网、回环、保留段、带凭据与非 http(s) 一律拒绝', async () => {
    for (const url of [
      'http://127.0.0.1/a.mp4',
      'http://2130706433/a.mp4',
      'http://0x7f000001/a.mp4',
      'http://10.0.0.1/a.mp4',
      'http://172.31.0.1/a.mp4',
      'http://192.168.1.1/a.mp4',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/a.mp4',
      'http://[::1]/a.mp4',
      'http://[fd00::1]/a.mp4',
      'http://[::ffff:127.0.0.1]/a.mp4',
      'http://localhost./a.mp4',
      'http://nas.local/a.mp4',
      'http://printer/a.mp4',
      'file:///etc/passwd',
      'https://user:pass@media.example/a.mp4',
    ]) {
      axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: webPage('11', '1', url) });
      await expect(fetchPlayUrlFromWeb('11', '1', () => {})).resolves.toBeNull();
    }
  });

  it('公网 CDN 与官网媒体路径照常保留（含与 IP 前缀同名的域名）', async () => {
    for (const url of [
      'https://fc-cdn.example/a.mp4',
      'https://fd-cdn.example/a.mp4',
      'https://fe80-cdn.example/a.mp4',
      'https://hongguoduanju.com/video/public/11/360p.mp4',
      'https://8.8.8.8/a.mp4',
      'https://[2606:4700::1111]/a.mp4',
    ]) {
      axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: webPage('11', '1', url) });
      const result = (await fetchPlayUrlFromWeb('11', '1', () => {})) as { url?: string; source?: string };
      expect(result?.url, url).toBe(url);
      expect(result?.source).toBe('web');
    }
  });
});

describe('官网传输失败后 5 分钟内改走 App', () => {
  /** 记录实际请求顺序：page = 官网页，app = App 取源，api = 旧接口兜底。 */
  function record(): string[] {
    const order: string[] = [];
    axiosMock.get.mockImplementation(async (url: unknown) => {
      order.push(String(url).startsWith('https://hongguoduanju.com/player') ? 'page' : 'other');
      return { status: 200, headers: {}, data: webPage('11', '1', 'https://fc-cdn.example/web.mp4') };
    });
    axiosMock.post.mockImplementation(async () => {
      order.push('api');
      return { status: 200, headers: {}, data: '{}' };
    });
    axiosMock.mockImplementation(async () => {
      order.push('app');
      throw new Error('App 取源不可用');
    });
    return order;
  }

  it('未失效时先走官网页；失效后 5 分钟内官网页只在最后兜底', async () => {
    const order = record();
    const first = await fetchPlayUrlSingle('11', '1', { force: true });
    expect(first.source).toBe('web');
    expect(order[0]).toBe('page');

    markWebMediaFailure({ source: 'web', vid: '11' });
    order.length = 0;
    const penalized = await fetchPlayUrlSingle('11', '1', { force: true });
    // 官网仍然是最后兜底来源（App 与旧接口都不可用时不能直接没片源）……
    expect(penalized.source).toBe('web');
    // ……但优先级已经让位：官网页请求排在 App/接口之后。
    expect(order[0]).not.toBe('page');
    expect(order.indexOf('page')).toBeGreaterThan(0);
    expect(order.filter((entry) => entry === 'page')).toHaveLength(1);
  });

  it('只影响失败的那一集；非官网片源不记账；5 分钟后恢复官网优先', async () => {
    const order = record();
    markWebMediaFailure({ source: 'web', vid: '11' });
    markWebMediaFailure({ source: 'app', vid: '22' });
    markWebMediaFailure({ source: 'web', vid: '' });

    await fetchPlayUrlSingle('22', '1', { force: true });
    expect(order[0]).toBe('page');

    now += 5 * 60 * 1000 + 1;
    order.length = 0;
    await fetchPlayUrlSingle('11', '1', { force: true });
    expect(order[0]).toBe('page');
  });

  it('官网页夹具与真实站点同源（避免夹具自己把断言带偏）', () => {
    expect(new URL(SITE).origin).toBe('https://hongguoduanju.com');
  });
});
