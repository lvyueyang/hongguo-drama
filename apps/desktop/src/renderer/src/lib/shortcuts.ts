/**
 * 播放快捷键（迁移自 4.5 `src/shortcuts.js`）。
 *
 * 两条容易出错的规则保持不变：
 * - 只认「无修饰键 + 单键」或 `shift+` 组合，`shift+space` 明确剔除（浏览器会触发滚动/激活）；
 * - 焦点在输入框、对话框、菜单或播放器之外的按钮上时，快捷键必须让位——
 *   否则空格会"点"到刚刚点过的分集按钮。
 */
export const SHORTCUT_STORAGE_KEY = 'hongguo:playback-shortcuts:v1';
export const SHORTCUT_EVENT = 'hongguo:playback-shortcuts-changed';

export interface ShortcutAction {
  id: string;
  label: string;
  key: string;
  repeat?: boolean;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'play', label: '播放 / 暂停', key: 'space' },
  { id: 'backward', label: '快退 5 秒', key: 'arrowleft', repeat: true },
  { id: 'forward', label: '快进 5 秒', key: 'arrowright', repeat: true },
  { id: 'previous', label: '上一集', key: 'arrowup' },
  { id: 'next', label: '下一集', key: 'arrowdown' },
  { id: 'autoNext', label: '切换连播', key: 'a' },
  { id: 'slower', label: '减速 0.25 倍', key: 's', repeat: true },
  { id: 'faster', label: '加速 0.25 倍', key: 'd', repeat: true },
  { id: 'fullscreen', label: '切换全屏', key: 'f' },
];

export type ShortcutBindings = Record<string, string>;

export const DEFAULT_SHORTCUTS: Readonly<ShortcutBindings> = Object.freeze(
  Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, action.key])),
);

const KEY_PATTERN = /^(shift\+)?([a-z0-9]|space|arrowleft|arrowright|arrowup|arrowdown)$/;

/** 把键盘事件归一成绑定值；带修饰键、输入法组合中的事件一律忽略。 */
export function shortcutKey(event: {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  let key = String(event.key ?? '').toLowerCase();
  if (event.code === 'Space' || key === ' ') key = 'space';
  else if (/^Key[A-Z]$/.test(event.code ?? '')) key = String(event.code).slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(event.code ?? '')) key = String(event.code).slice(5);
  const value = `${event.shiftKey ? 'shift+' : ''}${key}`;
  return KEY_PATTERN.test(value) && value !== 'shift+space' ? value : null;
}

export function formatShortcut(value: string): string {
  const names: Record<string, string> = {
    space: '空格',
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    arrowdown: '↓',
  };
  return String(value)
    .split('+')
    .map((key) => names[key] ?? (key === 'shift' ? 'Shift' : key.toUpperCase()))
    .join(' + ');
}

/** 返回错误文案；空字符串表示可用。重复绑定会被指出与谁冲突。 */
export function validateShortcuts(bindings: ShortcutBindings | null | undefined): string {
  const seen = new Map<string, string>();
  for (const action of SHORTCUT_ACTIONS) {
    const key = bindings?.[action.id];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key === 'shift+space') {
      return `${action.label}的按键不可用`;
    }
    if (seen.has(key)) return `与「${seen.get(key)}」冲突，请换一个按键`;
    seen.set(key, action.label);
  }
  return '';
}

export function readShortcuts(storage: Pick<Storage, 'getItem'> = window.localStorage): ShortcutBindings {
  try {
    const stored = JSON.parse(storage.getItem(SHORTCUT_STORAGE_KEY) ?? 'null');
    if (!validateShortcuts(stored)) {
      return Object.fromEntries(SHORTCUT_ACTIONS.map(({ id }) => [id, String(stored[id])]));
    }
  } catch {
    /* 缺失或损坏一律回退到完整默认值 */
  }
  return { ...DEFAULT_SHORTCUTS };
}

export function saveShortcuts(bindings: ShortcutBindings): void {
  const error = validateShortcuts(bindings);
  if (error) throw new Error(error);
  window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  window.dispatchEvent(new Event(SHORTCUT_EVENT));
}

export function subscribeShortcuts(onChange: (bindings: ShortcutBindings) => void): () => void {
  const update = (event: Event): void => {
    const storageEvent = event as StorageEvent;
    if (event.type !== 'storage' || storageEvent.key === SHORTCUT_STORAGE_KEY || storageEvent.key === null) {
      onChange(readShortcuts());
    }
  };
  window.addEventListener(SHORTCUT_EVENT, update);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(SHORTCUT_EVENT, update);
    window.removeEventListener('storage', update);
  };
}

const BLOCKING_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-shortcut-settings]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="listbox"]',
].join(', ');

/** 事件目标是否应当吞掉播放快捷键。 */
export function ignoresPlaybackShortcut(target: unknown, key?: string | null): boolean {
  const element = target as (Element & { isContentEditable?: boolean }) | null;
  if (!element?.closest) return Boolean((target as { isContentEditable?: boolean })?.isContentEditable);
  if (element.isContentEditable || element.closest(BLOCKING_SELECTOR)) return true;
  // 播放器之外的按钮/链接保留原生键盘行为；播放器内部的控制条仍可响应。
  return Boolean(element.closest('button, a') && !element.closest('.player-container'));
}
