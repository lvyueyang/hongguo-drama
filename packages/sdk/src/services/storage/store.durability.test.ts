/**
 * 本地持久化的「读失败冻结 / 原子写」等价用例（迁自 `scripts/check-store.cjs`）。
 *
 * `store.test.ts` 已覆盖首次启动、损坏 JSON 的基本冻结、写失败回滚与公告合并；
 * 这里补的是旧检查里更硬的几条不变量（重构 `src/store.js` → SDK 时最容易丢的）：
 * - 读失败的**所有**写入口都被冻结，且抛的是同一个错误对象、保留原始 cause；
 * - 非法文档形状（数组/标量/字段类型错）不能被静默丢弃；
 * - 中断（写 / fsync / rename 任一失败）时磁盘与内存都回到上次成功落盘的状态，且不泄漏 fd；
 * - 替换原文件之前，临时内容已 fsync 且句柄已关闭。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, READ_ERROR_MESSAGE } from './store.ts';

const dirs: string[] = [];

/** 建一个独立临时目录，返回目录与其中的 data.json 路径。 */
function tempDir(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-store-durable-'));
  dirs.push(dir);
  return { dir, file: path.join(dir, 'data.json') };
}

/** 五个写入口：任何一个在只读状态下放行都会覆盖用户数据。 */
function writeCalls(store: ReturnType<typeof createStore>): Array<() => void> {
  return [
    () => store.saveSettings({ theme: 'dark' }),
    () => store.saveTasks([{ id: 'pending' }]),
    () => store.saveSeries([{ series_id: 'new' }]),
    () => store.savePlayback({ new: { position: 10 } }),
    () => store.saveMergeTasks([{ id: 'new' }]),
  ];
}

function thrown(run: () => void): Error & { code?: string; cause?: unknown } {
  try {
    run();
  } catch (error) {
    return error as Error & { code?: string; cause?: unknown };
  }
  throw new Error('预期抛错，但没有抛');
}

function errorCode(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

/**
 * node:fs 上可替换的方法（store 直接调用这些方法，测试里换成受控实现）。
 * 类型只保留本文件需要的形状，避免 `typeof fs.readFileSync` 的重载签名。
 */
interface FsOverrides {
  readFileSync: (target: unknown, ...args: unknown[]) => string;
  writeFileSync: (target: unknown, data: unknown, options?: unknown) => void;
  fsyncSync: (fd: number) => void;
  renameSync: (source: unknown, destination: unknown) => void;
  openSync: (target: unknown, ...args: unknown[]) => number;
}

const mutableFs = fs as unknown as FsOverrides;

/** 临时替换 fs 方法；返回还原函数（用例必须在 finally 里还原）。 */
function patchFs(name: keyof FsOverrides, replacement: FsOverrides[keyof FsOverrides]): () => void {
  const original = mutableFs[name];
  (mutableFs as unknown as Record<string, unknown>)[name] = replacement;
  return () => {
    (mutableFs as unknown as Record<string, unknown>)[name] = original;
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('读取失败后进入只读冻结', () => {
  it('损坏 JSON：启动不崩、全部写入口抛同一个 STORE_READ_FAILED、原文件逐字节保留', () => {
    const { file } = tempDir();
    const original = '{"settings":{"theme":"light"},"tasks":[';
    fs.writeFileSync(file, original);
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);

    expect(() => store.init(file)).not.toThrow();
    expect(handler).toHaveBeenCalledWith({ error: READ_ERROR_MESSAGE });

    const first = thrown(() => store.saveSettings({ theme: 'dark' }));
    expect(first.code).toBe('STORE_READ_FAILED');
    expect(first.cause).toBeTruthy();
    for (const write of writeCalls(store)) {
      const failure = thrown(write);
      expect(failure.code).toBe('STORE_READ_FAILED');
      // 冻结期间始终是同一个错误：调用方拿到的原因不会变
      expect(failure).toBe(first);
      expect(fs.readFileSync(file, 'utf8'), '任何写都必须保留读不出来的原文').toBe(original);
    }

    expect(store.getSettings()).toEqual({});
    expect(store.getTasks()).toEqual([]);
    expect(store.getSeries()).toEqual([]);
    expect(store.getPlayback()).toEqual({});
    expect(store.getMergeTasks()).toEqual([]);
  });

  it('修好文件并显式重新初始化后恢复可写，且不会丢掉修好后的数据', () => {
    const { file } = tempDir();
    fs.writeFileSync(file, '{"tasks":');
    const store = createStore();
    store.init(file);
    expect(errorCode(() => store.saveTasks([]))).toBe('STORE_READ_FAILED');

    fs.writeFileSync(file, JSON.stringify({ settings: { theme: 'light' }, tasks: [{ id: 'recovered' }] }));
    // 只修文件不够：冻结状态要显式 init 才解除
    expect(errorCode(() => store.saveTasks([]))).toBe('STORE_READ_FAILED');

    store.init(file);
    store.savePlayback({ recovered: { position: 10 } });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.tasks.map((task: { id: string }) => task.id)).toEqual(['recovered']);
    expect(saved.playback).toEqual({ recovered: { position: 10 } });
  });

  it('读权限失败（EACCES）：启动不崩、写入冻结、错误里保留原始 cause', () => {
    const { file } = tempDir();
    const original = JSON.stringify({ settings: { theme: 'light' }, tasks: [{ id: 'saved' }] });
    fs.writeFileSync(file, original);
    const denied = Object.assign(new Error('simulated permission denied'), { code: 'EACCES' });

    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);
    const readFile = mutableFs.readFileSync;
    const restore = patchFs('readFileSync', (target: unknown, ...args: unknown[]) => {
      if (target === file) throw denied;
      return readFile(target, ...args);
    });
    try {
      expect(() => store.init(file)).not.toThrow();
    } finally {
      restore();
    }

    expect(handler).toHaveBeenCalledWith({ error: READ_ERROR_MESSAGE });
    for (const write of writeCalls(store)) {
      expect(thrown(write).code).toBe('STORE_READ_FAILED');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
    expect(thrown(() => store.saveSettings({})).cause).toBe(denied);
  });

  it('非法文档形状不能被静默丢弃：数组、标量、字段类型错都进入冻结', () => {
    const { file } = tempDir();
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);

    for (const invalid of [
      null,
      [],
      42,
      { tasks: {} },
      { settings: [] },
      { series: {} },
      { playback: [] },
      { mergeTasks: {} },
    ]) {
      const original = JSON.stringify(invalid);
      fs.writeFileSync(file, original);
      handler.mockClear();
      expect(() => store.init(file)).not.toThrow();
      expect(handler, original).toHaveBeenCalledWith({ error: READ_ERROR_MESSAGE });
      expect(thrown(() => store.saveTasks([])).code, original).toBe('STORE_READ_FAILED');
      expect(fs.readFileSync(file, 'utf8'), original).toBe(original);
    }
  });
});

