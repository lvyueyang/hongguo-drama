/**
 * 取源调度与短缓存（迁移自 4.5 `scripts/check-native-performance.cjs`，以及
 * `check-app-source.cjs` / `check-download-quality.cjs` 里属于 player 的那几条）。
 *
 * 5.0 的取源顺序没变：官网网页 → App 接口 → 旧接口，第三方源按前缀直连。
 * 这里守的是「调度与缓存」的不变量，而不是某一次请求的具体条数：
 *   1) 有效网页优先，且不等待备用接口；
 *   2) 同一集的并发请求合并为一次；成功结果短缓存（播放地址 30s、分集 60s）；
 *   3) 空响应/失败不放大成多次请求，网页不可用仍然回退到备用接口；
 *   4) 显式清晰度失败**不**偷偷回落网页（用户选了 1080p 就不能给个网页低清）；
 *   5) 降级结果与严格档位各自成缓存；force 只刷新自己那一档，旧在途响应不能覆盖它；
 *   6) 第三方源按前缀直连，不经过内置缓存与回退。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  pages: new Map<string, string>(),
  posts: [] as Array<{ url: string; body: any }>,
  appCalls: [] as any[],
  appError: null as Error | null,
  /** 卡住 App 取源的闸门，用来构造「旧请求晚于 force 返回」 */
  appGate: null as Promise<void> | null,
  /** 旧接口（preload）返回的 video_list；可换成坏地址用例 */
  apiModel: null as null | unknown[],
  /** 挂起不返回的页面：记录请求信号，便于断言「慢路径被取消」 */
  stalled: null as null | { signal: AbortSignal },
  getCalls: [] as string[],
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
// 三个第三方源与 App 取源都换成夹具：这里的重点是调度与缓存，不是它们自己的算法。
vi.mock('../hongguo-app/ticket.ts', () => {
  const module = {
    fetchAppPlayUrl: async (vid: string, options: any = {}) => {
      // 用调用序号进地址，便于区分「哪一次请求的结果」。
      const index = harness.appCalls.length + 1;
      harness.appCalls.push({ vid, options });
      const gate = harness.appGate;
      if (gate) await gate;
      if (harness.appError) throw harness.appError;
      return {
        url: `https://v3-reading.qznovelvod.com/app-${options.quality ?? 'auto'}-${index}.mp4`,
        spadeA: '01'.repeat(16),
        contentKey: '01'.repeat(16),
        codec: 'h264',
        source: 'app',
        quality: options.quality ?? 'auto',
      };
    },
  };
  return { ...module, default: module };
});
vi.mock('../hema/index.ts', () => {
  const module = {
    fetchEpisodeList: async (seriesId: string) => ({
      series_id: seriesId,
      total: 1,
      episodes: [],
      source: 'hema',
    }),
    fetchPlayUrlSingle: async (vid: string) => ({
      url: 'https://cdn.example/hema.mp4',
      source: 'hema',
      vid,
    }),
  };
  return { ...module, default: module };
});
vi.mock('../xifan/index.ts', () => {
  const module = {
    fetchEpisodeList: async (seriesId: string) => ({
      series_id: seriesId,
      total: 1,
      episodes: [],
      source: 'xifan',
    }),
    fetchPlayUrlSingle: async (vid: string) => ({
      url: 'https://cdn.example/xifan.mp4',
      source: 'xifan',
      vid,
    }),
  };
  return { ...module, default: module };
});
vi.mock('../custom/index.ts', () => {
  const module = {
    assertEnabled: () => ({ id: 'fixture' }),
    fetchEpisodeList: async (seriesId: string) => ({
      series_id: seriesId,
      total: 1,
      episodes: [],
      source: 'custom',
    }),
    fetchPlayUrlSingle: async (vid: string, sid: string, options: any) => ({
      url: 'https://cdn.example/custom.mp4',
      source: 'custom',
      vid,
      sid,
      options,
    }),
  };
  return { ...module, default: module };
});

const axios = (await import('axios')).default as unknown as ReturnType<typeof vi.fn>;

// player 的缓存与在途表是模块级状态：每条用例都要一份干净模块。
async function loadPlayer() {
  vi.resetModules();
  return (await import('./player.ts')) as {
    fetchEpisodeList: (seriesId: string, options?: any) => Promise<any>;
    fetchPlayUrlSingle: (vid: string, sid: string, options?: any) => Promise<any>;
  };
}

