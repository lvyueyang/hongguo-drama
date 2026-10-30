/**
 * 剧库播放器的续播与进度持久化。
 *
 * 替代 4.5 `scripts/check-player-resume.cjs` 里属于**进度语义**的部分：
 * 还原「节流 5 秒 / 暂停与播完立即写 / 播完置 watched / 看完连播下一集 / 跨集不套用旧时间」。
 * 4.5 里另有转码回退、兼容缓存、全屏滚动还原、合并质量弹窗等大 Player 专属能力，5.0 的
 * 剧库页没有对应 UI（转码与合并入口在下载管理器 / 主进程），不在本文件范围。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type PlayRequest = { vid: string; seriesId: string; quality: string };
type Save = {
  seriesId: string;
  vid: string;
  vidIndex: number;
  currentTime: number;
  duration: number;
  watched: boolean;
};

const episodes = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
  { vid: 'v3', vid_index: 3 },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    libraryList: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: [{ series_id: 'A', series_title: '测试剧' }],
      }),
    ),
    seriesEpisodes: vi.fn<(seriesId: string) => Promise<Envelope>>(async () => ({
      ok: true,
      data: { series_id: 'A', series_title: '测试剧', total: 3, episodes },
    })),
    playPrepare: vi.fn<(request: PlayRequest) => Promise<Envelope>>(async (request) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${request.vid}`, sessionId: request.vid },
    })),
    progressGet: vi.fn<(request: { seriesId: string }) => Promise<Envelope>>(async () => ({
      ok: true,
      data: null,
    })),
    progressSave: vi.fn<(request: Save) => Promise<Envelope>>(async () => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { items: [], notice: '' } })),
    playPrefetch: vi.fn(
      async (): Promise<Envelope> => ({ ok: true, data: { target: 'v2', status: 'prefetched' } }),
    ),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Library />
    </QueryClientProvider>,
  );
}

/** 进入剧集详情：只选剧，不播放。 */
async function openSeries() {
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 3 集')).toBeTruthy());
}

function episodeButton(index: number): HTMLElement {
  return screen.getAllByTitle('单击选中下载，双击播放')[index] as HTMLElement;
}

/** 双击分集按钮开始播放，返回真正的 video 元素。 */
async function play(index: number): Promise<HTMLVideoElement> {
  await act(async () => {
    fireEvent.doubleClick(episodeButton(index));
  });
  return waitFor(() => {
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    return video as HTMLVideoElement;
  });
}

/** jsdom 没有真实媒体：把时长/时间做成可控属性，播放事件由 fireEvent 驱动。 */
function controllableMedia(video: HTMLVideoElement, duration = 100) {
  const state = { currentTime: 0, duration };
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value;
    },
  });
  Object.defineProperty(video, 'duration', { configurable: true, get: () => state.duration });
  const seek = (seconds: number) => {
    state.currentTime = seconds;
  };
  return { state, seek };
}

function saves(api: { progressSave: { mock: { calls: Save[][] } } }): Save[] {
  return api.progressSave.mock.calls.map((call) => call[0]);
}

let offset = 0;
const realNow = Date.now.bind(Date);

