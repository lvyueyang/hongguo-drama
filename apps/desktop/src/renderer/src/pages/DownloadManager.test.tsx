import { Events } from '@hongguo/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    downloadList: vi.fn(async () => ({ ok: true, data: tasks })),
    downloadPause: vi.fn(async () => ({ ok: true, data: {} })),
    downloadResume: vi.fn(async () => ({ ok: true, data: {} })),
    downloadRemove: vi.fn(async () => ({ ok: true, data: {} })),
    mergeStart: vi.fn(async () => ({
      ok: true,
      data: { seriesId: '9001', outputPath: '/tmp/out.mp4', count: 2 },
    })),
    transcode: vi.fn(async () => ({ ok: true, data: { url: 'hongguo-local://f/x', cached: false } })),
    on: vi.fn(() => () => {}),
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

  it('按队列状态渲染，并显示实际清晰度', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/第 1001 集/)).toBeTruthy());
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('下载中')).toBeTruthy();
    expect(screen.getByText(/实际 1080p/)).toBeTruthy();
  });

  it('订阅进度与合并事件，合并完成后给出提示', async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(api.on).toHaveBeenCalled());
    const subscribed = api.on.mock.calls.map((call: unknown[]) => call[0]);
    expect(subscribed).toContain(Events.downloadProgress);
    expect(subscribed).toContain(Events.downloadState);
    expect(subscribed).toContain(Events.mergeState);
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
});
