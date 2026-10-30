/**
 * 下载暂停/继续的等价用例（迁自 `scripts/check-player-review-2-5.cjs` 的下载部分）。
 *
 * 4.5 测的是「有别的任务正在下载时，仍能一次性恢复所有可恢复任务」；5.0 的下载管理页
 * 换成按任务操作（`stopped` / `failed` 显示「继续」，`pending` / `downloading` 显示「暂停」），
 * 因此这里验恢复语义等价的不变量：能恢复的任务都能各自恢复、互不打断、已完成的不给恢复入口。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DownloadManager from './DownloadManager.tsx';

function task(id: string, status: string) {
  return {
    id,
    vid: id,
    seriesId: '9001',
    seriesTitle: '验收剧',
    savePath: `/tmp/${id}.mp4`,
    status,
    progress: status === 'downloading' ? 42 : 0,
    receivedBytes: 512,
    totalBytes: 1024,
    actualQuality: status === 'completed' ? '1080p' : '',
    qualityNotice: '',
  };
}

function installApi(tasks: unknown[], overrides: Record<string, unknown> = {}) {
  const api = {
    downloadList: vi.fn(async () => ({ ok: true, data: tasks })),
    downloadPause: vi.fn(async () => ({ ok: true, data: {} })),
    downloadResume: vi.fn(async () => ({ ok: true, data: {} })),
    downloadRemove: vi.fn(async () => ({ ok: true, data: {} })),
    mergeStart: vi.fn(async () => ({ ok: true, data: {} })),
    mergeCancel: vi.fn(async () => ({ ok: true, data: {} })),
    transcode: vi.fn(async () => ({ ok: true, data: { url: 'x', cached: false } })),
    storageDeleteSeries: vi.fn(async () => ({ ok: true, data: { deleted: 0, bytes: 0, failed: [] } })),
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
      <DownloadManager />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('下载任务恢复', () => {
  it('已暂停与失败的任务各自提供「继续」，点击交给主进程', async () => {
    const api = installApi([task('stopped-1', 'stopped'), task('failed-2', 'failed')]);
    renderPage();
    const buttons = await screen.findAllByText('继续');
    expect(buttons).toHaveLength(2);

    buttons[1].click();
    await waitFor(() => expect(api.downloadResume).toHaveBeenCalledWith('failed-2'));
    buttons[0].click();
    await waitFor(() => expect(api.downloadResume).toHaveBeenCalledWith('stopped-1'));
  });

  it('有别的任务正在下载时仍能继续失败任务，且不会顺带暂停它', async () => {
    const api = installApi([task('active-1', 'downloading'), task('failed-2', 'failed')]);
    renderPage();
    const resume = await screen.findByText('继续');
    resume.click();

    await waitFor(() => expect(api.downloadResume).toHaveBeenCalledWith('failed-2'));
    expect(api.downloadResume).toHaveBeenCalledTimes(1);
    expect(api.downloadPause).not.toHaveBeenCalled();
    // 正在下载的那条仍然只有「暂停」入口
    expect(screen.getAllByText('暂停')).toHaveLength(1);
  });

  it('已完成与正在下载的任务不出现「继续」', async () => {
    installApi([task('done-1', 'completed'), task('active-1', 'downloading')]);
    renderPage();
    await screen.findByText('已完成');
    expect(screen.queryByText('继续')).toBeNull();
    expect(screen.getByText('暂停')).toBeTruthy();
  });
});