beforeEach(() => {
  offset = 0;
  window.localStorage.clear();
  // 只平移时间基准：真实时间照旧前进，waitFor 的超时判断不会被冻住。
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('播放进度的节流与落盘', () => {
  it('播放中每 5 秒最多写一次，写的是原始秒数与集数', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);
    await waitFor(() => expect(api.progressGet).toHaveBeenCalledWith({ seriesId: 'A' }));

    media.seek(12.5);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(saves(api).length).toBe(1));
    expect(saves(api)[0]).toMatchObject({
      seriesId: 'A',
      vid: 'v1',
      vidIndex: 1,
      currentTime: 12.5,
      duration: 100,
      watched: false,
    });

    // 节流窗口内：连续 timeupdate 一条都不写。
    offset += 2000;
    media.seek(15);
    fireEvent.timeUpdate(video);
    fireEvent.timeUpdate(video);
    expect(saves(api).length).toBe(1);

    // 越过 5 秒：再写一次，并把新秒数带上去。
    offset += 4000;
    media.seek(21);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(saves(api).length).toBe(2));
    expect(saves(api)[1]).toMatchObject({ currentTime: 21, watched: false });
  });

  it('暂停立刻落盘并置 watched，不受 5 秒节流限制', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);

    // 真的开始播放（自动播放被拦时不会有 play 事件，那种情况不算看过）
    fireEvent.play(video);
    media.seek(30);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(saves(api).length).toBe(1));

    // 同一秒内暂停：节流窗口内也必须写，且带 watched。
    media.seek(31);
    fireEvent.pause(video);
    await waitFor(() => expect(saves(api).length).toBe(2));
    expect(saves(api)[1]).toMatchObject({ currentTime: 31, watched: true });
  });

  it('播完写 watched 与真实时长，随后自动连播下一集，视频元素不叠加', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video, 100);
    media.seek(100);

    await act(async () => {
      fireEvent.ended(video);
    });
    expect(saves(api).at(-1)).toMatchObject({
      vid: 'v1',
      vidIndex: 1,
      duration: 100,
      watched: true,
    });
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    expect(api.playPrepare.mock.calls[1][0]).toMatchObject({ vid: 'v2', seriesId: 'A' });
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v2');
  });

  it('关闭连播后播完不再自动换集', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    controllableMedia(video, 100);

    // 5.0 的连播开关只有快捷键（4.5 控制条上的「连播」按钮已随自定义控件条一起去掉）。
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA' });
    await waitFor(() => expect(screen.getByText(/连播关/)).toBeTruthy());

    await act(async () => {
      fireEvent.ended(video);
    });
    expect(api.playPrepare).toHaveBeenCalledTimes(1);
    expect(saves(api).at(-1)).toMatchObject({ vid: 'v1', watched: true });
  });

  it('最后一集播完没有下一集可播', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(2);
    controllableMedia(video, 100);

    await act(async () => {
      fireEvent.ended(video);
    });
    expect(api.playPrepare).toHaveBeenCalledTimes(1);
    expect(saves(api).at(-1)).toMatchObject({ vid: 'v3', watched: true });
  });

  it('下一集锁定时不自动播放，仍把当前集记为看完', async () => {
    const api = installApi({
      seriesEpisodes: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: {
            series_id: 'A',
            series_title: '测试剧',
            total: 2,
            episodes: [
              { vid: 'v1', vid_index: 1 },
              { vid: 'v2', vid_index: 2, locked: true },
            ],
          },
        }),
      ),
    });
    renderLibrary();
    fireEvent.click(await screen.findByText('测试剧'));
    await waitFor(() => expect(screen.getByText('共 2 集')).toBeTruthy());
    const video = await play(0);
    controllableMedia(video, 100);

    await act(async () => {
      fireEvent.ended(video);
    });
    expect(api.playPrepare).toHaveBeenCalledTimes(1);
    expect(saves(api).at(-1)).toMatchObject({ vid: 'v1', watched: true });
  });

  it('进度保存失败不影响播放', async () => {
    const api = installApi({
      progressSave: vi.fn(
        async (): Promise<Envelope> => ({
          ok: false,
          error: { code: 'STORAGE_UNAVAILABLE', message: '磁盘已满' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);
    media.seek(9);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(api.progressSave).toHaveBeenCalledTimes(1));
    offset += 6000;
    media.seek(18);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(api.progressSave).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('正在播放 第 1 集')).toBeTruthy();
  });

  it('渲染层上报原始时间，进度取大由主进程负责（见 main/progress.test.ts）', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);

    media.seek(60);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(saves(api).length).toBe(1));
    // 拖动回看：这里照样把更小的秒数发出去，夹紧（不写小）在主进程 progressPort 里。
    offset += 6000;
    media.seek(20);
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(saves(api).length).toBe(2));
    expect(saves(api)[1].currentTime).toBe(20);
  });
});