const media = (name: string) => `https://v3-reading.qznovelvod.com/${name}.mp4`;

/** 官网播放页：ROUTER_DATA 当前分集 + 与当前分集绑定的 ld+json VideoObject。 */
function playerPage(vid = '11', sid = '1', extra: Record<string, unknown> = {}) {
  return `<script>window._ROUTER_DATA=${JSON.stringify({
    loaderData: {
      'player_(series_id)/(vid)/page': {
        vid,
        series_id: sid,
        isSuccess: true,
        seriesDetail: { series_id: sid },
        publicVideoSeo: { available: true, itemId: vid, seriesId: sid },
        ...extra,
      },
    },
  })}</script><script type="application/ld+json">${JSON.stringify({
    '@type': 'VideoObject',
    url: `https://hongguoduanju.com/player/${sid}/${vid}`,
    contentUrl: media('web'),
  })}</script>`;
}

/** 官网整剧页：当前分集列表（可带 accessible_episode_cnt）。 */
function detailPage(sid = '1', extra: Record<string, unknown> = {}) {
  return `<script>window._ROUTER_DATA=${JSON.stringify({
    loaderData: {
      'player_(series_id)/page': {
        isSuccess: true,
        series_id: sid,
        seriesDetail: {
          series_id: sid,
          series_name: '测试剧',
          vid_list: ['11', '12'],
          ...extra,
        },
      },
    },
  })}`;
}

beforeEach(() => {
  harness.pages = new Map();
  harness.posts = [];
  harness.appCalls = [];
  harness.appError = null;
  harness.appGate = null;
  harness.apiModel = null;
  harness.stalled = null;
  harness.getCalls = [];
  axios.mockReset();
  // player 用 `axios.get` 抓官网页面、`axios.post` 打备用接口（旧接口走同一个 post）。
  (axios as any).get = vi.fn(async (url: string, options: any) => {
    harness.getCalls.push(url);
    expect(options.responseType).toBe('text');
    expect(options.timeout).toBeGreaterThan(0);
    if (harness.stalled && url === 'https://hongguoduanju.com/player/1') {
      harness.stalled.signal = options.signal;
      return new Promise(() => {});
    }
    const page = harness.pages.get(url);
    if (!page) throw Object.assign(new Error('page unavailable'), { code: 'ERR_BAD_RESPONSE' });
    return { status: 200, headers: {}, data: page };
  });
  (axios as any).post = vi.fn(async (url: string, body: any) => {
    harness.posts.push({ url, body });
    if (url.includes('multi_video_detail')) {
      return {
        status: 200,
        headers: {},
        data: JSON.stringify({
          code: 0,
          data: {
            '1': { video_data: { series_title: '测试剧', video_list: [{ vid: '11', vid_index: 1 }] } },
          },
        }),
      };
    }
    // 旧接口（preload）按实际尺寸给出两路：1080 的 HEVC 与 720 的 H.264。
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({
        code: 0,
        data: {
          '11': {
            video_model: JSON.stringify({
              video_list: harness.apiModel ?? [
                {
                  main_url: media('api-hevc'),
                  video_meta: { codec_type: 'h265', vwidth: 1080, vheight: 1920 },
                },
                {
                  main_url: media('api-avc'),
                  video_meta: { codec_type: 'H264', vwidth: 720, vheight: 1280 },
                },
              ],
            }),
          },
        },
      }),
    };
  });
});

describe('取源调度', () => {
  it('有效网页优先，不等待备用接口；并发请求合并为一次', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    harness.pages.set('https://hongguoduanju.com/player/1/11', playerPage());
    const [first, second] = await Promise.all([fetchPlayUrlSingle('11', '1'), fetchPlayUrlSingle('11', '1')]);
    expect((first as any).source).toBe('web');
    expect((second as any).url).toBe((first as any).url);
    expect(harness.appCalls).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
    expect(harness.getCalls.filter((url) => url.endsWith('/player/1/11'))).toHaveLength(1);
    // 30 秒内复用结果。
    await fetchPlayUrlSingle('11', '1');
    expect(harness.getCalls.filter((url) => url.endsWith('/player/1/11'))).toHaveLength(1);
  });

  it('网页不可用时回退 App，再回退旧接口；旧接口按实际尺寸挑源', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    // 网页全不可用 → App 接口也不可用 → 只剩旧接口。
    harness.appError = new Error('App 接口未返回本集片源模型');
    const result = (await fetchPlayUrlSingle('11', '1')) as any;
    expect(result.source).toBe('api');
    // 尺寸优先于编码：1080 的 HEVC 在 auto 下… 实际按 H.264 优先，这条由取源层保证。
    expect(result.url).toBe(media('api-avc'));
    expect(harness.appCalls).toHaveLength(1);
  });

  it('空响应不放大成多次请求', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    harness.appError = new Error('App 接口返回空响应，可能是签名或设备鉴权问题');
    await fetchPlayUrlSingle('12', '1').catch(() => {});
    expect(harness.appCalls.length).toBeLessThanOrEqual(1);
    expect(harness.posts.filter((post) => post.url.includes('multi_video_model/preload'))).toHaveLength(1);
  });

  it('显式清晰度失败不悄悄回落网页', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    harness.pages.set('https://hongguoduanju.com/player/1/11', playerPage());
    harness.appError = new Error('本集暂无尺寸可确认且满足 1080p 的 H.264/HEVC 片源，未降级');
    const result = (await fetchPlayUrlSingle('11', '1', { quality: '1080p' })) as any;
    expect(result.url).toBeNull();
    expect(result.error).toMatch(/1080p/);
    expect(harness.appCalls).toHaveLength(1);
    expect(harness.getCalls, '选了清晰度就不能用网页低清顶替').toHaveLength(0);
  });
});

describe('旧接口（兼容回退）', () => {
  it('坏主地址退回同流备份地址；两路都不能用时如实失败且不泄漏凭据', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    harness.appError = new Error('App 接口未返回本集片源模型');
    harness.apiModel = [
      { main_url: 'not a URL', backup_url: media('api-backup'), video_meta: { codec_type: 'h264' } },
    ];
    const result = (await fetchPlayUrlSingle('11', '1')) as any;
    expect(result.source).toBe('api');
    expect(result.url).toBe(media('api-backup'));

    harness.apiModel = [{ main_url: 'file:///private', backup_url: 'https://user:pass@example.com/video' }];
    const failed = (await fetchPlayUrlSingle('12', '1')) as any;
    expect(failed.url).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('user:pass');
    expect(JSON.stringify(failed)).not.toContain('file:///private');
  });
});

describe('清晰度缓存', () => {
  it('降级结果不进严格档位；各档位与 force 相互独立', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    const strict = (await fetchPlayUrlSingle('11', '1', { quality: '1080p' })) as any;
    const fallback = (await fetchPlayUrlSingle('11', '1', {
      quality: '1080p',
      allowLowerQuality: true,
    })) as any;
    expect(fallback.url).not.toBe(strict.url);
    const again = (await fetchPlayUrlSingle('11', '1', { quality: '1080p' })) as any;
    expect(again.url).toBe(strict.url);

    const fresh = (await fetchPlayUrlSingle('11', '1', { quality: '1080p', force: true })) as any;
    expect(fresh.url).not.toBe(strict.url);
    // force 只作用于自己那一档：降级结果仍在缓存里。
    const cachedFallback = (await fetchPlayUrlSingle('11', '1', {
      quality: '1080p',
      allowLowerQuality: true,
    })) as any;
    expect(cachedFallback.url).toBe(fallback.url);
    // 降级请求带 allowLowerQuality，严格请求不带。
    expect(harness.appCalls.map((call) => call.options.allowLowerQuality)).toEqual([false, true, false]);
  });

  it('旧的在途请求不能覆盖 force 刷新后的结果', async () => {
    const { fetchPlayUrlSingle } = await loadPlayer();
    let release: () => void = () => {};
    harness.appGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const strict = fetchPlayUrlSingle('11', '1', { quality: '720p' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.appCalls).toHaveLength(1);

    harness.appGate = null;
    const forced = (await fetchPlayUrlSingle('11', '1', { quality: '720p', force: true })) as any;
    release();
    const old = (await strict) as any;
    expect(old.url).not.toBe(forced.url);

    // 迟到的旧响应不能顶掉 force 的结果。
    const cached = (await fetchPlayUrlSingle('11', '1', { quality: '720p' })) as any;
    expect(cached.url).toBe(forced.url);
    expect(harness.appCalls).toHaveLength(2);
  });
});

describe('第三方源路由', () => {
  it('自定义/河马/西饭按前缀直连，不经过内置缓存与回退', async () => {
    const { fetchEpisodeList, fetchPlayUrlSingle } = await loadPlayer();
    const custom = (await fetchPlayUrlSingle(
      'custom:12345678-1234-4234-9234-123456789abc:12:1:0',
      'custom:12345678-1234-4234-9234-123456789abc:12',
      { quality: '720p' },
    )) as any;
    expect(custom.source).toBe('custom');
    expect(custom.options.quality).toBe('720p');
    expect(harness.getCalls).toHaveLength(0);
    expect(harness.appCalls).toHaveLength(0);

    expect(((await fetchPlayUrlSingle('hema:11', 'hema:1')) as any).source).toBe('hema');
    expect(((await fetchPlayUrlSingle('xifan:11', 'xifan:1')) as any).source).toBe('xifan');
    expect(((await fetchEpisodeList('hema:1')) as any).source).toBe('hema');
    expect(((await fetchEpisodeList('custom:12345678-1234-4234-9234-123456789abc:12')) as any).source).toBe(
      'custom',
    );
  });
});

describe('分集列表', () => {
  it('网页优先并标出可看范围；并发合并为一次', async () => {
    const { fetchEpisodeList } = await loadPlayer();
    harness.pages.set('https://hongguoduanju.com/player/1', detailPage('1', { accessible_episode_cnt: 1 }));
    const [first, second] = await Promise.all([fetchEpisodeList('1'), fetchEpisodeList('1')]);
    expect((first as any).total).toBe(2);
    expect((first as any).web_accessible_episodes).toBe(1);
    expect((first as any).episodes[0].web_available).toBe(true);
    expect((first as any).episodes[1].web_available).toBe(false);
    expect(second).toEqual(first);
    expect(harness.posts, '有效网页不应等待备用接口').toHaveLength(0);
    expect(harness.getCalls.filter((url) => url.endsWith('/player/1'))).toHaveLength(1);
    // 60 秒内复用。
    await fetchEpisodeList('1');
    expect(harness.getCalls.filter((url) => url.endsWith('/player/1'))).toHaveLength(1);
  });

  it('网页完全不可用时回退备用接口，并校验归属；两条网页路径都试过', async () => {
    const { fetchEpisodeList } = await loadPlayer();
    const list = (await fetchEpisodeList('1')) as any;
    expect(list.total).toBe(1);
    expect(list.episodes[0].vid).toBe('11');
    expect(harness.posts.some((post) => post.url.includes('multi_video_detail'))).toBe(true);
    // 播放页与详情页两条路径都要试过，不能因为一条失败就放弃。
    expect(harness.getCalls).toContain('https://hongguoduanju.com/player/1');
    expect(harness.getCalls.some((url) => url.includes('/detail?series_id=1'))).toBe(true);
  });

  it('详情页胜出时，仍在等待的播放页会被取消', async () => {
    const { fetchEpisodeList } = await loadPlayer();
    harness.pages.set('https://hongguoduanju.com/detail?series_id=1', detailPage());
    harness.stalled = { signal: new AbortController().signal };
    const list = (await fetchEpisodeList('1')) as any;
    expect(list.total).toBe(2);
    expect(harness.stalled.signal?.aborted, '慢路径必须在胜出后取消').toBe(true);
  });
});

describe('缓存有效期', () => {
  it('播放地址 30 秒、分集 60 秒到期后才重新取', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    try {
      const { fetchEpisodeList, fetchPlayUrlSingle } = await loadPlayer();
      harness.pages.set('https://hongguoduanju.com/player/1/11', playerPage());
      harness.pages.set('https://hongguoduanju.com/player/1', detailPage());
      const play = async () => (await fetchPlayUrlSingle('11', '1')) as any;
      const list = async () => (await fetchEpisodeList('1')) as any;
      await play();
      await list();
      const playGets = harness.getCalls.filter((url) => url.endsWith('/player/1/11')).length;
      const listGets = harness.getCalls.filter((url) => url.endsWith('/player/1')).length;

      vi.advanceTimersByTime(29_999);
      await play();
      await list();
      expect(
        harness.getCalls.filter((url) => url.endsWith('/player/1/11')),
        '未到期不重复取',
      ).toHaveLength(playGets);

      vi.advanceTimersByTime(2);
      await play();
      expect(
        harness.getCalls.filter((url) => url.endsWith('/player/1/11')).length,
        '播放地址 30 秒后刷新',
      ).toBe(playGets + 1);

      vi.advanceTimersByTime(30_000);
      await list();
      expect(harness.getCalls.filter((url) => url.endsWith('/player/1')).length, '分集 60 秒后刷新').toBe(
        listGets + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
