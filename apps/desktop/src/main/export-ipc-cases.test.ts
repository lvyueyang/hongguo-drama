/**
 * 文字导出的装配层（迁移自 4.5 `src/native/text-export-integration.test.cjs`）。
 *
 * 旧文件用「vm 跑 main.js + 手写假 Electron」验的是导出**往哪儿写**：完成过的下载任务
 * 决定目录与文件名，渲染层传进来的路径必须被忽略，导出失败不能连带把别的流程弄挂。
 * 5.0 的主进程入口可以直接 import，这里用 `vi.mock('electron')` + 替身 SDK 把真实入口跑起来，
 * 只替换 `exportText.series` 这一层（否则会真的联网抓弹幕）。
 *
 * 5.0 与 4.5 的形态差异（不再是缺口，见报告）：4.5 是「提交下载后后台跑 + `text-export-done` 事件」，
 * 5.0 改成独立通道 `export:text`，同步返回统计；`export_text` 偏好也随界面一起消失，
 * 要导出哪几类由请求体 `kinds` 决定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Channels, type IpcResult } from '@hongguo/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tally = () => ({ ok: 0, fail: 0, skipped: 0, partial: 0, items: 0, empty: 0, unavailable: 0 });

const h = vi.hoisted(() => ({
  userData: '',
  windows: [] as any[],
  ipcHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  exportCalls: [] as any[],
  exportResult: null as unknown,
  exportError: null as Error | null,
}));

/** Electron 替身：只实现主进程入口真正用到的部分。 */
async function createElectronMock(): Promise<Record<string, unknown>> {
  const { EventEmitter } = await import('node:events');
  const nodePath = (await import('node:path')).default;
  const defaultSession = {
    setProxy: async () => undefined,
    cookies: { get: async () => [], remove: async () => undefined },
    clearStorageData: async () => undefined,
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
  };
  const app = new EventEmitter() as any;
  app.commandLine = { appendSwitch: () => undefined };
  app.getVersion = () => '5.0.0-test';
  app.getName = () => 'hongguo-drama';
  app.isPackaged = false;
  app.setPath = (_name: string) => undefined;
  app.setName = () => undefined;
  app.getPath = (name: string) => (name === 'userData' ? h.userData : nodePath.join(h.userData, name));
  app.requestSingleInstanceLock = () => true;
  app.quit = () => undefined;
  app.whenReady = () => Promise.resolve();

  class FakeBrowserWindow extends EventEmitter {
    static getAllWindows() {
      return h.windows.filter((entry) => !entry.destroyed);
    }
    destroyed = false;
    options: Record<string, unknown>;
    webContents: any;
    constructor(options: Record<string, unknown> = {}) {
      super();
      this.options = options;
      const contents = new EventEmitter() as any;
      contents.mainFrame = { url: 'file:///fixture/renderer/index.html' };
      contents.send = () => undefined;
      contents.setWindowOpenHandler = () => undefined;
      contents.session = defaultSession;
      contents.session.webRequest = { onBeforeSendHeaders: () => undefined };
      this.webContents = contents;
      h.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    loadFile() {
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    show() {}
    focus() {}
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        h.ipcHandlers.set(channel, listener);
      },
    },
    session: {
      defaultSession,
      fromPartition: () => ({ ...defaultSession, fetch: async () => new Response('') }),
    },
    net: { fetch: async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: () => '',
    },
    protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
    shell: { openExternal: async () => undefined },
  };
}

function createUpdaterMock(): Record<string, unknown> {
  return {
    autoUpdater: {
      setFeedURL: () => undefined,
      on: () => undefined,
      checkForUpdates: async () => ({ updateInfo: { version: '0.0.0' } }),
      downloadUpdate: async () => [],
      quitAndInstall: () => undefined,
    },
  };
}

/** 只替换 `exportText.series`：其余 SDK 走真实实现（设置与任务都来自真 store）。 */
async function createSdkMock(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import('@hongguo/sdk')>('@hongguo/sdk');
  return {
    ...actual,
    createSdk: (options: never) => {
      const sdk = actual.createSdk(options) as any;
      sdk.exportText = {
        series: async (input: unknown) => {
          h.exportCalls.push(input);
          if (h.exportError) throw h.exportError;
          return h.exportResult;
        },
      };
      return sdk;
    },
  };
}

const tempDirs: string[] = [];

