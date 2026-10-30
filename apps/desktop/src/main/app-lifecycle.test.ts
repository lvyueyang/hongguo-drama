/**
 * 主进程启动 / 单实例 / 窗口生命周期（迁移自 4.5 的 vm 检查）。
 *
 * 来源：
 * - `scripts/check-single-instance.cjs`：单实例锁、第二次启动唤醒已有窗口、锁未拿到时立刻退出；
 * - `scripts/check-backend-lifecycle.cjs`：窗口全部关闭后的退出语义；
 * - `scripts/check-macos.cjs`：Dock 激活重建主窗口；
 * - `scripts/check-renderer-security.cjs`：可信发送者、导航/弹窗守卫、权限决策（这些是
 *   `index.ts` 里的**运行时接线**，此前只有源码字符串断言）。
 *
 * 做法：4.5 用 `vm` 跑 `main.js` + 手写假 Electron；5.0 的主进程入口直接 `import 'electron'`，
 * 这里用 `vi.mock('electron')` 注入替身，跑的仍是**真正的主进程入口代码**——锁、app ready、
 * 窗口创建、IPC 注册、退出与激活都是真实执行路径，不是字符串匹配。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Channels } from '@hongguo/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface EmitterLike {
  emit(event: string, ...args: unknown[]): boolean;
}

type PermissionDetails = { isMainFrame?: boolean; requestingUrl?: string } | undefined;
type PermissionRequestHandler = (
  contents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
  details: PermissionDetails,
) => void;
type PermissionCheckHandler = (
  contents: unknown,
  permission: string,
  origin: string | undefined,
  details: PermissionDetails,
) => boolean;
type WindowOpenHandler = (details: { url: string }) => { action: string };

interface FakeWebContents {
  mainFrame: { url: string };
  openHandler?: WindowOpenHandler;
  send(channel: string): void;
  setWindowOpenHandler(handler: WindowOpenHandler): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
}

interface FakeWindow {
  destroyed: boolean;
  minimized: boolean;
  options: Record<string, unknown>;
  webContents: FakeWebContents;
  close(): void;
  emit(event: string, ...args: unknown[]): boolean;
  once(event: string, listener: (...args: never[]) => void): unknown;
}

interface IpcEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

const h = vi.hoisted(() => ({
  lock: true,
  quits: 0,
  userData: '',
  resolveReady: null as (() => void) | null,
  app: null as EmitterLike | null,
  windows: [] as FakeWindow[],
  /** 便携模式会改 userData/sessionData，所以另记启动前的系统目录 */
  defaultUserData: '',
  sessionData: '',
  /** 窗口上的可见动作顺序（restore / focus / show），用于断言唤醒语义 */
  calls: [] as string[],
  /** 主进程推给渲染层的事件名 */
  sent: [] as string[],
  ipcChannels: [] as string[],
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  protocolChannels: [] as string[],
  permissionRequest: null as PermissionRequestHandler | null,
  permissionCheck: null as PermissionCheckHandler | null,
  errorBoxes: [] as string[],
  /** 应用菜单模板（断言标准编辑角色在不在） */
  menu: null as Array<Record<string, any>> | null,
  /** 系统浏览器实际被要求打开的地址 */
  opened: [] as string[],
  /** 命令行里出现的开关（--user-data-dir 等） */
  switches: [] as string[],
}));

/** 每个用例一份新的更新器替身（否则监听器会在用例之间累积）。 */
async function createUpdaterMock(): Promise<Record<string, unknown>> {
  const { EventEmitter } = await import('node:events');
  const autoUpdater = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
  autoUpdater.setFeedURL = () => undefined;
  autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '0.0.0' } });
  autoUpdater.downloadUpdate = async () => [];
  autoUpdater.quitAndInstall = () => undefined;
  return { autoUpdater };
}

/**
 * Electron 替身。`vi.doMock` 在 `boot()` 里按用例重新注册：
 * 模块注册表里的 mock 实例不会随 `vi.resetModules()` 失效，
 * 只有重新注册才会拿到干净的 app（否则上一个用例的监听器会继续响应事件）。
 */