describe('原子写与中断恢复', () => {
  it('文件不存在视为首次启动；保存保留未知字段，目录里不留临时文件', () => {
    const { dir, file } = tempDir();
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);

    store.init(file);
    store.saveTasks([{ id: 'complete' }]);
    store.saveSettings({ theme: 'light' });
    expect(handler).not.toHaveBeenCalled();

    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    document.futureField = { preserve: true };
    fs.writeFileSync(file, JSON.stringify(document));

    store.init(file);
    store.savePlayback({ complete: { position: 10 } });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.futureField).toEqual({ preserve: true });
    expect(saved.tasks.map((task: { id: string }) => task.id)).toEqual(['complete']);
    expect(fs.readdirSync(dir)).toEqual(['data.json']);
  });

  it('写、fsync、rename 任一中断：磁盘与内存停在上次成功落盘处，且不泄漏 fd', () => {
    const { dir, file } = tempDir();
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);
    store.init(file);
    store.saveSettings({ theme: 'light' });
    store.saveTasks([{ id: 'saved' }]);
    const before = fs.readFileSync(file, 'utf8');
    const openSync = mutableFs.openSync;
    const writeFileSync = mutableFs.writeFileSync;

    for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync'] as const) {
      const handles: number[] = [];
      const restoreOpen = patchFs('openSync', (target: unknown, ...args: unknown[]) => {
        const fd = openSync(target, ...args);
        if (String(target) === `${file}.tmp`) handles.push(fd);
        return fd;
      });
      const restoreOperation = patchFs(operation, () => {
        // 半截内容已经写进临时文件，随后磁盘满：原文件不能被这半截污染
        if (operation === 'writeFileSync') writeFileSync(`${file}.tmp`, '{');
        throw new Error('simulated disk full');
      });
      try {
        const pending = store.getTasks();
        pending[0] = { id: 'unsaved' };
        expect(() => store.saveTasks(pending)).toThrowError(/simulated disk full/);
      } finally {
        restoreOperation();
        restoreOpen();
      }

      // 临时文件的句柄必须已经关掉，否则长时间运行会耗尽 fd
      for (const fd of handles)
        expect(
          errorCode(() => fs.fstatSync(fd)),
          operation,
        ).toBe('EBADF');
      expect(fs.readFileSync(file, 'utf8'), operation).toBe(before);
      expect(store.getTasks()[0]?.id, operation).toBe('saved');
      expect(fs.readdirSync(dir), operation).toEqual(['data.json']);
    }

    // 每次写失败都要上报，界面才不会显示「没保存成功却像保存了」
    expect(handler).toHaveBeenCalledTimes(3);
    store.saveTasks([{ id: 'complete' }]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].id).toBe('complete');
  });

  it('替换原文件前，临时内容已 fsync 且句柄已关闭', () => {
    const { file } = tempDir();
    const store = createStore();
    store.init(file);
    store.saveTasks([{ id: 'saved' }]);
    const before = fs.readFileSync(file, 'utf8');
    const fsyncSync = mutableFs.fsyncSync;
    const renameSync = mutableFs.renameSync;

    let syncedFd: number | undefined;
    const restoreFsync = patchFs('fsyncSync', (fd: number) => {
      // fsync 时原文件还是旧内容，新内容只在临时文件里
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(JSON.parse(fs.readFileSync(`${file}.tmp`, 'utf8')).tasks[0].id).toBe('complete');
      fsyncSync(fd);
      syncedFd = fd;
    });
    const restoreRename = patchFs('renameSync', (source: unknown, destination: unknown) => {
      expect(syncedFd, '必须先 fsync 再替换').not.toBeUndefined();
      expect(
        errorCode(() => fs.fstatSync(syncedFd as number)),
        '替换前句柄应已关闭',
      ).toBe('EBADF');
      return renameSync(source, destination);
    });

    try {
      store.saveTasks([{ id: 'complete' }]);
    } finally {
      restoreRename();
      restoreFsync();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].id).toBe('complete');
  });
});
