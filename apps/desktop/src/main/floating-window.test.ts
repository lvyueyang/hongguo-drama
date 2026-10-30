/**
 * 悬浮播放器窗口（迁移自 4.5 `scripts/check-floating-player-window.cjs` 的窗口侧断言）。
 *
 * 守三条：默认安全配置不能被悄悄放宽；尺寸落盘必须去抖且保留既有设置；
 * 悬浮窗不得通过 window.open 开新窗口。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachFloatingPlayerWindow,
  DEFAULT_FLOATING_SIZE,
  type FloatingWindowLike,
  normalizeFloatingSize,
  RESIZE_PERSIST_DELAY_MS,
} from './floating-window.ts';

class FakeWindow implements FloatingWindowLike {
  static instances: FakeWindow[] = [];
  options: Record<string, unknown>;
  webContents = { setWindowOpenHandler: vi.fn(), loadURL: vi.fn() };
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  size: number[];
  destroyed = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.size = [Number(options.width), Number(options.height)];
    FakeWindow.instances.push(this);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  getSize(): number[] {
    return this.size;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.destroyed = true;
    this.emit('closed');
  }

  show(): void {}
}

function mount(size?: unknown, url = 'hongguo://app/?floating=1') {
  FakeWindow.instances = [];
  const persistSize = vi.fn();
  const timers: Array<() => void> = [];
  const handle = attachFloatingPlayerWindow({
    BrowserWindow: FakeWindow as never,
    url,
    size,
    persistSize,
    setTimeout: (handler) => {
      timers.push(handler);
      return timers.length - 1;
    },
    clearTimeout: (id) => {
      timers[Number(id)] = () => {};
    },
  });
  const tick = (): void => {
    const pending = timers.splice(0, timers.length);
    for (const run of pending) run();
  };
  return { handle, persistSize, tick, window: FakeWindow.instances[0]! };
}

describe('窗口配置', () => {
  it('按传入尺寸建窗，并固定普通标题栏 + 置顶 + 可缩放', () => {
    const { window } = mount({ width: 240, height: 900 });
    expect(window.options.width).toBe(240);
    expect(window.options.height).toBe(900);
    expect(window.options.frame).toBe(true);
    expect(window.options.titleBarStyle).toBe('default');
    expect(window.options.alwaysOnTop).toBe(true);
    expect(window.options.autoHideMenuBar).toBe(true);
    expect(window.options.resizable).toBe(true);
    // 尺寸指外框，不能让 Electron 按内容改写
    expect(window.options.useContentSize).toBe(false);
  });

  it('默认安全配置：sandbox/隔离开，node/webview 关，且刻意不注入 preload', () => {
    const { window } = mount();
    const prefs = window.options.webPreferences as Record<string, unknown>;
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.webviewTag).toBe(false);
    expect(Object.hasOwn(prefs, 'preload')).toBe(false);
  });

  it('加载悬浮入口地址', () => {
    const { window } = mount(undefined, 'hongguo://app/?floating=1&vid=11');
    expect(window.webContents.loadURL).toHaveBeenCalledWith('hongguo://app/?floating=1&vid=11');
  });

  it('window.open 一律拒绝', () => {
    const { window } = mount();
    const handler = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: {
      url: string;
    }) => { action: string };
    expect(handler({ url: 'https://evil.invalid/' }).action).toBe('deny');
  });

  it('尺寸越界或非法时收敛到安全范围', () => {
    // 数字但越界 → 收敛到边界；完全不是数字 → 用默认值
    expect(normalizeFloatingSize({ width: 10, height: 5000 })).toEqual({ width: 180, height: 1600 });
    expect(normalizeFloatingSize({ width: 'abc', height: null })).toEqual({ width: 320, height: 240 });
    expect(normalizeFloatingSize(undefined)).toEqual(DEFAULT_FLOATING_SIZE);
  });
});

describe('尺寸落盘', () => {
  it('连续 resize 只写一次，且写的是最终尺寸', () => {
    const { window, persistSize, tick } = mount();
    window.size = [360, 480];
    window.emit('resize');
    window.size = [400, 520];
    window.emit('resize');
    window.size = [520, 310];
    window.emit('resize');
    expect(persistSize).not.toHaveBeenCalled();

    tick();
    expect(persistSize).toHaveBeenCalledTimes(1);
    expect(persistSize).toHaveBeenCalledWith({ width: 520, height: 310 });
    expect(RESIZE_PERSIST_DELAY_MS).toBeGreaterThan(0);
  });

  it('拖完立刻关窗也会把最后一次尺寸写掉', () => {
    const { window, persistSize } = mount();
    window.size = [440, 700];
    window.emit('resize');
    window.close();
    expect(persistSize).toHaveBeenCalledTimes(1);
    expect(persistSize).toHaveBeenCalledWith({ width: 440, height: 700 });
  });

  it('flush 立即写盘且不重复', () => {
    const { handle, window, persistSize } = mount();
    window.size = [300, 600];
    window.emit('resize');
    handle.flush();
    expect(persistSize).toHaveBeenCalledTimes(1);
    handle.flush();
    expect(persistSize).toHaveBeenCalledTimes(2);
  });

  it('关闭后重复 close 不再动作', () => {
    const { handle, window } = mount();
    handle.close();
    expect(window.destroyed).toBe(true);
    handle.close();
    expect(window.destroyed).toBe(true);
  });
});

describe('悬挂关系与 opener 存活', () => {
  function mountWithParent(parent?: unknown) {
    FakeWindow.instances = [];
    const persistSize = vi.fn();
    attachFloatingPlayerWindow({
      BrowserWindow: FakeWindow as never,
      url: 'hongguo://app/?floating=1',
      persistSize,
      parent,
      setTimeout: (handler) => {
        handler();
        return 0;
      },
      clearTimeout: () => {},
    });
    return FakeWindow.instances[0]!;
  }

  it('给了父窗口就挂上去，且不设 outlivesOpener（打开小窗不能顶掉主窗口）', () => {
    const parent = { id: 'main' };
    const window = mountWithParent(parent);
    expect(window.options.parent).toBe(parent);
    expect(window.options.outlivesOpener).toBeUndefined();
  });

  it('没有主窗口时不编造 parent（避免建出孤儿窗口）', () => {
    const window = mountWithParent(undefined);
    expect(Object.hasOwn(window.options, 'parent')).toBe(false);
  });
});

describe('窗口级设置与导航守卫', () => {
  function mountGuard(isTrustedUrl?: (url: string) => boolean) {
    FakeWindow.instances = [];
    const calls: Array<[string, ...unknown[]]> = [];
    class GuardedWindow extends FakeWindow {
      constructor(options: Record<string, unknown>) {
        super(options);
        for (const method of [
          'setVisibleOnAllWorkspaces',
          'setAlwaysOnTop',
          'setMenuBarVisibility',
          'setMinimumSize',
          'setMaximumSize',
        ]) {
          Object.defineProperty(this, method, {
            value: (...args: unknown[]) => {
              calls.push([method, ...args]);
            },
          });
        }
        Object.defineProperty(this.webContents, 'on', {
          value: (event: string, listener: (...args: unknown[]) => void) => {
            this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
          },
        });
      }
    }
    const handle = attachFloatingPlayerWindow({
      BrowserWindow: GuardedWindow as never,
      url: 'hongguo://app/?floating=1',
      persistSize: vi.fn(),
      isTrustedUrl,
      setTimeout: (handler) => {
        handler();
        return 0;
      },
      clearTimeout: () => {},
    });
    return { calls, window: FakeWindow.instances[0]!, handle };
  }

  it('应用浮在全屏与所有桌面之上，且不占菜单栏、限定尺寸范围', () => {
    const { calls } = mountGuard();
    expect(calls).toEqual([
      ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
      ['setAlwaysOnTop', true],
      ['setMenuBarVisibility', false],
      ['setMinimumSize', 180, 240],
      ['setMaximumSize', 900, 1600],
    ]);
  });

  it('外部地址的导航与重定向都被拦下', () => {
    const { window } = mountGuard((url) => url.startsWith('hongguo://'));
    for (const eventName of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      const listener = (window.listeners.get(eventName) ?? [])[0];
      expect(listener, eventName).toBeTruthy();
      listener?.(
        {
          preventDefault(): void {
            prevented = true;
          },
        },
        'https://evil.invalid/',
      );
      expect(prevented, eventName).toBe(true);
    }
  });

  it('自家页面内的导航放行', () => {
    const { window } = mountGuard((url) => url.startsWith('hongguo://'));
    let prevented = false;
    const listener = (window.listeners.get('will-navigate') ?? [])[0];
    listener?.(
      {
        preventDefault(): void {
          prevented = true;
        },
      },
      'hongguo://app/?floating=1',
    );
    expect(prevented).toBe(false);
  });
});
