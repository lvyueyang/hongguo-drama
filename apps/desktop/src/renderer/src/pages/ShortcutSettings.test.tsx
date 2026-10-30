import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readShortcuts, SHORTCUT_STORAGE_KEY } from '../lib/shortcuts.ts';
import ShortcutSettings from './ShortcutSettings.tsx';

describe('快捷键自定义界面', () => {
  // vitest 未开 globals，RTL 的自动清理不会注册：必须显式 cleanup，否则用例之间会串 DOM。
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('列出全部动作与当前绑定', () => {
    render(<ShortcutSettings />);
    expect(screen.getByText('播放 / 暂停')).toBeTruthy();
    expect(screen.getByText('空格')).toBeTruthy();
    expect(screen.getByText('快退 5 秒')).toBeTruthy();
    expect(screen.getByText('←')).toBeTruthy();
  });

  it('点「修改」后捕获下一次按键并落盘', async () => {
    render(<ShortcutSettings />);
    fireEvent.click(screen.getAllByText('修改')[0] as HTMLElement);
    expect(screen.getByText(/等待按键/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', shiftKey: true });
    await waitFor(() => expect(readShortcuts().play).toBe('shift+p'));
    expect(screen.getByText(/已绑定为 Shift \+ P/)).toBeTruthy();
  });

  it('冲突按键被拒绝，绑定保持不变', async () => {
    render(<ShortcutSettings />);
    fireEvent.click(screen.getAllByText('修改')[0] as HTMLElement);
    // 把「播放」绑到「下一集」的默认键上
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
    await waitFor(() => expect(screen.getByText(/冲突/)).toBeTruthy());
    expect(readShortcuts().play).toBe('space');
  });

  it('Esc 取消修改且不写存储', async () => {
    render(<ShortcutSettings />);
    fireEvent.click(screen.getAllByText('修改')[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.getByText(/已取消修改/)).toBeTruthy());
    expect(window.localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBeNull();
  });

  it('恢复默认会清掉自定义绑定', async () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ ...readShortcuts(), play: 'shift+p' }),
    );
    render(<ShortcutSettings />);
    fireEvent.click(screen.getByText('恢复默认'));
    await waitFor(() => expect(readShortcuts().play).toBe('space'));
  });
});