describe('续播', () => {
  it('进度属于别的集时不套用旧时间，也不提示续播', async () => {
    const api = installApi({
      progressGet: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { vid: 'v3', vidIndex: 3, currentTime: 34, duration: 100, updatedAt: 1, watched: false },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);
    await waitFor(() => expect(api.progressGet).toHaveBeenCalledWith({ seriesId: 'A' }));

    expect(media.state.currentTime).toBe(0);
    expect(screen.queryByText(/从上次的/)).toBeNull();
  });

  // 续播恢复点在 onLoadedMetadata（首播时 playPrepare 的 onSuccess 里 video 元素还没挂载）。
  it('同一集存过进度时，播放应回到上次的秒数并给出提示', async () => {
    const api = installApi({
      progressGet: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { vid: 'v1', vidIndex: 1, currentTime: 34, duration: 100, updatedAt: 1, watched: false },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);
    await waitFor(() => expect(api.progressGet).toHaveBeenCalledWith({ seriesId: 'A' }));
    await act(async () => {
      fireEvent.loadedMetadata(video);
    });
    expect(media.state.currentTime).toBe(34);
    expect(screen.getByText(/从上次的 34 秒继续/)).toBeTruthy();
  });

  it('换集前保存上一集的位置（不受 5 秒节流限制）', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    const video = await play(0);
    const media = controllableMedia(video);
    media.seek(37);
    // 还没到 5 秒节流窗口：立刻换集也必须写掉
    await act(async () => {
      fireEvent.doubleClick(episodeButton(1));
    });
    await waitFor(() =>
      expect(saves(api).some((save) => save.vid === 'v1' && save.currentTime === 37)).toBe(true),
    );
  });

  it('晚到的取流回复不劫持当前集', async () => {
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    const api = installApi({
      playPrepare: vi.fn(async ({ vid }: { vid: string }) => {
        call += 1;
        if (call === 1)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        return { ok: true, data: { url: `hongguo-stream://play/${vid}`, sessionId: vid } } as Envelope;
      }),
    });
    renderLibrary();
    await openSeries();
    await act(async () => {
      fireEvent.doubleClick(episodeButton(0));
    });
    await act(async () => {
      fireEvent.doubleClick(episodeButton(1));
    });
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v2'),
    );
    // 第一集（v1）的回复此刻才到：不能把正在播的第二集顶掉
    await act(async () => {
      releaseFirst?.();
      await Promise.resolve();
    });
    expect(document.querySelector('video')?.getAttribute('src')).toContain('v2');
    expect(document.querySelector('video')?.getAttribute('src')).not.toContain('/v1');
    void api;
  });

  it('取流失败后重试成功，旧的失败提示要被清掉', async () => {
    let attempt = 0;
    installApi({
      playPrepare: vi.fn(async ({ vid }: { vid: string }) => {
        attempt += 1;
        if (attempt === 1) return { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: '取源失败' } };
        return { ok: true, data: { url: `hongguo-stream://play/${vid}`, sessionId: vid } } as Envelope;
      }),
    });
    renderLibrary();
    await openSeries();
    await act(async () => {
      fireEvent.doubleClick(episodeButton(0));
    });
    await waitFor(() => expect(screen.getByText(/播放失败：取源失败/)).toBeTruthy());
    await act(async () => {
      fireEvent.doubleClick(episodeButton(0));
    });
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
    expect(screen.queryByText(/播放失败/)).toBeNull();
  });

  it('分集加载失败时显示原因并可重试', async () => {
    let failed = false;
    const api = installApi({
      seriesEpisodes: vi.fn(async () => {
        if (!failed) {
          failed = true;
          return { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: '分集接口超时' } };
        }
        return { ok: true, data: { series_id: 'A', series_title: '测试剧', total: 3, episodes } };
      }),
    });
    renderLibrary();
    fireEvent.click(await screen.findByText('测试剧'));
    await waitFor(() => expect(screen.getByText(/分集加载失败：分集接口超时/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText('重试'));
    });
    await waitFor(() => expect(screen.queryByText(/分集加载失败/)).toBeNull());
    expect(api.seriesEpisodes).toHaveBeenCalledTimes(2);
  });
});

it('从未真正播放过（自动播放被拦/只加载了元数据）时，暂停不算看过', async () => {
  const api = installApi();
  renderLibrary();
  await openSeries();
  const video = await play(0);
  const media = controllableMedia(video);
  media.seek(8);
  // 没有 play 事件 → 用户没看到画面
  fireEvent.pause(video);
  await waitFor(() => expect(saves(api).length).toBe(1));
  expect(saves(api)[0]).toMatchObject({ vid: 'v1', currentTime: 8, watched: false });
});
