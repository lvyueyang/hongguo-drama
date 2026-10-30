/**
 * 在线取流失败的等价用例（迁自 `scripts/check-player-fallback.cjs` 里仍然成立的部分）。
 *
 * 4.5 的「在线失败自动回落到已下载文件 / 自动入下载队列 / 取消等待」在 5.0 的剧库页
 * 没有对应实现（`playPrepare` 失败即止，下载走独立的下载管理页），因此这里只验还存活的不变量：
 * 失败必须说清原因而不是静默白屏、失败不能顺手写观看记录或偷偷加下载任务、失败后可以再试一次。
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
    downloadEnqueue: vi.fn(async () => ({ ok: true, data: [] })),
    getSettings: vi.fn(async () => ({ ok: true, data: {} })),
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

async function openSeries(): Promise<void> {
  renderPage();
  fireEvent.click(await screen.findByText('剧A'));
  await screen.findByText('共 2 集');
}

function playEpisode(index: number): void {
  const label = screen.getByText(String(index), { selector: 'span.font-medium' });
  fireEvent.doubleClick(label.closest('button') as HTMLElement);
}

afterEach(() => cleanup());

describe('在线取流失败', () => {
  it('失败要说清原因，且不自动加下载任务、不写观看记录', async () => {
    const api = installApi({
      playPrepare: vi.fn(async () => ({
        ok: false,
        error: { code: 'SOURCE', message: '本集取源失败' },
      })),
    });
    await openSeries();
    playEpisode(1);

    await screen.findByText('播放失败：本集取源失败');
    expect(document.querySelector('video')).toBeNull();
    expect(api.downloadEnqueue).not.toHaveBeenCalled();
    expect(api.progressSave).not.toHaveBeenCalled();
  });

  it('取流请求直接抛错也不崩，仍给出原因', async () => {
    const api = installApi({
      playPrepare: vi.fn(async () => {
        throw new Error('网络不可用');
      }),
    });
    await openSeries();
    playEpisode(1);
    await screen.findByText('播放失败：网络不可用');
    expect(api.progressSave).not.toHaveBeenCalled();
  });

  it('失败后再次双击同一集可以重试成功', async () => {
    let attempts = 0;
    const api = installApi({
      playPrepare: vi.fn(async ({ vid }: { vid: string }) => {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: { code: 'SOURCE', message: '本集取源失败' } };
        return { ok: true, data: { url: `hongguo-stream://play/${vid}`, sessionId: vid } };
      }),
    });
    await openSeries();
    playEpisode(1);
    await screen.findByText('播放失败：本集取源失败');

    playEpisode(1);
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v1'),
    );
    expect(api.playPrepare).toHaveBeenCalledTimes(2);
  });
});