async function createElectronMock(): Promise<Record<string, unknown>> {
  const { EventEmitter } = await import('node:events');
  const nodePath = (await import('node:path')).default;

  /** 会话对象既给主窗口用，也是 defaultSession：如实反映 Electron 的结构。 */
  const defaultSession = {
    setProxy: async () => undefined,
    cookies: { get: async () => [], remove: async () => undefined },
    clearStorageData: async () => undefined,
    setPermissionRequestHandler: (handler: PermissionRequestHandler) => {
      h.permissionRequest = handler;
    },
    setPermissionCheckHandler: (handler: PermissionCheckHandler) => {
      h.permissionCheck = handler;
    },
  };

  const app = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
  app.commandLine = {
    appendSwitch: () => undefined,
    hasSwitch: (name: string) => h.switches.includes(name),
  };
  app.getVersion = () => '5.0.0-test';
  app.getName = () => 'hongguo-drama';
  app.isPackaged = false;
  // 便携模式会改这两个；启动路径必须在读 userData 之前调用 setPath。
  app.setPath = (name: string, value: string) => {
    if (name === 'sessionData') h.sessionData = value;
    else h.userData = value;
  };
  app.setName = () => undefined;
  app.getPath = (name: string) =>
    name === 'userData' ? h.userData : nodePath.join(h.userData, String(name));
  app.requestSingleInstanceLock = () => h.lock;
  app.quit = () => {
    h.quits += 1;
  };
  app.whenReady = () =>
    new Promise<void>((resolve) => {
      h.resolveReady = resolve;
    });
  h.app = app as unknown as EmitterLike;

  class FakeBrowserWindow extends EventEmitter {
    static getAllWindows(): FakeWindow[] {
      return h.windows.filter((entry) => !entry.destroyed);
    }
    destroyed = false;
    minimized = true;
    options: Record<string, unknown>;
    webContents: FakeWebContents;

    constructor(options: Record<string, unknown> = {}) {
      super();
      this.options = options;
      const contents = new EventEmitter() as unknown as FakeWebContents;
      contents.mainFrame = { url: RENDERER_ENTRY };
      contents.send = (channel: string) => {
        h.sent.push(channel);
      };
      contents.setWindowOpenHandler = (handler: WindowOpenHandler) => {
        contents.openHandler = handler;
      };
      (contents as unknown as { session: unknown }).session = defaultSession;
      this.webContents = contents;
      h.windows.push(this as unknown as FakeWindow);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.minimized = false;
      h.calls.push('restore');
    }
    focus(): void {
      h.calls.push('focus');
    }
    show(): void {
      h.calls.push('show');
    }
    close(): void {
      this.destroyed = true;
      this.emit('closed');
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        h.ipcChannels.push(channel);
        h.ipcHandlers.set(channel, listener);
      },
    },
    session: {
      defaultSession,
      fromPartition: () => ({
        fetch: async () => {
          throw new Error('测试内不联网');
        },
        clearStorageData: async () => undefined,
      }),
    },
    net: {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({}),
      }),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: () => '',
    },
    dialog: {
      showErrorBox: (_title: string, _content: string) => {
        h.errorBoxes.push(_content);
      },
    },
    Menu: {
      buildFromTemplate: (template: unknown) => template,
      setApplicationMenu: (menu: unknown) => {
        h.menu = menu as Array<Record<string, any>>;
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => undefined,
      handle: (channel: string) => {
        h.protocolChannels.push(channel);
      },
    },
    shell: {
      openExternal: async (url: string) => {
        h.opened.push(url);
      },
    },
  };
}

/** 与 index.ts 的 navigationContext() 保持一致：只认这个渲染入口文件。 */
const RENDERER_ENTRY = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;

const tempDirs: string[] = [];
const originalPlatform = process.platform;
const originalPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR;

function resetState(): void {
  h.lock = true;
  h.quits = 0;
  h.resolveReady = null;
  h.app = null;
  h.windows.length = 0;
  h.calls.length = 0;
  h.sent.length = 0;
  h.ipcChannels.length = 0;
  h.ipcHandlers.clear();
  h.protocolChannels.length = 0;
  h.permissionRequest = null;
  h.permissionCheck = null;
  h.errorBoxes.length = 0;
  h.menu = null;
  h.opened.length = 0;
  h.defaultUserData = '';
  h.sessionData = '';
}

function app(): EmitterLike {
  if (!h.app) throw new Error('electron 替身还没装配（主进程入口未加载）');
  return h.app;
}

function windows(): FakeWindow[] {
  return h.windows;
}

