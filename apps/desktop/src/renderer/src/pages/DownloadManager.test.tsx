import { Events } from '@hongguo/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DownloadManager from './DownloadManager.tsx';

const tasks = [
  {
    id: 'task-a',
    vid: '1001',
    seriesId: '9001',
    seriesTitle: '验收剧',
    savePath: '/tmp/a.mp4',
    status: 'completed',
    progress: 100,
    receivedBytes: 1024,
    totalBytes: 1024,
    actualQuality: '1080p',
    qualityNotice: '',
  },
  {
    id: 'task-b',
    vid: '1002',
    seriesId: '9001',
    seriesTitle: '验收剧',
    savePath: '/tmp/b.mp4',
    status: 'downloading',
    progress: 42,
    receivedBytes: 512,
    totalBytes: 1024,
    error: '',
  },
];

type Listener = (payload: unknown) => void;
const listeners: Record<string, Listener> = {};

function emit(event: string, payload: unknown): void {
  listeners[event]?.(payload);
}

function installApi(overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(listeners)) delete listeners[key];
  const api = {
    downloadList: vi.fn(async () => ({ ok: true, data: tasks })),
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
  // 只挂 api，不要替换 window（替换会破坏 jsdom 的 document 绑定）
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

describe('下载管理页（React 19 + Testing Library + jsdom）', () => {
  beforeEach(() => {
    installApi();
  });

  // vitest 未开 globals，RTL 不会自动清理；不清理会让下一次 render 与上一次的 DOM 重名。
  afterEach(() => cleanup());

  it('按队列状态渲染，并显示实际清晰度', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/第 1001 集/)).toBeTruthy());
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('下载中')).toBeTruthy();
    expect(screen.getByText(/实际 1080p/)).toBeTruthy();
  });

  it('订阅进度、合并、转码与存储错误事件（少订阅=界面看着像卡死）', async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(api.on).toHaveBeenCalled());
    const subscribed = api.on.mock.calls.map((call: unknown[]) => call[0]);
    for (const event of [
      Events.downloadProgress,
      Events.downloadState,
      Events.mergeState,
      Events.mergeProgress,
      Events.transcodeProgress,
      Events.storageError,
    ]) {
      expect(subscribed, event).toContain(event);
    }
  });

  it('暂停按钮把任务 id 交给主进程', async () => {
    const api = installApi();
    renderPage();
    const pause = await screen.findByText('暂停');
    pause.click();
    await waitFor(() => expect(api.downloadPause).toHaveBeenCalledWith('task-b'));
  });

  it('主进程返回失败信封时页面展示错误而不是崩溃', async () => {
    installApi({
      downloadList: vi.fn(async () => ({ ok: false, error: { code: 'UNKNOWN', message: '读取队列失败' } })),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/读取队列失败|还没有下载任务/)).toBeTruthy());
  });

  it('三种合并方式分别把 compatible / require1080 传给主进程', async () => {
    const api = installApi();
    renderPage();
    const fast = await screen.findByText('快速合并');
    fast.click();
    await waitFor(() =>
      expect(api.mergeStart).toHaveBeenLastCalledWith({
        seriesId: '9001',
        compatible: false,
        require1080: false,
      }),
    );

    screen.getByText('兼容合并').click();
    await waitFor(() =>
      expect(api.mergeStart).toHaveBeenLastCalledWith({
        seriesId: '9001',
        compatible: true,
        require1080: false,
      }),
    );

    screen.getByText('仅 1080P').click();
    await waitFor(() =>
      expect(api.mergeStart).toHaveBeenLastCalledWith({
        seriesId: '9001',
        compatible: false,
        require1080: true,
      }),
    );
  });

  it('合并进度事件驱动进度条，合并可以取消', async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(listeners[Events.mergeProgress]).toBeTruthy());

    emit(Events.mergeState, { seriesId: '9001', status: 'running' });
    emit(Events.mergeProgress, {
      seriesId: '9001',
      stage: 'preparing',
      stageText: '统一视频编码',
      progress: 37,
    });
    await waitFor(() => expect(screen.getByText(/统一视频编码 · 37%/)).toBeTruthy());

    const cancel = screen.getByText('取消合并');
    cancel.click();
    await waitFor(() => expect(api.mergeCancel).toHaveBeenCalledWith('9001'));

    // 结束后进度与取消按钮一起消失
    emit(Events.mergeState, { seriesId: '9001', status: 'completed', outputPath: '/tmp/out.mp4' });
    await waitFor(() => expect(screen.queryByText('取消合并')).toBeNull());
    expect(screen.getByText(/合并完成/)).toBeTruthy();
  });

  it('转码进度与存储写失败都看得见', async () => {
    installApi({ transcode: vi.fn(async () => new Promise(() => {})) });
    renderPage();
    const transcode = await screen.findByText('转码兜底');
    transcode.click();
    emit(Events.transcodeProgress, { taskId: 'task-a', percent: 66 });
    await waitFor(() => expect(screen.getByText(/转码 66%/)).toBeTruthy());

    emit(Events.storageError, { error: '磁盘已满' });
    await waitFor(() => expect(screen.getByText(/本地数据保存失败：磁盘已满/)).toBeTruthy());
  });
});
