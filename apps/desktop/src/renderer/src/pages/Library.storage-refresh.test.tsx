/**
 * 播放记账与存储扫描的等价用例（迁自 `scripts/check-player-storage-refresh.cjs`，
 * 并含 `check-playback-speed.cjs` 里「取流本身不算观看」那一条）。
 *
 * 存活的不变量：
 * - 取流成功不等于看过：没有播放进度事件就不写观看记录；
 * - 连播整季时只按集取流一次，不重复取流、不重复记账；
 * - 播放期间不扫描下载目录（存储统计只在设置页按需读一次）。
 * 4.5 的 `onlineCacheStatus` 在线缓存刷新计数在 5.0 已无对应接口，见迁移报告。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

const EPISODES = [1, 2, 3, 4].map((index) => ({ vid: `v${index}`, vid_index: index }));

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
    storageUsage: vi.fn(async () => ({ ok: true, data: { totalFiles: 0, totalBytes: 0 } })),
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

const video = (): HTMLVideoElement => document.querySelector('video') as HTMLVideoElement;

afterEach(() => cleanup());

describe('播放记账与存储扫描', () => {
  it('取流成功不等于看过：没有播放进度事件就不写观看记录', async () => {
    const api = installApi();
    renderPage();
    fireEvent.click(await screen.findByText('剧A'));
    fireEvent.doubleClick(
      (await screen.findByText('1', { selector: 'span.font-medium' })).closest('button') as HTMLElement,
    );
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(1));
    expect(api.progressSave).not.toHaveBeenCalled();
  });

  it('连播四集：每集只取流一次、每集只记一次，且不扫描下载存储', async () => {
    const api = installApi();
    renderPage();
    fireEvent.click(await screen.findByText('剧A'));
    fireEvent.doubleClick(
      (await screen.findByText('1', { selector: 'span.font-medium' })).closest('button') as HTMLElement,
    );

    for (let episode = 1; episode <= 4; episode++) {
      await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(episode));
      await waitFor(() => expect(video().getAttribute('src')).toBe(`hongguo-stream://play/v${episode}`));
      fireEvent.ended(video());
      await waitFor(() => expect(api.progressSave).toHaveBeenCalledTimes(episode));
    }

    const prepareCalls = api.playPrepare.mock.calls as unknown as Array<[Record<string, any>]>;
    expect(prepareCalls.map((call) => call[0]?.vid)).toEqual(['v1', 'v2', 'v3', 'v4']);
    // 剧库页只走在线取流（不带本地文件/清晰度选择的本地播放分支）
    expect(prepareCalls.every((call) => call[0]?.seriesId === 'A' && call[0]?.quality === 'auto')).toBe(true);
    const saveCalls = api.progressSave.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(saveCalls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seriesId: 'A', vid: 'v1', vidIndex: 1, watched: true }),
      expect.objectContaining({ seriesId: 'A', vid: 'v2', vidIndex: 2, watched: true }),
      expect.objectContaining({ seriesId: 'A', vid: 'v3', vidIndex: 3, watched: true }),
      expect.objectContaining({ seriesId: 'A', vid: 'v4', vidIndex: 4, watched: true }),
    ]);
    // 播放期间不做任何本地存储扫描（4.5 曾经每集扫一次下载目录）
    expect(api.storageUsage).not.toHaveBeenCalled();
  });
});
