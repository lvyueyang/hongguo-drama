/**
 * App 取源（迁移自 4.5 `scripts/check-app-source.cjs` 的取流部分）。
 *
 * SM3 向量与元数据签名已由 `internal/crypto/sm3.test.ts`、`ticket.test.ts` 覆盖；
 * 这里守取源本身的边界：
 *   1) 请求形态固定：只发到允许的域名、不带签名头、不跟随重定向、12 秒预算；
 *   2) 只能取到**本次请求的那一集**，取不到就失败，绝不退到别的分集；
 *   3) 片源地址与解密密钥都必须可用：坏地址可以用同流备份，坏密钥只会失败；
 *   4) 媒体域名白名单（HTTPS + 允许的后缀），127.0.0.1/file:// 这类地址进不来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface AxiosConfig {
  url: string;
  method?: string;
  headers: Record<string, string>;
  data?: Buffer;
  timeout: number;
  maxRedirects: number;
  responseType: string;
  signal?: AbortSignal;
}

const harness = vi.hoisted(() => ({
  identityCalls: [] as unknown[][],
  requests: [] as AxiosConfig[],
}));

vi.mock('axios', () => ({ default: vi.fn() }));
vi.mock('./device.ts', () => ({
  getPlaybackDevice: async (...args: unknown[]) => {
    harness.identityCalls.push(args);
    return {
      device_id: '7000000000000000001',
      iid: '7000000000000000002',
      cdid: '00000000-0000-4000-8000-000000000003',
    };
  },
  registerPlaybackDevice: async () => ({}),
}));

const axios = (await import('axios')).default as unknown as ReturnType<typeof vi.fn>;
const { fetchAppPlayUrl } = await import('./ticket.ts');

const seeder = await import('node:crypto');
const keyHex = '0123456789abcdef0123456789abcdef';
const media = (name: string) => `https://v3-reading.qznovelvod.com/${name}.mp4`;

/** 把 16 字节密钥编码成 App 的 spade_a（`deriveContentKey` 的逆运算）。 */
function encodedKey(): string {
  const plain = Buffer.from(`0${keyHex}`);
  const raw = Buffer.alloc(34);
  const previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    const pop = i.toString(2).split('1').length - 1;
    raw[i + 1] = ((plain[i]! + 21 + pop) & 255) ^ previous[i & 1]!;
    previous[i & 1] = raw[i + 1]!;
  }
  raw[0] = 48 ^ raw[1]! ^ raw[2]!;
  return raw.toString('base64');
}

function encryptedUrl(value: string, seed: Buffer): string {
  const constants = Buffer.from(
    '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
    'hex',
  );
  const material = seeder
    .createHash('sha512')
    .update(Buffer.concat([seeder.createHash('sha512').update(seed).digest(), constants]))
    .digest();
  const cipher = seeder.createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  return Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(value), cipher.final()]).toString(
    'base64',
  );
}

interface FixtureOptions {
  /** 模型响应里带的 vid 键，用来构造「上游返回别的分集」 */
  wrongVid?: boolean;
  fallback?: string;
  /** 媒体地址（明文，或经 key_seed 加密） */
  mediaUrl?: string;
  /** 媒体请求返回的重定向地址 */
  redirect?: string;
  malformedKey?: boolean;
  /** 内联 video_list（默认）；false 表示两段式 fallback_api */
  inline?: boolean;
  /** 自定义片源行；默认给「一坏一好」两行 */
  rows?: unknown[];
  /** 是否把媒体地址包在 key_seed 加密里 */
  keySeed?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const seed = Buffer.alloc(16, 7);
  const url = options.mediaUrl ?? media('video');
  const inline = options.inline !== false;
  const rows = options.rows ?? [
    { main_url: url, codec_type: 'bytevc2', quality_desc: '2160P' },
    {
      main_url: options.keySeed === false ? url : encryptedUrl(url, seed),
      codec_type: 'h264',
      quality_desc: '720P',
      spade_a: options.malformedKey ? 'bad' : encodedKey(),
    },
  ];

  axios.mockReset();
  harness.requests = [];
  axios.mockImplementation(async (config: AxiosConfig) => {
    harness.requests.push(config);
    if (config.method === 'POST') {
      // 内联片源直接带 video_list；否则只给 fallback_api，需要第二段请求。
      const model = inline
        ? { video_list: rows, key_seed: options.keySeed === false ? null : seed.toString('base64') }
        : { fallback_api: options.fallback ?? 'https://vod.snssdk.com/info' };
      return {
        status: 200,
        headers: {},
        data: JSON.stringify({
          code: 0,
          data: options.wrongVid
            ? { '999': { video_model: JSON.stringify(model) } }
            : { '11': { video_model: JSON.stringify(model) } },
        }),
      };
    }
    if (options.redirect) return { status: 302, headers: { location: options.redirect }, data: '' };
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({
        video_info: {
          data: {
            key_seed: options.keySeed === false ? null : seed.toString('base64'),
            video_list: rows,
          },
        },
      }),
    };
  });
  return {
    fetch: fetchAppPlayUrl as (vid: string, options?: any) => Promise<any>,
    url,
  };
}

beforeEach(() => {
  harness.requests = [];
  harness.identityCalls = [];
});

