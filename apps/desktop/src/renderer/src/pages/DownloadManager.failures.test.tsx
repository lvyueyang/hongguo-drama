/**
 * 下载管理页的失败与反馈等价用例（迁自 `scripts/check-download-manager.cjs` 的删除/合并失败部分）。
 *
 * 4.5 用批量选择的确认对话框与内联 alert 表达失败；5.0 的页面改成「一条提示 + 三个合并入口」，
 * 但下面这些不变量不能丢：
 * - 失败必须看得见（抛错与 `{ok:false}` 失败信封两种形态都不能被吞掉）；
 * - 失败后原来的任务记录/入口保持可用，不能假装成功；
 * - 取消合并只是「已请求」，不能谎报「已取消」；
 * - 1080P 合并被拒后可以立刻改用别的合并方式（4.5 的对话框保留语义）。
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

const buttonWithText = (text: string): HTMLButtonElement => {
  const node = screen.getAllByText(text).find((element) => element.tagName === 'BUTTON');
  if (!node) throw new Error(`找不到按钮：${text}`);
  return node as HTMLButtonElement;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('下载任务的失败反馈', () => {
  it('移除失败会把原因显示出来，任务记录保持可见', async () => {
    installApi([task('task-a', 'completed')], {
      downloadRemove: vi.fn(async () => ({
        ok: false,
        error: { code: 'UNKNOWN', message: '文件占用，未能移除任务' },
      })),
    });
    renderPage();
    fireEvent.click(await screen.findByText('移除'));
    await waitFor(() => expect(screen.getByText('文件占用，未能移除任务')).toBeTruthy());
    expect(screen.getByText(/第 task-a 集/)).toBeTruthy();
  });

  it('移除时抛错也要变成可见提示，而不是未捕获的拒绝', async () => {
    installApi([task('task-a', 'completed')], {
      downloadRemove: vi.fn(async () => {
        throw new Error('主进程没有响应');
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByText('移除'));
    await waitFor(() => expect(screen.getByText('主进程没有响应')).toBeTruthy());
  });
});

describe('整剧删除文件的反馈', () => {
  it('未确认时一个请求都不发；确认后才调用删除', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = installApi([task('task-a', 'completed')]);
    renderPage();
    fireEvent.click(await screen.findByText('删除文件'));
    expect(confirm).toHaveBeenCalled();
    expect(api.storageDeleteSeries).not.toHaveBeenCalled();
    expect(screen.queryByText(/已删除/)).toBeNull();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('删除文件'));
    await waitFor(() => expect(api.storageDeleteSeries).toHaveBeenCalledWith('9001'));
  });

  it('成功反馈带上真实删除量、失败数与清理的空目录数', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installApi([task('task-a', 'completed')], {
      storageDeleteSeries: vi.fn(async () => ({
        ok: true,
        data: { deleted: 0, bytes: 0, failed: ['a.mp4'], removedDirs: 2 },
      })),
    });
    renderPage();
    fireEvent.click(await screen.findByText('删除文件'));
    await waitFor(() => expect(screen.getByText(/已删除 0 个文件/)).toBeTruthy());
    expect(screen.getByText(/1 个失败/)).toBeTruthy();
    expect(screen.getByText(/清理空目录 2 个/)).toBeTruthy();
  });

  it('失败信封把原因显示出来，且不谎报删除成功、任务记录保留', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installApi([task('task-a', 'completed')], {
      storageDeleteSeries: vi.fn(async () => ({
        ok: false,
        error: { code: 'UNKNOWN', message: '文件被占用，未能删除' },
      })),
    });
    renderPage();
    fireEvent.click(await screen.findByText('删除文件'));
    await waitFor(() => expect(screen.getByText('删除文件失败：文件被占用，未能删除')).toBeTruthy());
    expect(screen.queryByText(/已删除/)).toBeNull();
    expect(screen.getByText(/第 task-a 集/)).toBeTruthy();
  });
});

describe('合并的取消与回退', () => {
  it('取消合并只确认「已请求」，请求失败时说明原因', async () => {
    const api = installApi([task('task-a', 'completed')]);
    renderPage();
    await waitFor(() => expect(listeners[Events.mergeState]).toBeTruthy());
    emit(Events.mergeState, { seriesId: '9001', status: 'running' });

    fireEvent.click(await screen.findByText('取消合并'));
    await waitFor(() => expect(api.mergeCancel).toHaveBeenCalledWith('9001'));
    expect(screen.getByText('已请求取消合并')).toBeTruthy();
    // 主进程还没回报 stopped：不能说成「已取消合并」
    expect(screen.queryByText(/已取消合并/)).toBeNull();

    (window as unknown as { api: Record<string, unknown> }).api.mergeCancel = vi.fn(async () => ({
      ok: false,
      error: { code: 'UNKNOWN', message: '取消通道不可用' },
    }));
    fireEvent.click(screen.getByText('取消合并'));
    await waitFor(() => expect(screen.getByText('取消失败：取消通道不可用')).toBeTruthy());
  });

  it('1080P 合并被拒后按钮恢复可用，可以直接改用兼容合并', async () => {
    const calls: Array<Record<string, unknown>> = [];
    installApi([task('task-a', 'completed')], {
      mergeStart: vi.fn(async (request: Record<string, unknown>) => {
        calls.push(request);
        if (request.require1080) {
          return {
            ok: false,
            error: { code: 'MERGE_1080_UNAVAILABLE', message: '第 2 集实际为 720P，请改用快速或兼容合并' },
          };
        }
        return { ok: true, data: { seriesId: '9001', outputPath: '/tmp/out.mp4', count: 2 } };
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByText('仅 1080P'));
    await waitFor(() => expect(screen.getByText(/第 2 集实际为 720P/)).toBeTruthy());
    expect(calls[0]).toEqual({ seriesId: '9001', compatible: false, require1080: true });
    // 4.5 的对话框会留在原处让用户换一种方式：5.0 的入口必须恢复可用
    for (const label of ['快速合并', '兼容合并', '仅 1080P']) {
      expect(buttonWithText(label).disabled, label).toBe(false);
    }

    fireEvent.click(buttonWithText('兼容合并'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ seriesId: '9001', compatible: true, require1080: false });
    expect(screen.getByText(/合并已启动/)).toBeTruthy();
  });
});
