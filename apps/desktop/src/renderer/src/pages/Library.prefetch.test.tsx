/**
 * 剧库页（5.0 的播放落点）触发下一集预取的等价用例。
 *
 * 对应迁入的旧检查：`scripts/check-next-cache.cjs`（立即触发 / 不重复）与
 * `scripts/check-player-prefetch.cjs`（由播放触发 / 失败静默 / 切集仍预取）。
 * 决策（只取紧随其后的未锁定一集、同集去重、超时）在主进程 SDK，
 * 由 `packages/sdk/src/services/media/prefetch.test.ts` 覆盖；这里只验渲染层的接线与不变量：
 * 播放才开始预取、一次播放只预取一次、把整份有序分集交给主进程、失败不打扰用户。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

const EPISODES = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
  { vid: 'v3', vid_index: 3, locked: true },
  { vid: 'v4', vid_index: 4 },
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
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  // 只挂 api，不替换 window（替换会破坏 jsdom 的 document 绑定）
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

/** 打开剧 A 的分集列表。 */
async function openSeries(): Promise<void> {
  renderPage();
  fireEvent.click(await screen.findByText('剧A'));
  await screen.findByText('共 4 集');
}

/** 双击第 index 集：分集按钮上的数字是唯一的 span.font-medium。 */
function playEpisode(index: number): void {
  const label = screen.getByText(String(index), { selector: 'span.font-medium' });
  fireEvent.doubleClick(label.closest('button') as HTMLElement);
}

const video = (): HTMLVideoElement => {
  const element = document.querySelector('video');
  if (!element) throw new Error('没有渲染 video');
  return element;
};

afterEach(() => cleanup());

describe('下一集预取（渲染层接线）', () => {
  it('打开一集立刻把整份有序分集交给主进程，且只预取一次', async () => {
    const api = installApi();
    await openSeries();
    // 还没开始播放就不该取流，也不该预取
    expect(api.playPrefetch).not.toHaveBeenCalled();

    playEpisode(1);
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));

    // 整份列表按播放顺序交给主进程，锁定标记随行（由主进程决定跳不跳过）
    expect(api.playPrefetch).toHaveBeenCalledWith({
      seriesId: 'A',
      currentVid: 'v1',
      episodes: [{ vid: 'v1' }, { vid: 'v2' }, { vid: 'v3', locked: true }, { vid: 'v4' }],
    });
  });

  it('播放进度事件与界面状态变化都不会重复预取', async () => {
    const api = installApi();
    await openSeries();
    playEpisode(1);
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));

    const element = video();
    for (const time of [1, 2, 3]) {
      Object.defineProperty(element, 'currentTime', { value: time, configurable: true });
      fireEvent.timeUpdate(element);
    }
    // 选中状态变化（重渲染）也不该再发一次
    fireEvent.click(screen.getByText('全选可播'));
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));
  });

  it('切到下一集后预取改用新的当前集', async () => {
    const api = installApi();
    await openSeries();
    playEpisode(1);
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));

    playEpisode(2);
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(2));
    const prefetchArgs = api.playPrefetch.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(prefetchArgs[1]?.[0]).toMatchObject({ currentVid: 'v2' });
  });

  it('主进程报预取失败时静默：不弹错、不重试打转、当前播放不受影响', async () => {
    const api = installApi({
      playPrefetch: vi.fn(async () => ({
        ok: false,
        error: { code: 'NETWORK', message: 'offline' },
      })),
    });
    await openSeries();
    playEpisode(1);
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));

    const element = video();
    Object.defineProperty(element, 'currentTime', { value: 5, configurable: true });
    fireEvent.timeUpdate(element);

    await waitFor(() => expect(video().getAttribute('src')).toBe('hongguo-stream://play/v1'));
    expect(screen.queryByText(/offline|预取失败/)).toBeNull();
    expect(screen.queryByText(/播放失败/)).toBeNull();
    expect(api.playPrefetch).toHaveBeenCalledTimes(1);
  });

  it('预取请求直接抛错也不影响播放', async () => {
    const api = installApi({
      playPrefetch: vi.fn(async () => {
        throw new Error('ipc 挂了');
      }),
    });
    await openSeries();
    playEpisode(1);
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(video().getAttribute('src')).toBe('hongguo-stream://play/v1'));
    expect(screen.queryByText(/ipc 挂了/)).toBeNull();
  });

  it('连播自动进入下一集并为新当前集预取，锁定的下一集不自动进入', async () => {
    const api = installApi();
    await openSeries();
    playEpisode(1);
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(1));

    fireEvent.ended(video());
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    expect(api.playPrepare.mock.calls[1][0]).toMatchObject({ vid: 'v2', seriesId: 'A' });
    await waitFor(() => expect(api.playPrefetch).toHaveBeenCalledTimes(2));

    // 第 2 集播完时下一集（v3）是锁定的：不许自动跳过去
    fireEvent.ended(video());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.playPrepare).toHaveBeenCalledTimes(2);
  });
});
