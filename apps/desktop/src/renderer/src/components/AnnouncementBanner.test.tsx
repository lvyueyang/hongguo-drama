import { Events } from '@hongguo/contract';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementBanner } from './AnnouncementBanner.tsx';

type Listener = (payload: unknown) => void;
const listeners: Record<string, Listener> = {};

function installApi(overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(listeners)) delete listeners[key];
  const api = {
    announcementDismiss: vi.fn(async () => ({ ok: true, data: { success: true } })),
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

beforeEach(() => {
  installApi();
});

// vitest 未开 globals，RTL 不会自动清理；不清理会让下一次 render 与上一次的 DOM 重名。
afterEach(() => cleanup());

describe('紧急公告横幅', () => {
  it('没有公告时不占位置', () => {
    const { container } = render(<AnnouncementBanner />);
    expect(container.textContent).toBe('');
  });

  it('主进程推来公告才显示标题与正文（不去设置页也能看到）', async () => {
    render(<AnnouncementBanner />);
    expect(listeners[Events.announcement]).toBeTruthy();
    listeners[Events.announcement]?.({ announcement: { id: 'a1', title: '紧急通知', body: '今晚维护' } });
    await waitFor(() => expect(screen.getByText('紧急通知')).toBeTruthy());
    expect(screen.getByText('今晚维护')).toBeTruthy();
  });

  it('「知道了」收起横幅并落盘「今天不再提醒」；落盘失败也只是下次再提醒', async () => {
    const api = installApi({
      announcementDismiss: vi.fn(async () => ({
        ok: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: '磁盘已满' },
      })),
    });
    render(<AnnouncementBanner />);
    listeners[Events.announcement]?.({ announcement: { id: 'a1', title: '紧急通知', body: '正文' } });
    await waitFor(() => expect(screen.getByText('知道了')).toBeTruthy());
    screen.getByText('知道了').click();
    // 渲染层的 lib/api.ts 负责把模式包成契约对象，preload 侧看到的是 { mode }
    await waitFor(() => expect(api.announcementDismiss).toHaveBeenCalledWith({ mode: 'day' }));
    await waitFor(() => expect(screen.queryByText('紧急通知')).toBeNull());
  });

  it('空 payload 或没有 id 的公告不显示（避免一条空横幅卡在界面上）', async () => {
    render(<AnnouncementBanner />);
    listeners[Events.announcement]?.({ announcement: null });
    listeners[Events.announcement]?.({ announcement: { title: '没有 id' } });
    await waitFor(() => expect(screen.queryByText('没有 id')).toBeNull());
  });
});
