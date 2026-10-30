/**
 * 自定义源（MacCMS）目录 / 搜索 / 取流（迁移自 4.5 `scripts/check-custom-source.cjs`
 * 的目录与取流部分；配置校验在 `index.test.ts` 已覆盖）。
 *
 * 自定义源是用户填的公网地址，因此每条路径都要重新校验身份与权限：
 *   1) 分类/搜索只用苹果 CMS 的标准参数，编号带 `custom:` 前缀且稳定；
 *   2) 详情只按「一条直连媒体线」出分集，列表行里不夹带可播放地址；
 *   3) 解析器线路永远不是媒体候选，付费/密码锁如实拒绝；
 *   4) 停用、删除、改配置（含在途请求）都必须立刻停手；
 *   5) 私网 DNS、私网重定向、非 JSON、错 schema 与上游原文都不会变成「有效来源」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = '12345678-1234-4234-9234-123456789abc';
const source = `custom:${UUID}`;
const sid = `${source}:12`;
const config = { id: UUID, name: '测试片库', url: 'https://api.example/api.php/provide/vod/', enabled: true };

const harness = vi.hoisted(() => ({
  settings: { custom_sources: [] as any[] },
  address: '93.184.216.34',
  redirect: '',
  failure: null as Error | null,
  onRequest: null as null | ((options: any) => Promise<void>),
  body: null as unknown,
  calls: [] as Array<{ url: string; options: any }>,
}));

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('node:dns', () => ({
  default: {
    lookup: (_host: string, _options: unknown, callback: (error: null, rows: unknown[]) => void) =>
      callback(null, [{ address: harness.address, family: 4 }]),
  },
}));
vi.mock('../../services/storage/store.ts', () => ({
  default: { getSettings: () => harness.settings, saveSettings: () => {} },
}));

const axios = (await import('axios')).default as unknown as { get: ReturnType<typeof vi.fn> };
const provider = (await import('./index.ts')).default as any;

function catalogBody() {
  return {
    code: 1,
    page: 1,
    pagecount: 2,
    total: 3,
    class: [{ type_id: 2, type_name: '短剧' }],
    list: [
      {
        vod_id: 12,
        vod_name: '<b>测试剧</b>',
        vod_pic: 'https://images.example/cover.jpg',
        type_name: '短剧',
        vod_play_from: '解析$$$线路甲$$$线路乙',
        vod_play_url:
          '第1集$https://parser.example/?url=x.mp4$$$第1集$https://cdn.example/one.mp4#第2集$https://cdn.example/two.m3u8$$$01$https://backup.example/one.m3u8#02$https://backup.example/two.mp4',
      },
    ],
  };
}

beforeEach(() => {
  harness.settings = { custom_sources: [{ ...config }] };
  harness.address = '93.184.216.34';
  harness.redirect = '';
  harness.failure = null;
  harness.onRequest = null;
  harness.body = catalogBody();
  harness.calls = [];
  axios.get.mockReset();
  axios.get.mockImplementation(async (url: string, options: any) => {
    harness.calls.push({ url, options });
    // 保留应用代理配置，并让守卫的 socket 级 DNS 校验真正跑一遍。
    expect(options.proxy).toBeUndefined();
    await new Promise<void>((resolve, reject) =>
      options.lookup(new URL(url).hostname, { all: true }, (error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (harness.redirect) options.beforeRedirect({}, { headers: { location: harness.redirect } }, { url });
    if (harness.failure) throw harness.failure;
    if (harness.onRequest) await harness.onRequest(options);
    return { data: typeof harness.body === 'string' ? harness.body : JSON.stringify(harness.body) };
  });
});

/** 改这一部剧的权限标志（源码每次都重新读，不做授权缓存）。 */
function lockItem(item: Record<string, unknown>) {
  Object.assign((harness.body as any).list[0], item);
}

describe('目录与搜索', () => {
  it('用苹果 CMS 参数取分类与搜索，编号稳定带前缀', async () => {
    const catalog = (await provider.fetchCatalog({ source, genre: '2', page: 1 })) as any;
    expect(catalog.success).toBe(true);
    expect(catalog.results[0].series_id).toBe(sid);
    expect(catalog.results[0].series_title).toBe('测试剧');
    expect(catalog.genres[0].slug).toBe('2');
    expect(catalog.hasMore).toBe(true);
    const catalogUrl = new URL(harness.calls.at(-1)!.url);
    expect(catalogUrl.searchParams.get('t')).toBe('2');
    expect(catalogUrl.searchParams.get('ac')).toBe('detail');
    expect(catalogUrl.searchParams.get('at')).toBe('json');

    const search = (await provider.searchSeries('故事', { source })) as any;
    expect(search.success).toBe(true);
    expect(new URL(harness.calls.at(-1)!.url).searchParams.get('wd')).toBe('故事');

    const before = harness.calls.length;
    expect(((await provider.fetchCatalog({ source, page: -1 })) as any).success).toBe(false);
    expect(harness.calls.length).toBe(before);
  });
});

