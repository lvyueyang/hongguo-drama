// SPDX-License-Identifier: MIT
/**
 * 弹幕的取数与开关（剧库页）。
 *
 * 替代 4.5 `scripts/check-danmaku-official-ui.cjs` 里**5.0 仍有对应行为**的部分：
 * 播放哪一集就只请哪一集的弹幕、换集重新取、旧集的迟到响应不作数、拿不到就把原因说出来
 * （不许改口成「本集暂无弹幕」）、开关只影响显示不重复取数。
 *
 * 5.0 没有「官方/评论」来源切换、没有弹幕字号/透明度/屏蔽词设置、没有手动重试按钮、
 * 也没有评论源轮询定时器，那部分判 obsolete：来源校验与失败文案在
 * `packages/sdk/src/services/danmaku/`，解析与调度在 `lib/danmaku.ts`。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type DanmakuRequest = { vid: string; seriesId: string; fresh?: boolean };

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
    seriesEpisodes: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: { series_id: 'A', series_title: '测试剧', total: 3, episodes },
      }),
    ),
    playPrepare: vi.fn(async (request: { vid: string; seriesId: string }) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${request.vid}`, sessionId: request.vid },
    })),
    progressGet: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: null })),
    progressSave: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    playPrefetch: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { status: 'prefetched' } })),
    danmakuList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { items: [], notice: '' } })),
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

async function openSeries(): Promise<void> {
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 3 集')).toBeTruthy());
}

async function play(index: number): Promise<void> {
  await act(async () => {
    fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[index] as HTMLElement);
  });
  await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('弹幕取数', () => {
  it('没点播放之前不请求弹幕', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();
    expect(api.danmakuList).not.toHaveBeenCalled();
  });

  it('播放哪一集就只请哪一集，并画出时间窗内的弹幕', async () => {
    const api = installApi({
      danmakuList: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { items: [{ time: 0, text: '第一条弹幕' }], notice: '' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    await play(0);

    await waitFor(() => expect(api.danmakuList).toHaveBeenCalledTimes(1));
    expect(api.danmakuList).toHaveBeenCalledWith({ vid: 'v1', seriesId: 'A', fresh: false });
    expect(await screen.findByText('第一条弹幕')).toBeTruthy();
  });

  it('换集后重新按新的 vid 取，旧集的迟到响应不会覆盖当前集', async () => {
    let releaseOld: (() => void) | undefined;
    const api = installApi({
      danmakuList: vi.fn((request: DanmakuRequest) => {
        if (request.vid === 'v1') {
          return new Promise<Envelope>((resolve) => {
            releaseOld = () => resolve({ ok: true, data: { items: [{ time: 0, text: '第一集弹幕' }] } });
          });
        }
        return Promise.resolve({
          ok: true,
          data: { items: [{ time: 0, text: '第三集弹幕' }] },
        } as Envelope);
      }),
    });
    renderLibrary();
    await openSeries();
    await play(0);
    await play(2);

    await waitFor(() =>
      expect(api.danmakuList).toHaveBeenLastCalledWith({ vid: 'v3', seriesId: 'A', fresh: false }),
    );
    expect(await screen.findByText('第三集弹幕')).toBeTruthy();

    releaseOld?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('第一集弹幕')).toBeNull();
    expect(screen.getByText('第三集弹幕')).toBeTruthy();
  });

  it('取不到弹幕时说清原因，不改口成「暂无弹幕」', async () => {
    installApi({
      danmakuList: vi.fn(
        async (): Promise<Envelope> => ({
          ok: false,
          error: { code: 'DANMAKU_FAILED', message: '弹幕服务暂时不可用' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    await play(0);

    expect(await screen.findByText('弹幕加载失败：弹幕服务暂时不可用')).toBeTruthy();
    expect(screen.queryByText(/暂无弹幕/)).toBeNull();
  });

  it('本集确实没有弹幕时显示主进程给的说明', async () => {
    installApi({
      danmakuList: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { items: [], notice: '本集暂无弹幕' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    await play(0);
    expect(await screen.findByText('本集暂无弹幕')).toBeTruthy();
  });
});

describe('弹幕开关', () => {
  it('关掉只隐藏显示，不重新取数；再打开仍只有一次请求', async () => {
    const api = installApi({
      danmakuList: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { items: [{ time: 0, text: '第一条弹幕' }], notice: '' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();
    await play(0);
    expect(await screen.findByText('第一条弹幕')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '弹幕关' }));
    await waitFor(() => expect(screen.queryByText('第一条弹幕')).toBeNull());
    expect(api.danmakuList).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '弹幕开' }));
    expect(await screen.findByText('第一条弹幕')).toBeTruthy();
    expect(api.danmakuList).toHaveBeenCalledTimes(1);
  });
});