/** 让 whenReady().then(...) 与其中的微任务链跑完。 */
async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 真正加载主进程入口（每个用例一份全新的模块与 Electron 替身）。 */
async function boot(
  options: {
    lock?: boolean;
    data?: unknown;
    corruptData?: boolean;
    portableDir?: string;
    switches?: string[];
  } = {},
): Promise<string> {
  vi.resetModules();
  resetState();
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-lifecycle-'));
  h.defaultUserData = h.userData;
  tempDirs.push(h.userData);
  if (options.lock === false) h.lock = false;
  if (options.portableDir) process.env.PORTABLE_EXECUTABLE_DIR = options.portableDir;
  h.switches = options.switches ?? [];
  if (options.data !== undefined) {
    fs.writeFileSync(path.join(h.userData, 'data.json'), JSON.stringify(options.data));
  }
  if (options.corruptData) fs.writeFileSync(path.join(h.userData, 'data.json'), '{not json');
  // mock 模块实例不会随 resetModules 失效，必须按用例重新注册
  vi.doMock('electron', createElectronMock);
  vi.doMock('electron-updater', createUpdaterMock);
  await import('./index.ts');
  if (!h.lock) return h.userData;
  if (!h.resolveReady) throw new Error('主进程没有等待 app ready');
  h.resolveReady();
  await flush();
  return h.userData;
}

async function callIpc(channel: string, ...args: unknown[]): Promise<IpcEnvelope> {
  const handler = h.ipcHandlers.get(channel);
  if (!handler) throw new Error(`通道没有注册：${channel}`);
  const win = windows()[0];
  return (await handler(
    { sender: win?.webContents, senderFrame: win?.webContents.mainFrame },
    ...args,
  )) as IpcEnvelope;
}

function usePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalPortableEnv === undefined) Reflect.deleteProperty(process.env, 'PORTABLE_EXECUTABLE_DIR');
  else process.env.PORTABLE_EXECUTABLE_DIR = originalPortableEnv;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('单实例锁', () => {
  it('没拿到锁的进程立刻退出：不建窗口、不读本地数据、不注册 IPC 与协议', async () => {
    const dir = await boot({ lock: false });

    expect(h.quits).toBe(1);
    expect(windows()).toHaveLength(0);
    expect(h.ipcChannels).toHaveLength(0);
    expect(h.protocolChannels).toHaveLength(0);
    // 一次 getPath/存储初始化都不能发生：这就是「退出要早于 readiness」的不变量
    expect(h.resolveReady).toBeNull();
    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(false);
  });

  it('拿到锁的进程：只建一个主窗口，设置落盘到 userData/data.json', async () => {
    const dir = await boot();

    expect(h.quits).toBe(0);
    expect(windows()).toHaveLength(1);
    expect(windows()[0]?.options.title).toBe('红果短剧');

    // 存储初始化必须指向 userData（不是工作目录、不是系统下载目录）
    expect((await callIpc(Channels.settingsSave, { max_concurrent: 3 })).ok).toBe(true);
    const document = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')) as {
      settings: { max_concurrent: number };
    };
    expect(document.settings.max_concurrent).toBe(3);
  });

  it('契约里的每个通道都注册且只注册一次，两个自定义协议也注册了', async () => {
    await boot();

    expect([...h.ipcChannels].sort()).toEqual([...Object.values(Channels)].sort());
    expect(new Set(h.ipcChannels).size).toBe(h.ipcChannels.length);
    expect(h.protocolChannels).toEqual(expect.arrayContaining(['hongguo-stream', 'hongguo-local']));
  });

  it('第二次启动唤醒已有窗口：最小化则先还原，然后聚焦', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    win.minimized = true;
    h.calls.length = 0;

    app().emit('second-instance');

    expect(h.calls).toEqual(['restore', 'focus']);
    expect(win.minimized).toBe(false);
    expect(windows()).toHaveLength(1);
  });

  it('未最小化时第二次启动只聚焦，不重复还原', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    win.minimized = false;
    h.calls.length = 0;

    app().emit('second-instance');

    expect(h.calls).toEqual(['focus']);
  });

  it('主窗口已关闭时第二次启动不凭空建窗口（4.5 会重建，见迁移报告遗留项）', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    win.close();
    h.calls.length = 0;

    app().emit('second-instance');

    expect(windows()).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });
});

describe('窗口生命周期', () => {
  it('Windows/Linux：所有窗口关闭就走正常退出', async () => {
    usePlatform('win32');
    await boot();

    app().emit('window-all-closed');

    expect(h.quits).toBe(1);
  });

  it('macOS：所有窗口关闭不退出（等 Dock 再激活）', async () => {
    usePlatform('darwin');
    await boot();

    app().emit('window-all-closed');

    expect(h.quits).toBe(0);
  });

  it('macOS Dock 激活：没有窗口才重建，已有窗口不重复建', async () => {
    usePlatform('darwin');
    await boot();

    app().emit('activate');
    expect(windows()).toHaveLength(1);

    (windows()[0] as FakeWindow).close();
    app().emit('activate');

    expect(windows()).toHaveLength(2);
    expect(h.quits).toBe(0);
  });
});

