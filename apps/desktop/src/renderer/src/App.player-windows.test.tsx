/**
 * 主窗口的「页面互斥」与悬浮小窗的独立布局。
 *
 * 替代 4.5 `scripts/check-player-navigation.cjs`（导航互斥、后台控件、画中画）与
 * `scripts/check-player-navigation-refresh.cjs`（导航前后的刷新/迟到结果语义）。
 *
 * 5.0 的结构完全不同：4.5 是「一个大 Player 组件常驻、靠 active 关掉快捷键」，5.0 是
 * `App.tsx` 按页面渲染、离开即卸载，悬浮窗是同一个渲染入口的 `?floating=1` 独立布局
 * （见 App.tsx:48 与 FloatingPlayer.tsx:8）。所以这里验的不变量换成：
 * 离开页面播放器真的卸载、迟到的取流结果不会在后台自动播放、后台不留全局快捷键、
 * 小窗不挂主界面。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.tsx';

type Envelope = { ok: true; data: unknown };
type PlayRequest = { vid: string; seriesId: string; quality: string };

const episodes = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
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
      data: { series_id: 'A', series_title: '测试剧', total: 2, episodes },
    })),
    playPrepare: vi.fn<(request: PlayRequest) => Promise<Envelope>>(async (request) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${request.vid}`, sessionId: request.vid },
    })),
    progressGet: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: null })),
    progressSave: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { items: [], notice: '' } })),
    playPrefetch: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { status: 'prefetched' } })),
    browseList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: [] })),
    historyList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: [] })),
    historyRefresh: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { checked: 0, failed: 0 } })),
    playerFloatClose: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { closed: true } })),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function navigate(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

async function openAndPlay(): Promise<HTMLVideoElement> {
  navigate('我的剧库');
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 2 集')).toBeTruthy());
  await act(async () => {
    fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[0] as HTMLElement);
  });
  return waitFor(() => {
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    return video as HTMLVideoElement;
  });
}

function controllableMedia(video: HTMLVideoElement) {
  const state = { paused: true, currentTime: 0, duration: 100 };
  Object.defineProperty(video, 'paused', { configurable: true, get: () => state.paused });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value;
    },
  });
  Object.defineProperty(video, 'duration', { configurable: true, get: () => state.duration });
  const play = vi.fn(async () => {
    state.paused = false;
  });
  const pause = vi.fn(() => {
    state.paused = true;
  });
  Object.defineProperty(video, 'play', { configurable: true, value: play });
  Object.defineProperty(video, 'pause', { configurable: true, value: pause });
  return { state, play, pause };
}

/** 记录 window 上 keydown 监听的注册/解除次数（验「后台不留快捷键」的清理接线）。 */
function trackKeydownListeners() {
  const adds = { count: 0 };
  const removes = { count: 0 };
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ) => {
    if (String(type) === 'keydown') adds.count++;
    return add.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions,
  ) => {
    if (String(type) === 'keydown') removes.count++;
    return remove.call(window, type, listener, options);
  }) as typeof window.removeEventListener;
  return {
    adds,
    removes,
    restore() {
      window.addEventListener = add;
      window.removeEventListener = remove;
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('页面互斥：离开页面就卸载播放器', () => {
  it('播放中切到别的页面，播放器节点消失，回到剧库也不会自动重播', async () => {
    const api = installApi();
    renderApp();
    const video = await openAndPlay();
    controllableMedia(video);
    expect(api.playPrepare).toHaveBeenCalledTimes(1);

    navigate('观看记录');
    await waitFor(() => expect(screen.queryByText('共 2 集')).toBeNull());
    // 没有「隐藏起来继续播」的后台播放器（4.5 会保留常驻 Player 并置 active=false）。
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelectorAll('video')).toHaveLength(0);

    navigate('我的剧库');
    await screen.findByText('测试剧');
    expect(document.querySelector('video')).toBeNull();
    expect(api.playPrepare).toHaveBeenCalledTimes(1);
  });

  it('离开页面时解除全局快捷键监听', async () => {
    const tracker = trackKeydownListeners();
    try {
      installApi();
      renderApp();
      const video = await openAndPlay();
      controllableMedia(video);
      expect(tracker.adds.count).toBeGreaterThan(0);

      navigate('观看记录');
      await waitFor(() => expect(screen.queryByText('共 2 集')).toBeNull());
      expect(tracker.removes.count).toBe(tracker.adds.count);
    } finally {
      tracker.restore();
    }
  });

  it('离开页面后才到的取流结果不会在后台自动播放', async () => {
    let resolvePrepare: ((value: Envelope) => void) | null = null;
    const api = installApi({
      playPrepare: vi.fn(
        () =>
          new Promise<Envelope>((resolve) => {
            resolvePrepare = resolve;
          }),
      ),
    });
    renderApp();
    navigate('我的剧库');
    fireEvent.click(await screen.findByText('测试剧'));
    await waitFor(() => expect(screen.getByText('共 2 集')).toBeTruthy());
    await act(async () => {
      fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[0] as HTMLElement);
    });

    navigate('观看记录');
    await waitFor(() => expect(screen.queryByText('共 2 集')).toBeNull());
    await act(async () => {
      resolvePrepare?.({ ok: true, data: { url: 'hongguo-stream://late', sessionId: 'late' } });
    });

    expect(document.querySelector('video')).toBeNull();
    expect(api.progressSave).not.toHaveBeenCalled();
  });
});

