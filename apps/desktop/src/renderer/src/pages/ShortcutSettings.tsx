import { Button, Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useEffect, useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  readShortcuts,
  SHORTCUT_ACTIONS,
  type ShortcutBindings,
  saveShortcuts,
  shortcutKey,
  validateShortcuts,
} from '../lib/shortcuts.ts';

/**
 * 快捷键自定义（补齐 4.5 `ShortcutSettings` 的能力）。
 * 交互约定：点「修改」后捕获下一次按键；冲突与非法键当场说明，不静默丢弃。
 */
export default function ShortcutSettings() {
  const [bindings, setBindings] = useState<ShortcutBindings>(() => readShortcuts());
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setCapturing(null);
        setNotice('已取消修改');
        return;
      }
      const key = shortcutKey(event);
      if (!key) {
        setNotice('这个按键不可用（不能带 Ctrl/Alt/Cmd，Shift 只能与字母或数字组合）');
        return;
      }
      const next = { ...bindings, [capturing]: key };
      const error = validateShortcuts(next);
      if (error) {
        setNotice(error);
        return;
      }
      try {
        saveShortcuts(next);
        setBindings(next);
        setCapturing(null);
        setNotice(`已绑定为 ${formatShortcut(key)}`);
      } catch (failure) {
        setNotice((failure as Error).message);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, bindings]);

  const reset = (): void => {
    const defaults = { ...DEFAULT_SHORTCUTS };
    saveShortcuts(defaults);
    setBindings(defaults);
    setCapturing(null);
    setNotice('已恢复默认按键');
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>播放快捷键</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reset}>
            恢复默认
          </Button>
          {capturing && (
            <Button size="sm" variant="ghost" onClick={() => setCapturing(null)}>
              取消修改
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-border-subtle">
          {SHORTCUT_ACTIONS.map((action) => (
            <li key={action.id} className="flex items-center justify-between py-1.5">
              <span className="text-[var(--font-size-label)] text-secondary-text">{action.label}</span>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-border-subtle bg-surface px-2 py-0.5 text-[var(--font-size-caption)]">
                  {formatShortcut(bindings[action.id] ?? DEFAULT_SHORTCUTS[action.id] ?? '')}
                </kbd>
                <Button
                  size="sm"
                  variant={capturing === action.id ? 'primary' : 'outline'}
                  onClick={() => {
                    setCapturing(action.id);
                    setNotice(`请按下要绑定到「${action.label}」的按键（Esc 取消）`);
                  }}
                >
                  {capturing === action.id ? '等待按键…' : '修改'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {notice && <p className="text-[var(--font-size-caption)] text-secondary-text">{notice}</p>}
        <p className="text-[var(--font-size-caption)] text-muted">
          焦点在输入框、对话框或播放器之外的按钮上时快捷键会让位；设置立即生效，无需重启。
        </p>
      </CardContent>
    </Card>
  );
}
