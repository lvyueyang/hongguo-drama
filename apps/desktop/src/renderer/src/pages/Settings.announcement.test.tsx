// SPDX-License-Identifier: MIT
/**
 * 设置页的公告卡片与两种免提醒方式。
 *
 * 替代 4.5 `scripts/check-announcement-ui.cjs` 里**5.0 仍有对应行为**的部分：公告只由主进程
 * 提供、正文原样显示、免提醒要落盘、落盘失败不假装成功。
 * 推送/轮询/开关/已读/抑制规则在 SDK（`packages/sdk/src/services/meta/announcement-rules.test.ts`
 * 与 `announcements.test.ts`），紧急横幅在 `components/AnnouncementBanner.test.tsx`。
 *
 * 4.5 的关闭倒计时（30 秒自动消失）、全屏 portal、邮件复制、AI 服务外链购买入口在 5.0
 * 没有对应实现或内容（公告只由仓库内 JSON 提供，渲染层不做外链与剪贴板），判 obsolete。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const notice = {
  id: 'notice-1',
  title: '服务维护',
  body: '今晚 22:00 起维护。\n预计 1 小时。',
  level: 'normal',
};

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    appInfo: vi.fn(async () => ({ ok: true, data: { name: '红果短剧', version: '5.0.0' } })),
    capabilities: vi.fn(async () => ({ ok: true, data: { accountAffectsPlayback: false } })),
    getSettings: vi.fn(async () => ({ ok: true, data: { root: '/fixture' } })),
    saveSettings: vi.fn(async () => ({ ok: true, data: {} })),
    announcementGet: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { announcement: notice } })),
    announcementDismiss: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { success: true } })),
    storageUsage: vi.fn(async () => ({ ok: true, data: { root: '/fixture', totalFiles: 0, totalBytes: 0 } })),
    updateState: vi.fn(async () => ({ ok: true, data: { status: 'idle' } })),
    customSourceSave: vi.fn(async () => ({ ok: true, data: {} })),
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
      <Settings />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('设置页公告卡片', () => {
  it('显示主进程给的标题与正文，换行原样保留', async () => {
    installApi();
    renderPage();
    expect(await screen.findByText('服务维护')).toBeTruthy();
    const body = screen.getByText(/今晚 22:00 起维护/);
    expect(body.textContent).toBe('今晚 22:00 起维护。\n预计 1 小时。');
    expect(body.className).toContain('whitespace-pre-wrap');
  });

  it('两种免提醒各自把模式交给主进程，成功后重新取公告', async () => {
    let calls = 0;
    const api = installApi({
      announcementGet: vi.fn(async (): Promise<Envelope> => {
        calls += 1;
        // 第二次（免提醒成功后的重新取数）就说已经没有公告了
        return calls === 1 ? { ok: true, data: { announcement: notice } } : { ok: true, data: {} };
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '今天不再提醒' }));
    await waitFor(() => expect(api.announcementDismiss).toHaveBeenCalledWith({ mode: 'day' }));
    await waitFor(() => expect(api.announcementGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('服务维护')).toBeNull());
  });

  it('「本版本不再提醒」用 version 模式（跨天仍生效，由 SDK 负责）', async () => {
    const api = installApi();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '本版本不再提醒' }));
    await waitFor(() => expect(api.announcementDismiss).toHaveBeenCalledWith({ mode: 'version' }));
  });

  it('没有公告时整张卡片不占位置', async () => {
    installApi({
      announcementGet: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { announcement: null } })),
    });
    renderPage();
    await screen.findByText('下载目录');
    expect(screen.queryByRole('button', { name: '今天不再提醒' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本版本不再提醒' })).toBeNull();
  });

  it('免提醒落盘失败时不假装成功：公告仍在，也不崩', async () => {
    const api = installApi({
      announcementDismiss: vi.fn(
        async (): Promise<Envelope> => ({
          ok: false,
          error: { code: 'STORAGE_UNAVAILABLE', message: '磁盘已满' },
        }),
      ),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '今天不再提醒' }));
    await waitFor(() => expect(api.announcementDismiss).toHaveBeenCalledTimes(1));
    expect(screen.getByText('服务维护')).toBeTruthy();
    expect(screen.getByRole('button', { name: '今天不再提醒' })).toBeTruthy();
  });
});
