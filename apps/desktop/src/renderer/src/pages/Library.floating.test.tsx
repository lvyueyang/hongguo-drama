/**
 * 剧库播放器的「悬浮小窗」开关。
 *
 * 替代 4.5 `scripts/check-player-controls.cjs` 里**装在 5.0 还幸存**的那部分：自定义悬浮窗开关
 * 的状态与回调、系统画中画与自定义小窗的取舍、来源变化（换集）不得关掉用户开的悬浮窗。
 * 4.5 的自定义控件条（自动隐藏、全屏标题、清晰度菜单、4× 倍速菜单、指针闲置一秒）随
 * `<video controls>` 一起消失，没有 5.0 对应物，按 obsolete 处理。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

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
    getSettings: vi.fn(
      async (): Promise<Envelope> => ({ ok: true, data: { picture_in_picture_mode: 'custom' } }),
    ),
    playerFloatOpen: vi.fn<(request: { vid: string; seriesId: string }) => Promise<Envelope>>(async () => ({
      ok: true,
      data: { opened: true },
    })),
    playerFloatClose: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { closed: true } })),
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

async function play(index = 0): Promise<HTMLVideoElement> {
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 2 集')).toBeTruthy());
  const button = screen.getAllByTitle('单击选中下载，双击播放')[index] as HTMLElement;
  await act(async () => {
    fireEvent.doubleClick(button);
  });
  return waitFor(() => {
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    return video as HTMLVideoElement;
  });
}

/** 给 video 装一个「系统画中画」替身，并让 document.pictureInPictureElement 跟着变。 */
function stubPictureInPicture(video: HTMLVideoElement, mode: 'resolve' | 'reject') {
  const request = vi.fn(async () => {
    if (mode === 'reject') throw new Error('系统拒绝画中画');
    return {};
  });
  let current: Element | null = null;
  Object.defineProperty(video, 'requestPictureInPicture', { configurable: true, value: request });
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => current });
  return {
    request,
    settle() {
      current = video;
    },
    restore() {
      Reflect.deleteProperty(video, 'requestPictureInPicture');
      Reflect.deleteProperty(document, 'pictureInPictureElement');
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('悬浮小窗开关', () => {
  it('设为应用自带小窗时直接开悬浮窗，不问系统画中画', async () => {
    const api = installApi();
    renderLibrary();
    const video = await play(0);
    const pip = stubPictureInPicture(video, 'resolve');
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
      });
      expect(pip.request).not.toHaveBeenCalled();
      expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' });
      await waitFor(() => expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy());
    } finally {
      pip.restore();
    }
  });

  it('设为系统画中画时交给浏览器，不再开自带窗口', async () => {
    const api = installApi({
      getSettings: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { picture_in_picture_mode: 'native' } }),
      ),
    });
    renderLibrary();
    const video = await play(0);
    const pip = stubPictureInPicture(video, 'resolve');
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
      });
      expect(pip.request).toHaveBeenCalledTimes(1);
      expect(api.playerFloatOpen).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy());
    } finally {
      pip.restore();
    }
  });

  it('宿主没有系统画中画能力时静默退回自带小窗', async () => {
    const api = installApi({
      getSettings: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { picture_in_picture_mode: 'native' } }),
      ),
    });
    renderLibrary();
    await play(0);
    // jsdom 的 video 没有 requestPictureInPicture：等价于宿主不支持系统画中画。
    // 此时连「请求被拒」都算不上，所以不开提示，直接静默开自带小窗。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
    });
    expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' });
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy());
    expect(screen.queryByText(/系统不支持画中画/)).toBeNull();
  });

  it('系统画中画被拒绝时退回自带小窗，并说明原因', async () => {
    const api = installApi({
      getSettings: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { picture_in_picture_mode: 'native' } }),
      ),
    });
    renderLibrary();
    const video = await play(0);
    const pip = stubPictureInPicture(video, 'reject');
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
      });
      expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' });
      await waitFor(() => expect(screen.getByText('系统不支持画中画，已改用悬浮小窗')).toBeTruthy());
    } finally {
      pip.restore();
    }
  });

  it('再点一次关闭小窗，按钮回到「悬浮小窗」', async () => {
    const api = installApi();
    renderLibrary();
    await play(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭悬浮小窗' }));
    });
    expect(api.playerFloatClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: '悬浮小窗' })).toBeTruthy());
  });

  it('换集（来源变化）不会关掉用户开的悬浮窗，取的是当前这一集', async () => {
    const api = installApi();
    renderLibrary();
    await play(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy());

    await act(async () => {
      fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[1] as HTMLElement);
    });
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    expect(api.playerFloatClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '关闭悬浮小窗' })).toBeTruthy();

    // 关掉再开：小窗请求的是换过去的第 2 集，而不是第 1 集。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭悬浮小窗' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '悬浮小窗' }));
    });
    expect(api.playerFloatOpen.mock.calls.at(-1)?.[0]).toEqual({ vid: 'v2', seriesId: 'A' });
  });
});
