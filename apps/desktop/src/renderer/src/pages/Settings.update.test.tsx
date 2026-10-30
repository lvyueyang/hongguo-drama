// SPDX-License-Identifier: MIT
/**
 * 设置页的「应用内更新」卡片：进度看得见、安装必须由用户点、失败能重试。
 *
 * 替代 4.5 `scripts/check-app-update-ui.cjs` 里**5.0 仍有对应 UI** 的部分。下载/校验/取消/
 * 原生安装的流程规则在 SDK（`packages/sdk/src/services/meta/update-installer-flow.test.ts`），
 * 版本判定与合法跳转在 `update.test.ts`；这里只锁设置页的接线。
 *
 * 5.0 没有「关闭更新提醒」「重新检查」「前往发布页手动下载」「取消下载」这些控件
 * （取消只有主进程通道 `update:cancel` + SDK `cancel()`，设置页没入口），那部分判 obsolete，
 * 见迁移报告的遗留清单。
 */
import { Events } from '@hongguo/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type Listener = (payload: unknown) => void;

const listeners: Record<string, Listener> = {};

function installApi(overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(listeners)) delete listeners[key];
  const api = {
    appInfo: vi.fn(async () => ({ ok: true, data: { name: '红果短剧', version: '5.0.0' } })),
    capabilities: vi.fn(async () => ({ ok: true, data: { accountAffectsPlayback: false } })),
    getSettings: vi.fn(async () => ({ ok: true, data: { root: '/fixture' } })),
    saveSettings: vi.fn(async () => ({ ok: true, data: {} })),
    announcementGet: vi.fn(async () => ({ ok: true, data: {} })),
    storageUsage: vi.fn(async () => ({ ok: true, data: { root: '/fixture', totalFiles: 0, totalBytes: 0 } })),
    updateState: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { status: 'idle', percent: 0 } })),
    updateCheck: vi.fn(
      async (): Promise<Envelope> => ({ ok: true, data: { enabled: true, release: { version: '9.0' } } }),
    ),
    updateDownload: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { success: true } })),
    updateInstall: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { success: true } })),
    customSourceSave: vi.fn(async () => ({ ok: true, data: {} })),
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
      <Settings />
    </QueryClientProvider>,
  );
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const emit = (event: string, payload: unknown): void => listeners[event]?.(payload);

afterEach(() => cleanup());

describe('更新进度与安装动作', () => {
  it('状态里的进度看得见，并且事件推送后会重新取状态', async () => {
    const api = installApi({
      updateState: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { status: 'downloading', percent: 37.2 } }),
      ),
    });
    renderPage();
    expect(await screen.findByText(/状态：downloading · 37.2%/)).toBeTruthy();

    api.updateState.mockResolvedValue({
      ok: true,
      data: { status: 'downloading', percent: 46.4 },
    } as Envelope);
    emit(Events.updateChanged, { status: 'downloading', percent: 46.4 });
    expect(await screen.findByText(/状态：downloading · 46.4%/)).toBeTruthy();
    await waitFor(() => expect(api.updateState).toHaveBeenCalledTimes(2));
  });

  it('下载完成不会自己安装：只有点「安装并重启」才调用安装', async () => {
    const api = installApi({
      updateState: vi.fn(
        async (): Promise<Envelope> => ({
          ok: true,
          data: { status: 'downloaded', percent: 100, version: '9.0' },
        }),
      ),
    });
    renderPage();
    await screen.findByText(/状态：downloaded · 100%/);

    fireEvent.click(button('检查更新'));
    expect(await screen.findByText('发现新版本 9.0')).toBeTruthy();
    fireEvent.click(button('下载'));
    expect(await screen.findByText('更新已下载，可安装')).toBeTruthy();
    expect(api.updateInstall).not.toHaveBeenCalled();

    fireEvent.click(button('安装并重启'));
    expect(await screen.findByText('正在安装，应用将重启')).toBeTruthy();
    expect(api.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('安装失败：给出原因、按钮仍可点，允许再试', async () => {
    const install = vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: { success: false, error: '请等待下载任务完成' },
      }),
    );
    const api = installApi({ updateInstall: install });
    renderPage();
    await screen.findByText(/状态：/);

    fireEvent.click(button('安装并重启'));
    expect(await screen.findByText('请等待下载任务完成')).toBeTruthy();
    expect(button('安装并重启').disabled).toBe(false);

    fireEvent.click(button('安装并重启'));
    await waitFor(() => expect(api.updateInstall).toHaveBeenCalledTimes(2));
  });

  it('安装请求在手时按钮禁用，避免装两次', async () => {
    let release: (() => void) | undefined;
    installApi({
      updateInstall: vi.fn(
        () =>
          new Promise<Envelope>((resolve) => {
            release = () => resolve({ ok: true, data: { success: true } });
          }),
      ),
    });
    renderPage();
    await screen.findByText(/状态：/);

    fireEvent.click(button('安装并重启'));
    await waitFor(() => expect(button('安装并重启').disabled).toBe(true));
    release?.();
    expect(await screen.findByText('正在安装，应用将重启')).toBeTruthy();
  });
});

describe('检查与下载的失败可见', () => {
  it('没有新版本时说清是最新，而不是空着', async () => {
    const api = installApi({
      updateCheck: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { enabled: true, release: null } }),
      ),
    });
    renderPage();
    await screen.findByText(/状态：/);
    fireEvent.click(button('检查更新'));
    expect(await screen.findByText('已是最新版本')).toBeTruthy();
    expect(api.updateCheck).toHaveBeenCalledTimes(1);
  });

  it('检查失败说明原因，再点一次仍会重新请求', async () => {
    let broken = true;
    const api = installApi({
      updateCheck: vi.fn(async () => {
        if (broken) return { ok: false, error: { code: 'NETWORK', message: '网络连接失败' } } as Envelope;
        return { ok: true, data: { enabled: true, release: { version: '9.0' } } } as Envelope;
      }),
    });
    renderPage();
    await screen.findByText(/状态：/);

    fireEvent.click(button('检查更新'));
    expect(await screen.findByText('检查更新失败：网络连接失败')).toBeTruthy();

    broken = false;
    fireEvent.click(button('检查更新'));
    expect(await screen.findByText('发现新版本 9.0')).toBeTruthy();
    expect(api.updateCheck).toHaveBeenCalledTimes(2);
  });

  it('下载失败给出原因与手动重试的余地；重试成功提示可安装', async () => {
    let attempts = 0;
    const api = installApi({
      updateDownload: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? ({ ok: true, data: { success: false, error: '校验失败，请重试' } } as Envelope)
          : ({ ok: true, data: { success: true } } as Envelope);
      }),
    });
    renderPage();
    await screen.findByText(/状态：/);

    fireEvent.click(button('下载'));
    expect(await screen.findByText('校验失败，请重试')).toBeTruthy();
    fireEvent.click(button('下载'));
    expect(await screen.findByText('更新已下载，可安装')).toBeTruthy();
    expect(api.updateDownload).toHaveBeenCalledTimes(2);
  });

  it('下载失败也不会顺手安装', async () => {
    const api = installApi({
      updateDownload: vi.fn(
        async (): Promise<Envelope> => ({ ok: true, data: { success: false, error: '网络中断' } }),
      ),
    });
    renderPage();
    await screen.findByText(/状态：/);
    fireEvent.click(button('下载'));
    expect(await screen.findByText('网络中断')).toBeTruthy();
    expect(api.updateInstall).not.toHaveBeenCalled();
  });
});
