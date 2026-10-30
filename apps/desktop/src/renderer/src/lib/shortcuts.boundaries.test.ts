/**
 * 快捷键偏好的边界与订阅语义（补 `scripts/check-preview-shortcuts.cjs` 里
 * `lib/shortcuts.test.ts` 尚未覆盖的那几条）。
 *
 * 已有用例覆盖了默认值、归一、冲突校验、损坏回退与基本让位规则；这里补的是旧检查里
 * 容易被重构丢掉的三处：**特殊键必须完全拒绝**、**保存/恢复默认要让订阅者拿到具体绑定**、
 * **其他窗口（storage 事件）与设置面板里的按键也要同步/让位**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  ignoresPlaybackShortcut,
  readShortcuts,
  SHORTCUT_STORAGE_KEY,
  saveShortcuts,
  shortcutKey,
  subscribeShortcuts,
} from './shortcuts.ts';

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('特殊键不产生绑定', () => {
  it('Tab / Enter / Backspace / F5 / Meta / Escape 一律拒绝（会让播放器吞掉导航键）', () => {
    for (const key of ['Tab', 'Enter', 'Backspace', 'F5', 'Meta', 'Escape', 'Shift', 'Dead']) {
      expect(shortcutKey({ key }), key).toBeNull();
    }
  });

  it('组合方向键的展示文案与单个方向键一致', () => {
    expect(formatShortcut('shift+arrowright')).toBe('Shift + →');
    expect(formatShortcut('shift+arrowleft')).toBe('Shift + ←');
  });
});

describe('subscribeShortcuts：同窗口与跨窗口同步', () => {
  it('保存后订阅者拿到新绑定，恢复默认后拿到默认绑定，退订后不再回调', () => {
    const observed: Array<Record<string, string>> = [];
    const stop = subscribeShortcuts((bindings) => observed.push(bindings));

    const custom = { ...DEFAULT_SHORTCUTS, play: 'shift+j' };
    saveShortcuts(custom);
    expect(observed.at(-1)).toEqual(custom);
    // 订阅者读到的是落盘后的值（不是保存前的旧绑定）
    expect(readShortcuts()).toEqual(custom);

    saveShortcuts({ ...DEFAULT_SHORTCUTS });
    expect(observed.at(-1)).toEqual({ ...DEFAULT_SHORTCUTS });

    stop();
    const before = observed.length;
    saveShortcuts({ ...DEFAULT_SHORTCUTS, play: 'shift+k' });
    expect(observed).toHaveLength(before);
  });

  it('其他窗口改了绑定（storage 事件）也会同步，无关键的 storage 事件被忽略', () => {
    const onChange = vi.fn();
    const stop = subscribeShortcuts(onChange);

    const custom = { ...DEFAULT_SHORTCUTS, next: 'shift+n' };
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(custom));
    window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key', newValue: '1' }));
    expect(onChange).not.toHaveBeenCalled();

    window.dispatchEvent(
      new StorageEvent('storage', { key: SHORTCUT_STORAGE_KEY, newValue: JSON.stringify(custom) }),
    );
    expect(onChange).toHaveBeenCalledWith(custom);

    stop();
  });
});

describe('ignoresPlaybackShortcut：设置面板与可编辑区域', () => {
  it('快捷键设置面板与 contenteditable 区域一律让位', () => {
    document.body.innerHTML =
      '<div data-shortcut-settings><button id="in-settings">改键</button></div>' +
      '<div contenteditable="true"><span id="editable">x</span></div>';
    expect(ignoresPlaybackShortcut(document.querySelector('#in-settings'), 'space')).toBe(true);
    expect(ignoresPlaybackShortcut(document.querySelector('#editable'), 'space')).toBe(true);
  });

  it('没有 closest 的目标用 isContentEditable 判定（jsdom 不实现该属性，用纯对象覆盖分支）', () => {
    expect(ignoresPlaybackShortcut({ isContentEditable: true }, 'space')).toBe(true);
    expect(ignoresPlaybackShortcut({}, 'space')).toBe(false);
  });
});