describe('悬浮小窗是独立布局', () => {
  it('?floating=1 只渲染小窗：不挂主界面导航，也不查剧库', async () => {
    window.history.replaceState({}, '', '/?floating=1&vid=v1&seriesId=A');
    const api = installApi();
    renderApp();

    const video = await screen.findByLabelText('悬浮小窗播放');
    expect(video).toBeTruthy();
    expect(api.playPrepare).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A', quality: 'auto', force: false });
    expect(screen.queryByRole('button', { name: '我的剧库' })).toBeNull();
    expect(screen.queryByRole('button', { name: '搜索与下载' })).toBeNull();
    expect(screen.queryByText('红果短剧')).toBeNull();
    expect(api.libraryList).not.toHaveBeenCalled();
    // 小窗会查一次分集表：它要靠这张表知道真实集号与下一集（写死第 1 集会让观看记录错位）。
    // 但那只走 series:episodes，不碰剧库列表。
    expect(api.seriesEpisodes).toHaveBeenCalledWith('A');
  });

  it('小窗不注册主窗口的播放快捷键', async () => {
    window.history.replaceState({}, '', '/?floating=1&vid=v1&seriesId=A');
    const tracker = trackKeydownListeners();
    try {
      installApi();
      renderApp();
      const video = (await screen.findByLabelText('悬浮小窗播放')) as HTMLVideoElement;
      const media = controllableMedia(video);
      // 小窗里的播放交给原生控件；按空格不该被任何播放控制逻辑接管。
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      expect(media.play).not.toHaveBeenCalled();
      expect(tracker.adds.count).toBe(0);
    } finally {
      tracker.restore();
    }
  });

  it('小窗的「收回主窗口」走 floatClose', async () => {
    window.history.replaceState({}, '', '/?floating=1&vid=v1&seriesId=A');
    const api = installApi();
    renderApp();
    await screen.findByLabelText('悬浮小窗播放');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '收回主窗口' }));
    });
    expect(api.playerFloatClose).toHaveBeenCalledTimes(1);
  });

  it('参数不全时回落到主界面', async () => {
    window.history.replaceState({}, '', '/?floating=1');
    installApi();
    renderApp();
    expect(await screen.findByRole('button', { name: '我的剧库' })).toBeTruthy();
    expect(screen.queryByLabelText('悬浮小窗播放')).toBeNull();
  });
});
