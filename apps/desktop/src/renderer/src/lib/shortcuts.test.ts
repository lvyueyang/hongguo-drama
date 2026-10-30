/**
 * 播放快捷键（迁移自 4.5 `scripts/check-preview-shortcuts.cjs` + `src/shortcuts.js` 的纯逻辑部分）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  ignoresPlaybackShortcut,
  readShortcuts,
  SHORTCUT_ACTIONS,
  SHORTCUT_STORAGE_KEY,
  saveShortcuts,
  shortcutKey,
  validateShortcuts,
} from './shortcuts.ts';

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
};

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('shortcutKey：事件归一', () => {
  it('归一空格、字母与方向键', () => {
    expect(shortcutKey({ key: ' ', code: 'Space' })).toBe('space');
    expect(shortcutKey({ key: 'A', code: 'KeyA' })).toBe('a');
    expect(shortcutKey({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('arrowleft');
    expect(shortcutKey({ key: '5', code: 'Digit5' })).toBe('5');
  });

  it('带功能修饰键或输入法组合时忽略', () => {
    expect(shortcutKey({ key: 'a', code: 'KeyA', metaKey: true })).toBeNull();
    expect(shortcutKey({ key: 'a', code: 'KeyA', ctrlKey: true })).toBeNull();
    expect(shortcutKey({ key: 'a', code: 'KeyA', altKey: true })).toBeNull();
    expect(shortcutKey({ key: 'a', code: 'KeyA', isComposing: true })).toBeNull();
  });

  it('shift 可组合，但 shift+空格被拒绝（会触发页面滚动）', () => {
    expect(shortcutKey({ key: 'A', code: 'KeyA', shiftKey: true })).toBe('shift+a');
    expect(shortcutKey({ key: ' ', code: 'Space', shiftKey: true })).toBeNull();
  });

  it('不认识的键返回 null', () => {
    expect(shortcutKey({ key: 'F1', code: 'F1' })).toBeNull();
    expect(shortcutKey({ key: 'Escape', code: 'Escape' })).toBeNull();
  });
});

describe('formatShortcut', () => {
  it('中文与符号可读', () => {
    expect(formatShortcut('space')).toBe('空格');
    expect(formatShortcut('arrowup')).toBe('↑');
    expect(formatShortcut('shift+a')).toBe('Shift + A');
    expect(formatShortcut('d')).toBe('D');
  });
});

describe('validateShortcuts', () => {
  it('默认绑定合法', () => {
    expect(validateShortcuts({ ...DEFAULT_SHORTCUTS })).toBe('');
  });

  it('指出哪个动作的键不可用', () => {
    const broken = { ...DEFAULT_SHORTCUTS, play: 'F1' };
    expect(validateShortcuts(broken)).toContain('播放 / 暂停');
  });

  it('指出与谁冲突', () => {
    const dup = { ...DEFAULT_SHORTCUTS, next: DEFAULT_SHORTCUTS.play };
    expect(validateShortcuts(dup)).toMatch(/冲突/);
  });

  it('shift+space 一律判为不可用', () => {
    const bad = { ...DEFAULT_SHORTCUTS, play: 'shift+space' };
    expect(validateShortcuts(bad)).toContain('不可用');
  });

  it('缺少某个动作也算不可用', () => {
    const partial = { ...DEFAULT_SHORTCUTS } as Record<string, string>;
    delete partial.fullscreen;
    expect(validateShortcuts(partial)).toContain('全屏');
  });
});

describe('读写与回退', () => {
  it('没有存储时返回完整默认值', () => {
    expect(readShortcuts(storage())).toEqual({ ...DEFAULT_SHORTCUTS });
  });

  it('存储损坏或绑定非法时回退到默认值', () => {
    const broken = storage();
    broken.setItem(SHORTCUT_STORAGE_KEY, '{not json');
    expect(readShortcuts(broken)).toEqual({ ...DEFAULT_SHORTCUTS });

    const invalid = storage();
    invalid.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ ...DEFAULT_SHORTCUTS, play: 'nope' }));
    expect(readShortcuts(invalid)).toEqual({ ...DEFAULT_SHORTCUTS });
  });

  it('保存合法绑定后能读回，并广播变更事件', () => {
    const listener = vi.fn();
    window.addEventListener('hongguo:playback-shortcuts-changed', listener);
    const custom = { ...DEFAULT_SHORTCUTS, play: 'shift+p' };
    saveShortcuts(custom);
    expect(listener).toHaveBeenCalled();
    expect(readShortcuts()).toMatchObject({ play: 'shift+p' });
    window.removeEventListener('hongguo:playback-shortcuts-changed', listener);
  });

  it('保存非法绑定时抛错且不写入', () => {
    expect(() => saveShortcuts({ ...DEFAULT_SHORTCUTS, play: 'F1' })).toThrow(/不可用/);
    expect(readShortcuts()).toEqual({ ...DEFAULT_SHORTCUTS });
  });
});

describe('ignoresPlaybackShortcut：让位规则', () => {
  it('输入框、对话框、菜单里一律让位', () => {
    for (const html of [
      '<input />',
      '<textarea></textarea>',
      '<select></select>',
      '<div role="dialog"><span id="t"></span></div>',
      '<div role="menu"><span id="t"></span></div>',
    ]) {
      document.body.innerHTML = html;
      const target = document.querySelector('#t') ?? document.querySelector('input, textarea, select')!;
      expect(ignoresPlaybackShortcut(target, 'space')).toBe(true);
    }
  });

  it('播放器之外聚焦的按钮要让位，播放器内部的不用', () => {
    document.body.innerHTML =
      '<button id="outside">x</button><div class="player-container"><button id="inside">y</button></div>';
    expect(ignoresPlaybackShortcut(document.querySelector('#outside'), 'space')).toBe(true);
    expect(ignoresPlaybackShortcut(document.querySelector('#inside'), 'space')).toBe(false);
  });

  it('普通容器里的按键正常生效', () => {
    document.body.innerHTML = '<div id="plain"></div>';
    expect(ignoresPlaybackShortcut(document.querySelector('#plain'), 'space')).toBe(false);
  });

  it('默认绑定覆盖 9 个动作', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual(SHORTCUT_ACTIONS.map((a) => a.id).sort());
  });
});
