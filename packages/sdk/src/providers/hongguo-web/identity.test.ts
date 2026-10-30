/**
 * 分集列表的身份归属（迁移自 4.5 `scripts/check-hongguo-identity.cjs`）。
 *
 * 不变量：**分集必须属于请求的那部剧**。官网页面会把推荐位、外层 request 等
 * 无关的 series_id/vid_list 一起塞进 SSR 数据里，取错一处就会把别人的分集当成本剧，
 * 所以这里必须"取不到就失败"，而不是退回第一个键或第一项。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosMock } = vi.hoisted(() => ({
  axiosMock: vi.fn() as unknown as {
    mockReset(): void;
    mockImplementation(fn: (...args: unknown[]) => unknown): void;
    mock: { calls: unknown[][] };
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('axios', () => ({ default: axiosMock }));
vi.mock('../../providers/hongguo-app/device.ts', () => ({
  getPlaybackDevice: async () => ({
    device_id: '7000000000000000001',
    iid: '7000000000000000002',
    cdid: '00000000-0000-4000-8000-000000000003',
  }),
  registerPlaybackDevice: async () => ({}),
}));

const { fetchEpisodeList, fetchEpisodeListFromWeb } = await import('./player.ts');

function playerPage(
  detail: Record<string, unknown>,
  data: Record<string, unknown> = {},
  before: Record<string, unknown> = {},
  route = 'player_(series_id)/(vid)/page',
): string {
  return `<script>window._ROUTER_DATA=${JSON.stringify({
    ...before,
    loaderData: {
      player_layout: { series_id: '999', vid_list: ['21'] },
      [route]: { isSuccess: true, series_id: detail.series_id, seriesDetail: detail, ...data },
    },
  })}</script>`;
}

beforeEach(() => {
  axiosMock.mockReset();
  axiosMock.get = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '' });
  axiosMock.post = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: '' });
});

describe('整剧入口页解析', () => {
  it('取当前页的 vid_list / 标题 / 封面，并按 accessible_episode_cnt 标记可看性', async () => {
    axiosMock.get.mockResolvedValue({
      status: 200,
      headers: {},
      data: playerPage(
        {
          series_id: '123458',
          series_name: '整剧入口',
          vid_list: ['31', '32'],
          series_cover: 'https://img.example/series.jpg',
          accessible_episode_cnt: 1,
        },
        {},
        {},
        'player_(series_id)/page',
      ),
    });
    const page = (await fetchEpisodeListFromWeb('123458')) as {
      episodes: Array<{ vid: string; web_available?: boolean }>;
      series_title?: string;
      cover?: string;
    };
    expect(page.episodes.map((item) => item.vid)).toEqual(['31', '32']);
    expect(page.series_title).toBe('整剧入口');
    expect(page.cover).toBe('https://img.example/series.jpg');
    expect(page.episodes.map((item) => item.web_available)).toEqual([true, false]);
  });

  it('缺编号或编号不符时失败，不退回第一个键', async () => {
    for (const detail of [{ vid_list: ['31'] }, { series_id: '999', vid_list: ['31'] }]) {
      axiosMock.get.mockResolvedValue({
        status: 200,
        headers: {},
        data: playerPage(detail, {}, {}, 'player_(series_id)/page'),
      });
      await expect(fetchEpisodeListFromWeb('123458')).rejects.toThrow(/剧集/);
    }
  });

  it('推荐位、外层 request 或 isSuccess=false 都不能冒充当前剧', async () => {
    const cases = [
      playerPage({ series_name: '缺少编号', vid_list: ['21'] }),
      playerPage({ series_id: '999', series_name: '另一部', vid_list: ['21'] }),
      playerPage({ series_id: '123456', series_name: '本剧', vid_list: ['11'] }, { series_id: '999' }),
      playerPage({ series_id: '123456', series_name: '本剧', vid_list: ['11'] }, { isSuccess: false }),
      '<script>window._ROUTER_DATA={"recommendation":{"series_id":"123456","vid_list":["21"]}}</script>',
    ];
    for (const html of cases) {
      axiosMock.get.mockResolvedValue({ status: 200, headers: {}, data: html });
      await expect(fetchEpisodeListFromWeb('123456')).rejects.toThrow(/剧集|分集/);
    }
  });

  it('页面同时带推荐位时，只取当前播放器的分集与封面', async () => {
    axiosMock.get.mockResolvedValue({
      status: 200,
      headers: {},
      data: playerPage(
        {
          series_id: '123456',
          series_name: '本剧"原名"',
          series_cover: 'https://img.example/current.jpg',
          vid_list: ['11', '12'],
          accessible_episode_cnt: 1,
        },
        {},
        {
          request: { series_id: '123456' },
          recommendation: {
            series_id: '999',
            series_name: '推荐剧',
            series_cover: 'https://img.example/other.jpg',
            vid_list: ['21'],
            accessible_episode_cnt: 0,
          },
        },
      ),
    });
    const bound = (await fetchEpisodeListFromWeb('123456')) as {
      episodes: Array<{ vid: string; web_available?: boolean }>;
      series_title?: string;
      cover?: string;
    };
    expect(bound.episodes.map((item) => item.vid)).toEqual(['11', '12']);
    expect(bound.series_title).toBe('本剧"原名"');
    expect(bound.cover).toBe('https://img.example/current.jpg');
    expect(bound.episodes.map((item) => item.web_available)).toEqual([true, false]);
  });
});

describe('整体取分集：网页与 App 备用接口都必须与请求一致', () => {
  it('App 备用接口返回别的剧时报错', async () => {
    axiosMock.get.mockResolvedValue({
      status: 200,
      headers: {},
      data: '<script>{"series_id":"999","series_name":"另一部","vid_list":["1","2"]}</script>',
    });
    axiosMock.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: Buffer.from(JSON.stringify({ code: 0, data: {} })),
    });
    await expect(fetchEpisodeList('123456')).rejects.toThrow(/不一致/);
  });

  it('备用接口返回的键与请求不符时报错（不取第一个键）', async () => {
    axiosMock.get.mockImplementation(async () => {
      throw new Error('web unavailable');
    });
    axiosMock.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: Buffer.from(
        JSON.stringify({
          code: 0,
          data: {
            '999999': {
              video_data: {
                series_title: '另一部',
                series_id: '999999',
                video_list: [{ vid: '1', vid_index: 1, series_id: '999999' }],
              },
            },
          },
        }),
      ),
    });
    await expect(fetchEpisodeList('123459')).rejects.toThrow(/不一致/);
  });

  it('网页可用时以其为准', async () => {
    axiosMock.get.mockResolvedValue({
      status: 200,
      headers: {},
      data: playerPage({ series_id: '123456', series_name: '本剧', vid_list: ['11', '12'] }),
    });
    const web = (await fetchEpisodeList('123456')) as { episodes: Array<{ vid: string }>; series_id: string };
    expect(web.episodes.map((item) => item.vid)).toEqual(['11', '12']);
    expect(web.series_id).toBe('123456');
  });

  it('网页不可用时回落到 App 备用接口，且归属仍要匹配', async () => {
    axiosMock.get.mockImplementation(async () => {
      throw new Error('web unavailable');
    });
    axiosMock.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: Buffer.from(
        JSON.stringify({
          code: 0,
          data: {
            '123457': {
              video_data: {
                series_title: '本剧',
                series_id: '123457',
                video_list: [{ vid: '21', vid_index: 1, series_id: '123457' }],
              },
            },
          },
        }),
      ),
    });
    const api = (await fetchEpisodeList('123457')) as { episodes: Array<{ vid: string }>; series_id: string };
    expect(api.episodes.map((item) => item.vid)).toEqual(['21']);
    expect(api.series_id).toBe('123457');
  });
});
