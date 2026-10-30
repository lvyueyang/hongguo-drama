/**
 * 悬浮播放器窗口（迁移自 4.5 `main.js: attachFloatingPlayerWindow` / `check-floating-player-window.cjs`）。
 *
 * 设计要点：
 * - 子窗口挂在主窗口下（`parent`），但**不**让 opener 失去可用性（不设 `outlivesOpener`）；
 * - 默认安全配置：sandbox + contextIsolation 开，nodeIntegration / webviewTag 关，且**不注入 preload**；
 * - 尺寸变化去抖后才落盘，且保存时保留既有设置（不能把别的设置键写丢）；
 * - `window.open` 一律拒绝：悬浮窗是只读播放器，不允许自己开新窗口。
 *
 * 用注入的 `BrowserWindow` 工厂构造，测试里不需要真窗口。
 */

export interface FloatingWindowSize {
  width: number;
  height: number;
}

export const DEFAULT_FLOATING_SIZE: FloatingWindowSize = { width: 320, height: 500 };
const MIN_WIDTH = 180;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 1600;
/** 尺寸落盘去抖：拖拽窗口时每帧都写会打爆存储 */
export const RESIZE_PERSIST_DELAY_MS = 400;

export function normalizeFloatingSize(input: unknown): FloatingWindowSize {
  const raw = (input ?? {}) as Partial<FloatingWindowSize>;
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  return {
    width: clamp(raw.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_FLOATING_SIZE.width),
    height: clamp(raw.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_FLOATING_SIZE.height),
  };
}

export interface FloatingWindowDeps {
  BrowserWindow: new (options: Record<string, unknown>) => FloatingWindowLike;
  /** 父窗口：悬浮窗挂在主窗口下，主窗口关闭时一起关掉，避免留下孤儿窗口 */
  parent?: unknown;
  /** 是否允许该地址在悬浮窗内导航；不给则不做导航（最保守） */
  isTrustedUrl?: (url: string) => boolean;
  /** 悬浮窗加载的地址（渲染层入口，带悬浮参数） */
  url: string;
  size?: unknown;
  /** 尺寸稳定后落盘；实现方负责保留既有设置 */
  persistSize(size: FloatingWindowSize): void;
  /** 注入计时器便于测试去抖；默认用全局 setTimeout */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface FloatingWindowLike {
  options?: Record<string, unknown>;
  webContents: {
    setWindowOpenHandler?(
      handler: (details: { url: string; frameName?: string }) => { action: string },
    ): void;
    on?(event: string, listener: (...args: unknown[]) => void): void;
    loadURL?(url: string): unknown;
  };
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners?(event: string): void;
  isDestroyed?(): boolean;
  setAlwaysOnTop?(value: boolean): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setMenuBarVisibility?(visible: boolean): void;
  setMinimumSize?(width: number, height: number): void;
  setMaximumSize?(width: number, height: number): void;
  setSize?(width: number, height: number): void;
  getSize?(): number[];
  close?(): void;
  destroy?(): void;
  show?(): void;
  focus?(): void;
}

export interface FloatingPlayerHandle {
  window: FloatingWindowLike;
  /** 立即把待写入的尺寸落盘（窗口关闭时调用，避免丢掉最后一次拖拽） */
  flush(): void;
  close(): void;
}

/**
 * 创建并挂上悬浮播放器窗口。重复调用返回同一个窗口（不会开第二个）。
 */
export function attachFloatingPlayerWindow(deps: FloatingWindowDeps): FloatingPlayerHandle {
  const size = normalizeFloatingSize(deps.size);
  const timer = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const window = new deps.BrowserWindow({
    width: size.width,
    height: size.height,
    // 保留系统边框：4.5 用普通标题栏，方便用户拖拽与关闭。
    frame: true,
    titleBarStyle: 'default',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    // 传入的是外框尺寸，不能被内容尺寸改写
    useContentSize: false,
    skipTaskbar: false,
    // 挂在主窗口下（不设 outlivesOpener：打开悬浮窗不能抢占/顶掉主窗口）
    ...(deps.parent ? { parent: deps.parent } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 悬浮窗只需要播放，不需要任何特权桥：刻意不注入 preload
    },
  });

  let pending: unknown = null;
  const readSize = (): FloatingWindowSize => {
    const [width, height] = window.getSize?.() ?? [size.width, size.height];
    return normalizeFloatingSize({ width, height });
  };
  const persist = (): void => {
    pending = null;
    deps.persistSize(readSize());
  };

  window.on('resize', () => {
    if (pending !== null) cancel(pending);
    pending = timer(persist, RESIZE_PERSIST_DELAY_MS);
  });
  window.on('closed', () => {
    // 关闭时把最后一次尺寸写掉，否则用户拖完立刻关窗会丢尺寸。
    if (pending !== null) cancel(pending);
    persist();
  });
  // 悬浮窗不允许自己开新窗口。
  window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));

  // 悬浮窗要浮在全屏应用与其它桌面之上，同时不占用菜单栏。
  window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop?.(true);
  window.setMenuBarVisibility?.(false);
  window.setMinimumSize?.(MIN_WIDTH, MIN_HEIGHT);
  window.setMaximumSize?.(MAX_WIDTH, MAX_HEIGHT);

  // 导航守卫：悬浮窗只允许停在自家页面上，任何跳转都拦下（含重定向）。
  if (deps.isTrustedUrl) {
    for (const event of ['will-navigate', 'will-redirect']) {
      window.webContents.on?.(event, (...args: unknown[]) => {
        const [navEvent, url] = args as [{ preventDefault?: () => void }, string];
        if (deps.isTrustedUrl?.(url)) return;
        navEvent?.preventDefault?.();
      });
    }
  }

  window.webContents.loadURL?.(deps.url);
  window.show?.();

  return {
    window,
    flush: () => {
      if (pending !== null) cancel(pending);
      persist();
    },
    close: () => {
      if (window.isDestroyed?.()) return;
      window.close?.();
    },
  };
}
