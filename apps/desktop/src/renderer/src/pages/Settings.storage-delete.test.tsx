/**
 * 「删除全部已下载」反馈的等价用例（迁自 `scripts/check-download-delete-feedback.cjs`）。
 *
 * 4.5 的入口在播放器的剧集面板里（toast 显示「已删除 N 个文件 / 跳过的合并剧集 / 失败原因」），
 * 5.0 把入口挪到设置页的「存储占用」卡片，提示从 toast 变成卡片里的一行文字。
 * 这里锁住仍然成立的不变量：必须确认、反馈要带真实删除量、失败不能被吞掉、删完刷新用量。
 * 4.5 的「正在合并的剧集会被跳过并提示」在 5.0 没有对应实现（见报告中的遗留）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings.tsx';

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    appInfo: vi.fn(async () => ({ ok: true, data: { name: '红果短剧', version: '5.0.0' } })),
    capabilities: vi.fn(async () => ({ ok: true, data: { accountAffectsPlayback: false } })),
    getSettings: vi.fn(async () => ({ ok: true, data: { root: '/fixture' } })),
    saveSettings: vi.fn(async () => ({ ok: true, data: {} })),
    announcementGet: vi.fn(async () => ({ ok: true, data: {} })),
    storageUsage: vi.fn(async () => ({
      ok: true,
      data: { root: '/fixture', totalFiles: 3, totalBytes: 2048, groups: [] },
    })),
    updateState: vi.fn(async () => ({ ok: true, data: { status: 'idle' } })),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  // 覆盖项（storageDeleteAll 等）不在默认对象里：返回类型放宽，供断言取用
  return api as typeof api & Record<string, any>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}

const deleteAllButton = async (): Promise<HTMLButtonElement> =>
  (await screen.findByText('删除全部已下载')).closest('button') as HTMLButtonElement;

/** 用量加载完成前按钮是禁用的，点击会被 jsdom 丢掉：先等到可用再点。 */
const enabledDeleteAllButton = async (): Promise<HTMLButtonElement> => {
  const button = await deleteAllButton();
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('删除全部已下载', () => {
  it('没有可删文件时按钮禁用，一个请求都不发', async () => {
    const api = installApi({
      storageUsage: vi.fn(async () => ({
        ok: true,
        data: { root: '/fixture', totalFiles: 0, totalBytes: 0, groups: [] },
      })),
      storageDeleteAll: vi.fn(async () => ({ ok: true, data: { deleted: 0, bytes: 0, failed: [] } })),
    });
    renderPage();
    const button = await deleteAllButton();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.storageDeleteAll).not.toHaveBeenCalled();
  });

  it('必须确认：取消确认不删除，确认后调用并刷新用量', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = installApi({
      storageDeleteAll: vi.fn(async () => ({ ok: true, data: { deleted: 3, bytes: 2048, failed: [] } })),
    });
    renderPage();
    const button = await enabledDeleteAllButton();
    const usageCalls = api.storageUsage.mock.calls.length;

    fireEvent.click(button);
    expect(confirm).toHaveBeenCalled();
    expect(api.storageDeleteAll).not.toHaveBeenCalled();
    expect(screen.queryByText(/已删除/)).toBeNull();

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(api.storageDeleteAll).toHaveBeenCalledTimes(1));
    // 删完必须重新统计，否则卡片还显示旧占用
    await waitFor(() => expect(api.storageUsage.mock.calls.length).toBeGreaterThan(usageCalls));
  });

  it('成功反馈带上真实删除量、体积与失败文件数', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installApi({
      storageDeleteAll: vi.fn(async () => ({
        ok: true,
        data: { deleted: 0, bytes: 0, failed: ['a.mp4', 'b.mp4'] },
      })),
    });
    renderPage();
    fireEvent.click(await enabledDeleteAllButton());
    await waitFor(() => expect(screen.getByText(/已删除 0 个文件/)).toBeTruthy());
    expect(screen.getByText(/0 B/)).toBeTruthy();
    expect(screen.getByText(/2 个删除失败/)).toBeTruthy();
  });

  it('失败信封把原因显示出来，而不是静默当作删完', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installApi({
      storageDeleteAll: vi.fn(async () => ({
        ok: false,
        error: { code: 'UNKNOWN', message: '目录不可写' },
      })),
    });
    renderPage();
    fireEvent.click(await enabledDeleteAllButton());
    await waitFor(() => expect(screen.getByText('删除失败：目录不可写')).toBeTruthy());
    expect(screen.queryByText(/已删除/)).toBeNull();
  });
});

describe('删除全部：正在合并的剧集会被跳过并如实告知', () => {
  it('反馈里带上跳过数量，不谎称全删了', async () => {
    installApi({
      storageDeleteAll: vi.fn(async () => ({
        ok: true,
        data: { deleted: 3, bytes: 2048, failed: [], skipped: ['A'], skippedFiles: 2 },
      })),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    const button = await enabledDeleteAllButton();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/1 部剧正在合并已跳过（2 个文件）/)).toBeTruthy());
  });
});