describe('分集与播放候选', () => {
  it('详情只按一条直连媒体线出分集，且不夹带可播放地址', async () => {
    const detail = (await provider.fetchEpisodeList(sid)) as any;
    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodes[0].title).toBe('第1集');
    expect(detail.episodes[0].vid).toBe(`${sid}:1:0`);
    expect(JSON.stringify(detail)).not.toContain('cdn.example');
  });

  it('播放候选保留每条线路的 URL 与格式', async () => {
    const detail = (await provider.fetchEpisodeList(sid)) as any;
    const play = (await provider.fetchPlayUrlSingle(detail.episodes[0].vid, sid)) as any;
    expect(play.url).toBe('https://cdn.example/one.mp4');
    expect(play.format).toBe('mp4');
    expect(play.source).toBe('custom');
    expect(play.candidates).toHaveLength(2);
    expect(play.candidates[1]).toMatchObject({ url: 'https://backup.example/one.m3u8', format: 'hls' });
    expect(play.candidates.every((item: any) => !item.contentKey && !item.spadeA)).toBe(true);
    expect(new URL(harness.calls.at(-1)!.url).searchParams.get('ids')).toBe('12');
  });

  it('身份不匹配时不发请求；剧集编号对不上就报错', async () => {
    const vid = `${sid}:1:0`;
    for (const wrong of [`${source}:999`, 'hema:12']) {
      expect(((await provider.fetchPlayUrlSingle(vid, wrong)) as any).url).toBeNull();
    }
    expect(harness.calls).toHaveLength(0);

    (harness.body as any).list[0].vod_id = 999;
    await expect(provider.fetchEpisodeList(sid)).rejects.toThrow(/不一致/);
    (harness.body as any).list[0].vod_id = 12;
    expect(((await provider.fetchPlayUrlSingle(vid, sid)) as any).url).toBeTruthy();
  });

  it('付费、密码与锁定标志每次都重新读；解析器线路永远不是候选', async () => {
    const vid = `${sid}:1:0`;
    for (const flag of [{ vod_points_play: 5 }, { vod_pwd_play: 'private' }, { locked: true }]) {
      lockItem(flag);
      expect(((await provider.fetchPlayUrlSingle(vid, sid)) as any).locked).toBe(true);
      for (const key of Object.keys(flag)) delete (harness.body as any).list[0][key];
    }
    expect(((await provider.fetchPlayUrlSingle(`${sid}:0:0`, sid)) as any).url).toBeNull();
  });
});

describe('停用与变更', () => {
  it('停用、删除后不再发请求，包括在途请求', async () => {
    await provider.fetchCatalog({ source });
    harness.settings.custom_sources[0].enabled = false;
    const before = harness.calls.length;
    expect(((await provider.fetchCatalog({ source })) as any).success).toBe(false);
    expect(((await provider.fetchPlayUrlSingle(`${sid}:1:0`, sid)) as any).url).toBeNull();
    expect(harness.calls.length).toBe(before);

    harness.settings.custom_sources = [];
    expect(() => provider.assertEnabled(source)).toThrow();

    harness.settings.custom_sources = [{ ...config }];
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.onRequest = (options) =>
      new Promise((_resolve, reject) => {
        entered();
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const pending = provider.fetchCatalog({ source });
    await started;
    harness.settings.custom_sources[0].enabled = false;
    provider.cancelRequests(UUID);
    expect(((await pending) as any).success).toBe(false);
  });
});

describe('安全边界', () => {
  it('私网 DNS、私网重定向、非 JSON 与错 schema 都是失败', async () => {
    harness.address = '192.168.1.3';
    expect(((await provider.fetchCatalog({ source })) as any).success).toBe(false);

    harness.address = '93.184.216.34';
    harness.redirect = 'http://127.0.0.1/admin';
    expect(((await provider.fetchCatalog({ source })) as any).success).toBe(false);
    harness.redirect = '';

    for (const body of ['<script>evil()</script>', { code: 1 }, { code: 0, msg: 'secret' }, null]) {
      harness.body = body;
      const result = (await provider.fetchCatalog({ source })) as any;
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('secret');
    }

    harness.failure = new Error('https://api.example/?token=secret');
    const failed = (await provider.fetchCatalog({ source })) as any;
    expect(failed.success).toBe(false);
    expect(failed.error).not.toContain('secret');
  });

  it('草稿探活不落盘；请求保留应用代理并允许本地代理解析', async () => {
    harness.settings.custom_sources = [];
    const draft = (await provider.testCustomSource(config)) as any;
    expect(draft.success).toBe(true);
    expect(harness.settings.custom_sources).toHaveLength(0);

    harness.settings.custom_sources = [{ ...config }];
    await provider.fetchCatalog({ source });
    const options = harness.calls.at(-1)!.options;
    expect(Object.hasOwn(options, 'proxy')).toBe(false);
    harness.address = '127.0.0.1';
    const addresses = await new Promise<any[]>((resolve, reject) =>
      options.lookup('configured-proxy.local', { all: true }, (error: Error | null, rows: any[]) =>
        error ? reject(error) : resolve(rows),
      ),
    );
    // 用户自选的本地代理可信；目标域名的 DNS 由该代理负责。
    expect(addresses[0].address).toBe('127.0.0.1');
  });
});