describe('启动装配', () => {
  it('上次没跑完的任务只回填记录，不会自动开跑', async () => {
    await boot({
      data: {
        settings: { root: '/nonexistent-root' },
        tasks: [
          { id: 'paused', vid: '1', seriesId: 's1', savePath: '/x/1.mp4', status: 'paused' },
          { id: 'done', vid: '2', seriesId: 's1', savePath: '/x/2.mp4', status: 'completed' },
        ],
      },
    });

    const result = await callIpc(Channels.downloadList);
    expect(result.ok).toBe(true);
    const tasks = result.data as Array<{ id: string; status: string }>;
    expect(tasks.map((task) => [task.id, task.status])).toEqual([
      ['paused', 'paused'],
      ['done', 'completed'],
    ]);
    expect(tasks.some((task) => task.status === 'downloading' || task.status === 'pending')).toBe(false);
  });

  it('便携版：在读 userData 之前就把资料目录切到程序目录', async () => {
    usePlatform('win32');
    const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-portable-'));
    tempDirs.push(portableDir);

    await boot({ portableDir });

    expect((await callIpc(Channels.settingsSave, { max_concurrent: 4 })).ok).toBe(true);
    // 资料落在程序目录下的 data/，系统目录一个文件都不写；会话目录也跟着切
    expect(fs.existsSync(path.join(portableDir, 'data', 'data.json'))).toBe(true);
    expect(fs.existsSync(path.join(h.defaultUserData, 'data.json'))).toBe(false);
    expect(h.sessionData).toBe(path.join(portableDir, 'data'));
  });

  it('启动时不同步扫描下载目录（大容量/慢盘不能挡住第一个窗口）', async () => {
    const readdir = vi.spyOn(fs, 'readdirSync');
    const downloads = path.join(os.tmpdir(), 'hongguo-downloads-not-scanned');

    await boot({ data: { settings: { root: downloads } } });

    expect(windows()).toHaveLength(1);
    const scanned = readdir.mock.calls.filter(([target]) =>
      String(target).includes('hongguo-downloads-not-scanned'),
    );
    expect(scanned).toEqual([]);
  });

  it('本地数据损坏时不崩溃、不覆盖原文件（4.5 是弹窗后退出，见迁移报告遗留项）', async () => {
    const dir = await boot({ corruptData: true });

    expect(windows()).toHaveLength(1);
    expect(h.quits).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).toBe('{not json');
  });
});

describe('渲染层边界（真实装配的运行时行为）', () => {
  it('本窗口主 frame 的 IPC 请求放行，外来窗口与子 frame 一律拒绝', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    const handler = h.ipcHandlers.get(Channels.appInfo);
    expect(handler).toBeTypeOf('function');

    const trusted = (await handler?.({
      sender: win.webContents,
      senderFrame: win.webContents.mainFrame,
    })) as IpcEnvelope;
    expect(trusted.ok).toBe(true);
    expect(trusted.data).toMatchObject({ name: 'hongguo-drama', version: '5.0.0-test' });

    const foreign = (await handler?.({ sender: {}, senderFrame: win.webContents.mainFrame })) as IpcEnvelope;
    expect(foreign).toEqual({
      ok: false,
      error: { code: 'UNTRUSTED_SENDER', message: '窗口请求无效' },
    });

    const subframe = (await handler?.({
      sender: win.webContents,
      senderFrame: { url: win.webContents.mainFrame.url },
    })) as IpcEnvelope;
    expect(subframe.ok).toBe(false);
    expect(subframe.error?.code).toBe('UNTRUSTED_SENDER');
  });

  it('主窗口关闭后，旧发送者不再可信', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    win.close();

    const result = (await h.ipcHandlers.get(Channels.appInfo)?.(event)) as IpcEnvelope;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNTRUSTED_SENDER');
  });

  it('新窗口一律拒绝在应用内打开（含 https 与 javascript:）', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;

    expect(win.webContents.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(win.webContents.openHandler?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
  });

  it('页面导航：应用自身页面放行，外部站点拦下', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };

    win.webContents.emit('will-navigate', event, `${RENDERER_ENTRY}#/settings`);
    expect(prevented).toBe(false);

    win.webContents.emit('will-navigate', event, 'https://evil.invalid/');
    expect(prevented).toBe(true);
  });

  it('权限：可信主 frame 只拿得到全屏与剪贴板，其它一律拒绝', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    const authorize = (contents: unknown, permission: string, details: PermissionDetails): boolean => {
      let allowed: boolean | null = null;
      h.permissionRequest?.(
        contents,
        permission,
        (value) => {
          allowed = value;
        },
        details,
      );
      return allowed === true;
    };
    const detail = { isMainFrame: true, requestingUrl: RENDERER_ENTRY };

    expect(authorize(win.webContents, 'fullscreen', detail)).toBe(true);
    expect(authorize(win.webContents, 'clipboard-read', detail)).toBe(true);
    expect(authorize(win.webContents, 'media', detail)).toBe(false);
    expect(authorize({}, 'fullscreen', detail)).toBe(false);
    expect(authorize(win.webContents, 'fullscreen', { ...detail, isMainFrame: false })).toBe(false);
    expect(
      authorize(win.webContents, 'fullscreen', {
        isMainFrame: true,
        requestingUrl: 'https://evil.invalid/',
      }),
    ).toBe(false);
  });

  it('同步权限检查与权限请求同一套策略（避免「请求允许但检查被拒」）', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    const check = h.permissionCheck;
    const url = RENDERER_ENTRY;

    expect(check?.(win.webContents, 'fullscreen', url, { isMainFrame: true, requestingUrl: url })).toBe(true);
    expect(check?.(win.webContents, 'media', url, { isMainFrame: true, requestingUrl: url })).toBe(false);
    expect(check?.({}, 'fullscreen', url, { isMainFrame: true, requestingUrl: url })).toBe(false);
    expect(
      check?.(win.webContents, 'fullscreen', 'https://evil.invalid/', {
        isMainFrame: true,
        requestingUrl: 'https://evil.invalid/',
      }),
    ).toBe(false);
  });
});

