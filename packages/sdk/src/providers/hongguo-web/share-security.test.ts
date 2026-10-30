/**
 * 分享链接解析的安全边界（迁移自 4.5 `scripts/check-share-security.cjs`）。
 *
 * 分享文本来自剪贴板/聊天窗口，是不可信输入：
 *   1) 非法协议、超长、带账号密码、私网字面量**在联网之前**就拒绝；
 *   2) 文本里已经能看出编号时不联网（含号段外的显式 series_id）；
 *   3) 需要抓页面时固定请求形态（不自动跟随重定向、2MiB 上限、可取消）；
 *   4) 每一个跳转目标都要重新校验，循环跳转有上限；
 *   5) socket 级 DNS 必须重新校验，私网解析（含 DNS rebinding）一律拒绝。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const harness = vi.hoisted(() => ({
  records: [{ address: '8.8.8.8', family: 4 }] as Array<{ address: string; family: number }>,
  calls: [] as Array<{ url: string; options: any }>,
  handler: null as null | ((url: string) => unknown),
}));

vi.mock('axios', () => ({ default: vi.fn() }));
vi.mock('../hongguo-app/device.ts', () => ({
  getPlaybackDevice: async () => ({
    device_id: '7000000000000000001',
    iid: '7000000000000000002',
    cdid: '00000000-0000-4000-8000-000000000003',
  }),
  registerPlaybackDevice: async () => ({}),
}));
vi.mock('node:dns', () => ({
  default: {
    lookup: (_host: string, _options: unknown, callback: (error: null, rows: unknown[]) => void) =>
      callback(null, harness.records),
  },
}));

const axios = (await import('axios')).default as unknown as { get: ReturnType<typeof vi.fn> };
const { resolveSeriesId } = await import('./player.ts');

/** 解析前的即时求值：模拟 axios 在真正建连时跑一遍守卫的 socket DNS 校验。 */
async function lookupNow(options: any, url: string): Promise<void> {
  expect(typeof options.lookup).toBe('function');
  await new Promise<void>((resolve, reject) =>
    options.lookup(new URL(url).hostname, { all: true }, (error: Error | null) =>
      error ? reject(error) : resolve(),
    ),
  );
}

beforeEach(() => {
  harness.records = [{ address: '8.8.8.8', family: 4 }];
  harness.calls = [];
  harness.handler = null;
  axios.get = vi.fn(async (url: string, options: any) => {
    harness.calls.push({ url, options });
    await lookupNow(options, url);
    if (harness.handler) return harness.handler(url);
    return { status: 200, headers: {}, data: '{"series_id":"123"}' };
  });
});

describe('不用联网的输入', () => {
  it('纯编号、播放页与详情页里的编号直接取用', async () => {
    expect(await resolveSeriesId(' 1234567890 ')).toBe('1234567890');
    expect(await resolveSeriesId('https://hongguoduanju.com/player/7673067074104593432')).toBe(
      '7673067074104593432',
    );
    expect(await resolveSeriesId('https://hongguoduanju.com/detail?series_id=7673067074104593432')).toBe(
      '7673067074104593432',
    );
    expect(await resolveSeriesId('https://hongguoduanju.com/detail?series_id=1234567%38')).toBe('12345678');
    expect(harness.calls).toEqual([]);
  });

  it('文本里显式写出的编号优先，且不需要校验同文本里的 URL', async () => {
    expect(await resolveSeriesId('看这里 http://127.0.0.1/private series_id=12345678')).toBe('12345678');
    expect(await resolveSeriesId('https://user:secret@example.com/path series_id=12345678')).toBe('12345678');
    expect(
      await resolveSeriesId('series_id=999 看剧 https://hongguoduanju.com/detail?series_id=1234567%38'),
    ).toBe('999');
    expect(
      await resolveSeriesId('看剧点这里 https://example.com/share/abc ，series_id=7673067074104593432'),
    ).toBe('7673067074104593432');
    expect(await resolveSeriesId('series_id=' + '1'.repeat(30))).toBe('1'.repeat(30));
    expect(await resolveSeriesId('video_series_id=1234567890')).toBe('1234567890');
    expect(await resolveSeriesId('"series_id":"1234567890"')).toBe('1234567890');
    expect(harness.calls).toEqual([]);
  });

  it('非法键名或超长编号不联网也不放行', async () => {
    for (const input of [
      'not_series_id=1234567',
      'not_video_series_id=1234567',
      'series_id=' + '1'.repeat(31),
      'series_id=123456789012345678901234567890abc',
    ]) {
      await expect(resolveSeriesId(input), input).rejects.toThrow();
      expect(harness.calls, input).toEqual([]);
    }
  });
});