async function boot(data?: unknown): Promise<void> {
  vi.resetModules();
  h.windows.length = 0;
  h.ipcHandlers.clear();
  h.exportCalls.length = 0;
  h.exportResult = { danmaku: tally(), comments: tally(), reviews: tally(), files: ['/tmp/x.danmaku.json'] };
  h.exportError = null;
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-ipc-'));
  tempDirs.push(h.userData);
  if (data !== undefined) fs.writeFileSync(path.join(h.userData, 'data.json'), JSON.stringify(data));
  vi.doMock('electron', createElectronMock);
  vi.doMock('electron-updater', createUpdaterMock);
  vi.doMock('@hongguo/sdk', createSdkMock);
  await import('./index.ts');
  // 等 whenReady().then(...) 里的注册跑完
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function callExport(input: unknown): Promise<IpcResult<any>> {
  const handler = h.ipcHandlers.get(Channels.exportText);
  if (!handler) throw new Error('导出通道没有注册');
  const win = h.windows[0];
  return (await handler(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    input,
  )) as IpcResult<any>;
}

const completedTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  vid: '7503780574541122622',
  seriesId: '7240000000000000001',
  seriesTitle: '测试剧',
  savePath: '',
  status: 'completed',
  progress: 100,
  receivedBytes: 1,
  totalBytes: 1,
  retries: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('导出目标：来自下载任务，不来自渲染层', () => {
  it('跟着已完成任务的路径走，设置根目录改了也不受影响', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-root-'));
    tempDirs.push(root);
    const oldFile = path.join(root, 'old', 'original-name.mp4');
    await boot({
      settings: { root: path.join(root, 'new'), name_format: '剧名 集数 标题' },
      tasks: [completedTask({ savePath: oldFile })],
    });
    const result = await callExport({
      seriesId: '7240000000000000001',
      seriesTitle: '测试剧',
      kinds: { danmaku: true },
    });
    expect(result.ok).toBe(true);
    expect(h.exportCalls).toHaveLength(1);
    const input = h.exportCalls[0];
    expect(input.episodes).toEqual([{ vid: '7503780574541122622', vid_index: 1, savePath: oldFile }]);
    expect(path.dirname(input.reviewsPath)).toBe(path.dirname(oldFile));
    expect(input.reviewsPath).not.toContain(path.join(root, 'new'));
    if (result.ok) expect(result.data.files).toEqual(['/tmp/x.danmaku.json']);
  });

  it('渲染层传来的目标路径被丢弃，只按任务实际路径导出', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-forged-'));
    tempDirs.push(root);
    const shared = path.join(root, 'collision.mp4');
    const tasks = ['7503780574541122622', '7503780574541122623'].map((vid, index) =>
      completedTask({ id: `task-${index}`, vid, savePath: shared, updatedAt: index }),
    );
    await boot({ settings: { root }, tasks });
    const result = await callExport({
      seriesId: '7240000000000000001',
      seriesTitle: '测试剧',
      kinds: { comments: true },
      // 4.5 的渲染层会带这些字段；5.0 的契约必须把它们挡在端口之外
      episodes: [{ vid: '7503780574541122622', vid_index: 1, savePath: '/outside/forged.mp4' }],
      savePath: '/outside/forged.mp4',
    });
    expect(result.ok).toBe(true);
    const input = h.exportCalls[0];
    expect(input.episodes).toHaveLength(2);
    for (const episode of input.episodes) {
      expect(episode.savePath).toBe(shared);
    }
    expect(JSON.stringify(input)).not.toMatch(/outside\/forged/);
  });

  it('按路径排序并重新编集号；没有已完成任务时退回设置根目录下的剧名目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-order-'));
    tempDirs.push(root);
    await boot({
      settings: { root },
      tasks: [
        completedTask({ id: 'b', vid: '2', savePath: path.join(root, 'series', '02.mp4') }),
        completedTask({ id: 'a', vid: '1', savePath: path.join(root, 'series', '01.mp4') }),
      ],
    });
    await callExport({ seriesId: '7240000000000000001', seriesTitle: '测试剧', kinds: { reviews: true } });
    expect(
      h.exportCalls[0].episodes.map((episode: any) => [episode.vid_index, path.basename(episode.savePath)]),
    ).toEqual([
      [1, '01.mp4'],
      [2, '02.mp4'],
    ]);

    await boot({ settings: { root } });
    const result = await callExport({
      seriesId: '7240000000000000001',
      seriesTitle: '测试剧',
      kinds: { reviews: true },
    });
    expect(result.ok).toBe(true);
    expect(h.exportCalls[0].episodes).toEqual([]);
    // 没有下载成品时只导出剧评到剧名目录，并把这个目录建出来
    const dir = path.join(root, '测试剧');
    expect(h.exportCalls[0].reviewsPath).toBe(path.join(dir, '剧评.json'));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('导出失败与参数：不能连累别的流程', () => {
  it('一类都没选时在端口层就被拒，且不调用 SDK', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-none-'));
    tempDirs.push(root);
    await boot({ settings: { root } });
    const result = await callExport({ seriesId: '7240000000000000001', kinds: {} });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/至少选择一种/);
    expect(h.exportCalls).toHaveLength(0);
  });

  it('导出抛错时如实返回失败原因，不静默成功', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-fail-'));
    tempDirs.push(root);
    await boot({ settings: { root } });
    h.exportError = new Error('export unavailable');
    const result = await callExport({
      seriesId: '7240000000000000001',
      seriesTitle: '测试剧',
      kinds: { danmaku: true },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/export unavailable/);
  });

  it('编号缺失或越界在契约层就被拒，不落到端口', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-export-invalid-'));
    tempDirs.push(root);
    await boot({ settings: { root } });
    for (const input of [
      { kinds: { danmaku: true } },
      { seriesId: '', kinds: { danmaku: true } },
      { seriesId: '1'.repeat(65), kinds: { danmaku: true } },
      { seriesId: 123, kinds: { danmaku: true } },
      { seriesId: '7240000000000000001', kinds: { danmaku: 'yes' } },
    ]) {
      const result = await callExport(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
    }
    expect(h.exportCalls).toHaveLength(0);
  });
});