/**
 * 这三条曾是 4.5 `check-renderer-security.cjs` 断言过、5.0 不成立的缺口，
 * 现已补齐（file: 只认渲染入口、will-redirect 同策略、外部链接真的交给系统浏览器）。
 */
describe('渲染层边界：补上的三条（原为已知缺口）', () => {
  it('其它本地文件不算可信页面（只认渲染入口文件）', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    let prevented = false;

    win.webContents.emit(
      'will-navigate',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      'file:///tmp/hostile.html',
    );

    expect(prevented).toBe(true);
  });

  it('服务器重定向也被拦下（will-redirect 与 will-navigate 同一套策略）', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;
    let prevented = false;

    win.webContents.emit(
      'will-redirect',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      'https://evil.invalid/',
    );

    expect(prevented).toBe(true);
  });

  it('外部 https 交给系统浏览器', async () => {
    await boot();
    const win = windows()[0] as FakeWindow;

    win.webContents.emit('will-navigate', { preventDefault: () => undefined }, 'https://example.com/');

    expect(h.opened).toEqual(['https://example.com/']);
  });
});

describe('便携模式与显式资料目录', () => {
  /** 便携包只在 Windows 生效：这里把平台伪装成 win32，用临时目录当程序目录。 */
  async function bootPortable(switches: string[] = []): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-portable-'));
    tempDirs.push(dir);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await boot({ portableDir: dir, switches });
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    return dir;
  }

  it('便携包默认把资料目录切到程序目录', async () => {
    const dir = await bootPortable();
    expect(h.userData.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/'))).toBe(true);
  });

  it('用户显式给了 --user-data-dir 就不改写（尊重显式设置）', async () => {
    const dir = await bootPortable(['user-data-dir']);
    expect(h.userData.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/'))).toBe(false);
  });
});

describe('本地数据损坏时的启动行为', () => {
  it('读不出 data.json 会弹一次原生提示，说明「保存会失败」', async () => {
    await boot({ corruptData: true });
    expect(h.errorBoxes.some((text) => /data\.json/.test(text))).toBe(true);
  });

  it('数据正常时不弹任何错误框', async () => {
    await boot({ data: { settings: { root: '/downloads' } } });
    expect(h.errorBoxes).toEqual([]);
  });
});

describe('应用菜单', () => {
  it('装上标准编辑角色（没有菜单时 macOS 的 Cmd+C/V 不生效）', async () => {
    await boot();
    const roles = (h.menu ?? []).flatMap((item) =>
      Array.isArray(item?.submenu) ? item.submenu.map((entry: Record<string, unknown>) => entry?.role) : [],
    );
    for (const role of ['copy', 'paste', 'selectAll', 'undo', 'redo']) {
      expect(roles, role).toContain(role);
    }
  });
});