describe('联网前的输入校验', () => {
  it('非法协议、私网字面量、带凭据与超长输入都不触达网络', async () => {
    const inputs = [
      `data:${'/'.repeat(4096)}`,
      'file:///etc/hosts',
      'ftp://example.com/a',
      'javascript:alert(1)',
      '//example.com/a',
      'https://user:secret@example.com/',
      'x'.repeat(8193),
      `https://example.com/${'x'.repeat(4096)}`,
      '1'.repeat(31),
      {},
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://10.0.0.1/',
      'http://169.254.169.254/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      'http://nas.local/',
      'http://127.0.0.1/player/12345678',
      'http://nas.local/?series_id=12345678',
      'https://user:secret@example.com/detail?series_id=12345678',
    ];
    for (const input of inputs) {
      await expect(resolveSeriesId(input as never), JSON.stringify(input).slice(0, 40)).rejects.toThrow();
      expect(harness.calls, JSON.stringify(input).slice(0, 40)).toEqual([]);
    }
  });
});

describe('页面解析与请求形态', () => {
  it('需要抓页面时固定请求形态，并从正文里取编号', async () => {
    const records = await resolveSeriesId('推荐好剧，点击 https://example.com/share/abc 观看全集');
    expect(records).toBe('123');
    const { url, options } = harness.calls[0]!;
    expect(url).toBe('https://example.com/share/abc');
    expect(options.maxRedirects).toBe(0);
    expect(options.responseType).toBe('text');
    expect(options.maxContentLength).toBeGreaterThan(0);
    expect(options.maxContentLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('schemeParams 损坏时继续走正文解析；正文里的超长编号不放行', async () => {
    harness.handler = () => ({ status: 200, headers: {}, data: '{"series_id":"789"}' });
    expect(await resolveSeriesId('https://example.com/?schemeParams=%ZZ')).toBe('789');
    harness.handler = () => ({
      status: 200,
      headers: {},
      data: `{"series_id":"${'1'.repeat(31)}"}`,
    });
    await expect(resolveSeriesId('https://example.com/')).rejects.toThrow();
  });
});

describe('跳转与 DNS', () => {
  it('每个跳转目标都要重新校验；带编号的安全跳转不用再抓目标页', async () => {
    for (const location of [
      'data:text/plain,123',
      'file:///tmp/test',
      'https://user:secret@example.com/',
      `https://example.com/${'x'.repeat(4096)}`,
      'http://127.0.0.1/private',
      '//192.168.1.1/private',
      'http://[::ffff:10.0.0.1]/',
      'http://localhost./',
      'http://127.0.0.1/player/12345678',
      'https://user:secret@example.com/detail?series_id=12345678',
    ]) {
      harness.calls = [];
      harness.handler = () => ({ status: 302, headers: { location }, data: '' });
      await expect(resolveSeriesId('https://example.com/short'), location).rejects.toThrow();
      expect(harness.calls, location).toHaveLength(1);
    }

    harness.calls = [];
    harness.handler = (url) =>
      url.endsWith('/short')
        ? { status: 302, headers: { location: '/player/456' }, data: '' }
        : (() => {
            throw new Error('target page unavailable');
          })();
    expect(await resolveSeriesId('https://example.com/short')).toBe('456');
    expect(harness.calls.map((call) => call.url)).toEqual(['https://example.com/short']);
  });

  it('循环跳转有上限', async () => {
    harness.handler = () => ({ status: 302, headers: { location: '/loop' }, data: '' });
    await expect(resolveSeriesId('https://example.com/loop')).rejects.toThrow();
    expect(harness.calls.length).toBeLessThanOrEqual(6);
  });

  it('官方短链的跳转目标是官网播放页时直接取编号', async () => {
    harness.handler = () => ({
      status: 302,
      headers: { location: 'https://hongguoduanju.com/player/7123456789012345678' },
      data: '',
    });
    expect(await resolveSeriesId('分享短剧 https://v.fqnovel.com/fixture/')).toBe('7123456789012345678');
    expect(harness.calls).toHaveLength(1);
  });

  it('socket 级 DNS 解析到私网（含 rebinding）时拒绝连接', async () => {
    for (const records of [
      [{ address: '192.168.1.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
    ]) {
      harness.records = records;
      harness.calls = [];
      await expect(resolveSeriesId('https://share.example/start'), JSON.stringify(records)).rejects.toThrow();
      expect(harness.calls, JSON.stringify(records)).toHaveLength(1);
      // 守卫自带 keepAlive agent：连接不会被普通 DNS 打开的 socket 复用。
      expect(harness.calls[0]!.options.httpsAgent).toBeTruthy();
    }
  });
});

describe('依赖收敛', () => {
  it('安装的 axios 与 SDK 声明的版本一致（两套传输会让守卫时有时无）', () => {
    const installed = (require('axios/package.json') as { version: string }).version;
    const declared = (
      JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies.axios;
    expect(installed).toBe(declared);
  });
});
