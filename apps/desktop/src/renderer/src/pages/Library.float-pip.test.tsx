/**
 * 悬浮小窗开关与画中画模式取舍的等价用例。
 *
 * 迁自 `scripts/check-floating-player-host.cjs` 与 `scripts/check-settings-picture-in-picture.cjs`
 * 里 5.0 仍然成立的部分：开关把当前集交给主进程建窗、收回后主窗口继续原集播放、
 * `picture_in_picture_mode` 决定走系统画中画还是应用自带小窗（缺省按 native），
 * 系统画中画被拒时回落到自带小窗并说明原因。
 * 4.5 的「单媒体节点迁移 / 进小窗继承播放进度 / 原生窗口标题跟随剧集」在 5.0 是另一个
 * BrowserWindow（`main/floating-window.ts` + `pages/FloatingPlayer.tsx`），由既有
 * `main/floating-window.test.ts` 与 `pages/FloatingPlayer.test.tsx` 覆盖，这里不重复。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

const EPISODES = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    libraryList: vi.fn(async () => ({ ok: true, data: [{ series_id: 'A', series_title: '剧A' }] })),
    seriesEpisodes: vi.fn(async () => ({
      ok: true,
      data: { series_id: 'A', series_title: '剧A', episodes: EPISODES },
    })),
    playPrepare: vi.fn(async ({ vid }: { vid: string }) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${vid}`, sessionId: vid },
    })),
    progressGet: vi.fn(async () => ({ ok: true, data: null })),
    progressSave: vi.fn(async () => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async () => ({ ok: true, data: { items: [] } })),
    playPrefetch: vi.fn(async () => ({ ok: true, data: { target: 'v2', status: 'prefetched' } })),
    getSettings: vi.fn(async () => ({ ok: true, data: { picture_in_picture_mode: 'custom' } })),
    playerFloatOpen: vi.fn(async () => ({ ok: true, data: { opened: true } })),
    playerFloatClose: vi.fn(async () => ({ ok: true, data: { closed: true } })),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Library />
    </QueryClientProvider>,
  );
}

async function playFirstEpisode(): Promise<HTMLVideoElement> {
  renderPage();
  fireEvent.click(await screen.findByText('剧A'));
  fireEvent.doubleClick(
    (await screen.findByText('1', { selector: 'span.font-medium' })).closest('button') as HTMLElement,
  );
  await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
  return document.querySelector('video') as HTMLVideoElement;
}

const source = (): string | null => document.querySelector('video')?.getAttribute('src') ?? null;

afterEach(() => cleanup());

describe('悬浮小窗开关', () => {
  it('custom 模式把当前集交给主进程建窗，再点收回', async () => {
    const api = installApi();
    await playFirstEpisode();

    fireEvent.click(screen.getByText('悬浮小窗'));
    await waitFor(() => expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' }));
    await screen.findByText('关闭悬浮小窗');

    fireEvent.click(screen.getByText('关闭悬浮小窗'));
    await waitFor(() => expect(api.playerFloatClose).toHaveBeenCalledTimes(1));
    await screen.findByText('悬浮小窗');
  });

  it('收回小窗后主窗口仍在原集播放，不重新取流', async () => {
    const api = installApi();
    await playFirstEpisode();
    const before = source();

    fireEvent.click(screen.getByText('悬浮小窗'));
    await screen.findByText('关闭悬浮小窗');
    fireEvent.click(screen.getByText('关闭悬浮小窗'));
    await screen.findByText('悬浮小窗');

    expect(api.playPrepare).toHaveBeenCalledTimes(1);
    expect(source()).toBe(before);
  });
});

describe('画中画模式取舍', () => {
  it('native 模式优先系统画中画，成功时不建自带小窗', async () => {
    const api = installApi({
      getSettings: vi.fn(async () => ({ ok: true, data: { picture_in_picture_mode: 'native' } })),
    });
    const video = await playFirstEpisode();
    const request = vi.fn(async () => undefined);
    Object.defineProperty(video, 'requestPictureInPicture', { value: request, configurable: true });

    fireEvent.click(screen.getByText('悬浮小窗'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await screen.findByText('关闭悬浮小窗');
    expect(api.playerFloatOpen).not.toHaveBeenCalled();
  });

  it('缺省（没有该设置）按 native 处理；系统没有画中画能力时走自带小窗', async () => {
    const api = installApi({
      getSettings: vi.fn(async () => ({ ok: true, data: {} })),
    });
    await playFirstEpisode();
    // jsdom 的 video 没有 requestPictureInPicture，等价于系统不支持
    fireEvent.click(screen.getByText('悬浮小窗'));
    await waitFor(() => expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' }));
    await screen.findByText('关闭悬浮小窗');
  });

  it('系统画中画被拒时回落到自带小窗并说明原因', async () => {
    const api = installApi({
      getSettings: vi.fn(async () => ({ ok: true, data: { picture_in_picture_mode: 'native' } })),
    });
    const video = await playFirstEpisode();
    Object.defineProperty(video, 'requestPictureInPicture', {
      value: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
      configurable: true,
    });

    fireEvent.click(screen.getByText('悬浮小窗'));
    await screen.findByText('系统不支持画中画，已改用悬浮小窗');
    await waitFor(() => expect(api.playerFloatOpen).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A' }));
    await screen.findByText('关闭悬浮小窗');
  });
});
