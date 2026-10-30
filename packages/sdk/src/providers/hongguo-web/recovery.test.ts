/**
 * 取源失败恢复与错误脱敏（迁移自 4.5 `scripts/check-source-recovery.cjs` 的核心不变量）。
 *
 * 这里只保留三类必须守住的行为，逐帧/实网部分由真实素材验收覆盖：
 * 1. 上游错误必须**收敛成稳定错误码**，且错误信息/对象里**不得回传签名地址、令牌或私网地址**；
 * 2. 网页线路有**每路预算**（4s），不能把整次取源的预算吃光；
 * 3. 网页返回的地址必须**与请求的分集一致**，否则宁可返回 null 也不能冒充。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// 设备身份走网络注册；这里固定一份，避免把注册失败混进取流断言。
vi.mock('../../providers/hongguo-app/device.ts', () => ({
  getPlaybackDevice: async () => ({
    device_id: '7000000000000000001',
    iid: '7000000000000000002',
    cdid: '00000000-0000-4000-8000-000000000003',
  }),
  registerPlaybackDevice: async () => ({}),
}));

const { fetchPlayUrlFromWeb, fetchPlayUrlSingle } = await import('./player.ts');
const { fetchAppPlayUrl } = await import('../hongguo-app/ticket.ts');

const SECRET = 'secret https://signed.invalid/?token=private&host=127.0.0.1';

function webPage(vid = '11', sid = '1'): string {
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
    contentUrl: 'https://v3-reading.qznovelvod.com/web.mp4',
  })}</script>`;
}

beforeEach(() => {
  axiosMock.mockReset();
  axiosMock.get = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '' });
  axiosMock.post = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '' });
});

describe('App 取源的错误码与脱敏', () => {
  it('传输类失败收敛为稳定错误码，不回传上游原文', async () => {
    const cases: Array<[string, string]> = [
      ['ECONNABORTED', 'TIMEOUT'],
      ['ETIMEDOUT', 'TIMEOUT'],
      ['ENOTFOUND', 'NETWORK_ERROR'],
      ['ECONNRESET', 'NETWORK_ERROR'],
      ['ERR_NETWORK', 'NETWORK_ERROR'],
      ['secret-token-code', 'NETWORK_ERROR'],
    ];
    for (const [code, expected] of cases) {
      axiosMock.mockReset();
      axiosMock.mockImplementation(async () => {
        throw Object.assign(new Error(SECRET), { code, config: { secret: true } });
      });
      const error = await fetchAppPlayUrl('11').catch((value: unknown) => value as Error & { code?: string });
      expect(error?.code, code).toBe(expected);
      const serialized = `${error?.message ?? ''} ${JSON.stringify(error)}`;
      expect(serialized).not.toMatch(/secret|signed\.invalid|private|127\.0\.0\.1/);
    }
  });
});

describe('取流顺序与预算', () => {
  it('网页线路按每路预算调用，不整段占用预算', async () => {
    axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: '' });
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: JSON.stringify({ Code: 1 }) });

    await fetchPlayUrlSingle('11', '1', { quality: 'auto' }).catch(() => {});

    const webCalls = axiosMock.get.mock.calls.map((call) => call[1] as { timeout?: number } | undefined);
    expect(webCalls.length).toBeGreaterThan(0);
    for (const options of webCalls) {
      expect(Number(options?.timeout ?? 0)).toBeLessThanOrEqual(4000);
    }
  });

  it('空响应不放大成多次请求', async () => {
    axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: '' });
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: Buffer.alloc(0) });

    await fetchPlayUrlSingle('12', '1', { quality: 'auto' }).catch(() => {});
    const postCalls = axiosMock.post.mock.calls.length;
    expect(postCalls).toBeGreaterThan(0);
    expect(postCalls).toBeLessThanOrEqual(2);
  });
});

describe('网页地址必须对得上请求的分集', () => {
  it('页面属于别的分集时返回 null，而不是冒充', async () => {
    axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: webPage('99', '1') });
    await expect(fetchPlayUrlFromWeb('11', '1', () => {})).resolves.toBeNull();
  });

  it('页面与请求一致时给出地址，且带来源标记 web', async () => {
    axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: webPage('11', '1') });
    const result = (await fetchPlayUrlFromWeb('11', '1', () => {})) as {
      url?: string;
      source?: string;
    } | null;
    expect(result?.source).toBe('web');
    expect(result?.url).toContain('qznovelvod.com');
  });

  it('页面结构异常时返回 null，不抛未知错误', async () => {
    axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: '<html>空页面</html>' });
    await expect(fetchPlayUrlFromWeb('11', '1', () => {})).resolves.toBeNull();
  });
});
