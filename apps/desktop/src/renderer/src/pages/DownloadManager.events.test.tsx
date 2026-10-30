/**
 * 下载管理页的事件驱动等价用例（迁自 `scripts/check-download-manager.cjs` 的事件/进度部分）。
 *
 * 4.5 的页面把事件载荷直接写进本地 state（并用定时器合并高频进度），5.0 改成
 * 「事件只用来让 TanStack Query 重新取快照，列表数据来自 `downloadList`」。
 * 因此这里验的是等价的不变量：
 * - 进度/状态事件到达后必须重新取一次快照（否则界面不会动）；
 * - 合并进度被钳制在 0–100，合并结束（取消/失败/完成）后进度行与取消入口一起消失。
 * 队列侧的退避重试语义由 `apps/desktop/src/main/queue.test.ts` 覆盖（重试预算、终态清理）。
 */
import { Events } from '@hongguo/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DownloadManager from './DownloadManager.tsx';

type Listener = (payload: unknown) => void;
const listeners: Record<string, Listener> = {};

function emit(event: string, payload: unknown): void {
  listeners[event]?.(payload);
}

function task(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    vid: id,
    seriesId: '9001',
    seriesTitle: '验收剧',
    savePath: `/tmp/${id}.mp4`,
    status,
    progress: status === 'completed' ? 100 : 0,
    receivedBytes: 1024,
    totalBytes: 1024,
    actualQuality: status === 'completed' ? '1080p' : '',
    qualityNotice: '',
    ...extra,
  };
}

function installApi(givenTasks: unknown[], overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(listeners)) delete listeners[key];
  const api = {
    downloadList: vi.fn(async () => ({ ok: true, data: givenTasks })),
    downloadPause: vi.fn(async () => ({ ok: true, data: {} })),
    downloadResume: vi.fn(async () => ({ ok: true, data: {} })),
    downloadRemove: vi.fn(async () => ({ ok: true, data: {} })),
    mergeStart: vi.fn(async () => ({
      ok: true,
      data: { seriesId: '9001', outputPath: '/tmp/out.mp4', count: 2 },
    })),
    mergeCancel: vi.fn(async () => ({ ok: true, data: { cancelled: true } })),
    transcode: vi.fn(async () => ({ ok: true, data: { url: 'hongguo-local://f/x', cached: false } })),
    storageDeleteSeries: vi.fn(async () => ({
      ok: true,
      data: { deleted: 1, bytes: 1024, failed: [], removedDirs: 1 },
    })),
    on: vi.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
      return () => {
        delete listeners[event];
      };
    }),
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

// vitest 未开 globals，RTL 不会自动清理；不清理会让下一次 render 与上一次的 DOM 重名。
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('下载管理页的事件驱动', () => {
  it('进度与状态事件都会让列表重新取快照（而不是把事件载荷当状态用）', async () => {
    const api = installApi([task('task-a', 'downloading')]);
    renderPage();
    await waitFor(() => expect(api.downloadList).toHaveBeenCalled());
    const initial = api.downloadList.mock.calls.length;

    emit(Events.downloadProgress, { id: 'task-a', progress: 40, receivedBytes: 40, totalBytes: 100 });
    await waitFor(() => expect(api.downloadList.mock.calls.length).toBeGreaterThan(initial));
    const afterProgress = api.downloadList.mock.calls.length;

    emit(Events.downloadState, { id: 'task-a', status: 'failed', error: '片源已下架' });
    await waitFor(() => expect(api.downloadList.mock.calls.length).toBeGreaterThan(afterProgress));
    // 事件本身不写页面状态：真正显示的仍是队列快照（这里是「下载中」这一行）
    expect(screen.getByText(/第 task-a 集/)).toBeTruthy();
  });

  it('合并进度被钳制在 0–100，非法值不会把进度条撑爆或压负', async () => {
    installApi([task('task-a', 'completed')]);
    renderPage();
    await waitFor(() => expect(listeners[Events.mergeProgress]).toBeTruthy());

    emit(Events.mergeState, { seriesId: '9001', status: 'running' });
    emit(Events.mergeProgress, {
      seriesId: '9001',
      stage: 'transcoding',
      stageText: '兼容转码',
      progress: 250,
    });
    await waitFor(() => expect(screen.getByText(/兼容转码 · 100%/)).toBeTruthy());

    emit(Events.mergeProgress, { seriesId: '9001', stage: 'transcoding', progress: -5 });
    await waitFor(() => expect(screen.getByText(/transcoding · 0%/)).toBeTruthy());
  });

  it('合并取消/失败事件清掉进度行与取消入口，并说明是取消还是失败', async () => {
    installApi([task('task-a', 'completed')]);
    renderPage();
    await waitFor(() => expect(listeners[Events.mergeProgress]).toBeTruthy());

    emit(Events.mergeState, { seriesId: '9001', status: 'running' });
    emit(Events.mergeProgress, { seriesId: '9001', stage: 'transcoding', progress: 30 });
    await waitFor(() => expect(screen.getByText('取消合并')).toBeTruthy());

    emit(Events.mergeState, { seriesId: '9001', status: 'stopped', error: '用户取消' });
    await waitFor(() => expect(screen.queryByText('取消合并')).toBeNull());
    expect(screen.queryByText(/transcoding/)).toBeNull();
    expect(screen.getByText('合并已取消：用户取消')).toBeTruthy();

    emit(Events.mergeState, { seriesId: '9001', status: 'running' });
    emit(Events.mergeState, { seriesId: '9001', status: 'failed', error: '磁盘空间不足' });
    await waitFor(() => expect(screen.getByText('合并失败：磁盘空间不足')).toBeTruthy());
    expect(screen.queryByText(/合并已取消/)).toBeNull();
  });

  it('等待退避重试的任务显示重试提示并保留「暂停」入口（重试可以随时停掉）', async () => {
    const api = installApi([
      task('retry-1', 'pending', { error: '视频下载不完整 将在 5 秒后自动重试（1/3）' }),
      task('dead-2', 'failed', { error: '片源已下架' }),
    ]);
    renderPage();
    await screen.findByText('排队中');
    // 重试提示来自队列（格式由 queue.ts 决定），页面必须原样显示
    expect(screen.getByText(/将在 5 秒后自动重试（1\/3）/)).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('片源已下架')).toBeTruthy();
    // 重试等待中：可暂停（5.0 由「暂停」承担 4.5 的「停止自动重试」），终态失败只给「继续」
    expect(screen.getAllByText('暂停')).toHaveLength(1);

    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => expect(api.downloadPause).toHaveBeenCalledWith('retry-1'));
  });
});