describe('取源请求形态', () => {
  it('只发到允许的域名，不带签名头、不跟随重定向，12 秒预算', async () => {
    const { fetch } = fixture();
    await fetch('11');
    for (const config of harness.requests) {
      const url = new URL(config.url);
      expect(['api5-normal-sinfonlineb.fqnovel.com', 'vod.snssdk.com']).toContain(url.hostname);
      expect(config.maxRedirects).toBe(0);
      expect(config.responseType).toBe('text');
      expect(config.timeout).toBeGreaterThan(0);
      expect(config.timeout).toBeLessThanOrEqual(12_000);
      expect(config.signal).toBeInstanceOf(AbortSignal);
    }
    const post = harness.requests.find((config) => config.method === 'POST')!;
    expect(post.headers['User-Agent']).toMatch(/^com\.phoenix\.read\/71532 /);
    // 播放接口用的是注册身份，不是签名头。
    for (const name of Object.keys(post.headers)) {
      expect(name.toLowerCase()).not.toMatch(/^x-(?:medusa|gorgon|khronos|argus|ladon|helios|ss-stub)$/);
    }
  });

  it('顺序与并发取源复用同一份注册身份，每次取源只发一次模型请求', async () => {
    const { fetch } = fixture({ inline: false });
    await fetch('11');
    await fetch('11');
    await Promise.all([fetch('11'), fetch('11'), fetch('11')]);
    const models = harness.requests.filter((config) => config.method === 'POST');
    expect(models).toHaveLength(5);
    for (const field of ['iid', 'device_id']) {
      const values = models.map((config) => new URL(config.url).searchParams.get(field));
      expect(new Set(values).size, field).toBe(1);
      expect(values[0]).toMatch(/^[1-9]\d{15,29}$/);
    }
    const cdids = models.map((config) => new URL(config.url).searchParams.get('cdid'));
    expect(new Set(cdids).size).toBe(1);
    expect(cdids[0]).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
    // 两段式：先模型，再 fallback 取视频信息。
    expect(harness.requests).toHaveLength(10);
    expect(harness.identityCalls.every((call) => typeof call[0] === 'function')).toBe(true);
  });
});

describe('分集与片源匹配', () => {
  it('内联片源：精确分集 + H.264 优先 + 密钥派生', async () => {
    const { fetch, url } = fixture();
    const result = await fetch('11');
    expect(result.source).toBe('app');
    expect(result.url).toBe(url);
    expect(result.contentKey).toBe(keyHex);
    expect(result.codec).toBe('h264');
    expect(result.quality).toBe('720P');
    expect(harness.requests).toHaveLength(1);
  });

  it('上游没返回这一集时失败，不回退到别的分集', async () => {
    const { fetch } = fixture({ wrongVid: true });
    await expect(fetch('11')).rejects.toThrow();
    expect(harness.requests).toHaveLength(1);
  });

  it('分集编号非法时不发请求', async () => {
    const { fetch } = fixture();
    await expect(fetch('../11')).rejects.toThrow(/分集编号/);
    expect(harness.requests).toHaveLength(0);
  });
});

describe('地址与密钥边界', () => {
  it('坏主地址退回同流备份地址，坏密钥只失败', async () => {
    for (const main_url of [
      '',
      'https://127.0.0.1/private',
      'https://v3-reading.qznovelvod.com.attacker.test/video',
      'http://v3-reading.qznovelvod.com/video',
    ]) {
      const { fetch } = fixture({
        inline: false,
        rows: [{ main_url, backup_url: media('backup'), codec_type: 'h264' }],
        keySeed: false,
      });
      expect((await fetch('11')).url, main_url).toBe(media('backup'));
    }
    const badKey = fixture({
      inline: false,
      rows: [{ main_url: media('one'), codec_type: 'h264', spade_a: 'bad' }],
      keySeed: false,
    });
    await expect(badKey.fetch('11')).rejects.toThrow(/片源地址或密钥无法解析/);
    const privateOnly = fixture({
      inline: false,
      rows: [{ main_url: 'https://127.0.0.1/private', backup_url: 'file:///private', codec_type: 'h264' }],
      keySeed: false,
    });
    await expect(privateOnly.fetch('11')).rejects.toThrow();
  });

  it('同档里跳过不可用候选，坏密钥不会连累可用候选', async () => {
    const { fetch } = fixture({
      inline: false,
      rows: [
        { main_url: media('broken'), codec_type: 'h264', quality_desc: '1080P', spade_a: 'bad' },
        {
          main_url: media('working'),
          codec_type: 'h264',
          quality_desc: '1080P',
          spade_a: encodedKey(),
        },
      ],
      keySeed: false,
    });
    const result = await fetch('11');
    expect(result.url).toBe(media('working'));
    expect(result.contentKey).toBe(keyHex);
  });

  it('fallback 与重定向地址必须落在允许的域名上', async () => {
    for (const fallback of [
      'http://vod.snssdk.com/info',
      'https://127.0.0.1/info',
      'https://vod.snssdk.com.attacker.test/info',
      'https://user:pass@vod.snssdk.com/info',
    ]) {
      const { fetch } = fixture({ inline: false, fallback });
      await expect(fetch('11'), fallback).rejects.toThrow();
      expect(harness.requests).toHaveLength(1);
    }
    const redirected = fixture({ inline: false, redirect: 'https://127.0.0.1/private' });
    await expect(redirected.fetch('11')).rejects.toThrow();
    expect(harness.requests).toHaveLength(2);
    const privateMedia = fixture({ mediaUrl: 'https://127.0.0.1/video' });
    await expect(privateMedia.fetch('11')).rejects.toThrow();
  });
});
