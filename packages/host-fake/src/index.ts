/**
 * host-fake：内存实现，供 L2 装配层测试注入。
 *
 * 支持可编程故障（磁盘失败、时钟停顿、安全存储不可用），这些在真实 Electron 里
 * 很难构造，是它比“启动真窗口”更适合覆盖启动/崩溃路径的原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppInfo, Clock, FileSystem, HostServices, Logger, SecretStore } from '@hongguo/host';

export interface FakeHostOptions {
  app?: Partial<AppInfo>;
  /** 模拟系统安全存储不可用（登录只保留到本次运行） */
  secretStoreAvailable?: boolean;
  /** 日志收集，默认静默 */
  collectLogs?: boolean;
  /** 注入到内存文件系统的初始内容 */
  files?: Record<string, string>;
}

export interface FakeHost extends HostServices {
  logs: Array<{ level: string; message: string; detail?: unknown }>;
  /** 已写入内存文件系统的内容（键为绝对路径） */
  fileContents(): Record<string, string>;
  /** 让接下来的 N 次写入抛错，用于覆盖写失败回滚路径 */
  failWrites(error: Error, times?: number): void;
  /** 记录 openExternal 打开的地址 */
  opened: string[];
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const logs: Array<{ level: string; message: string; detail?: unknown }> = [];
  const files = new Map<string, Buffer>(
    Object.entries(options.files ?? {}).map(([key, value]) => [key, Buffer.from(value, 'utf8')]),
  );
  const opened: string[] = [];
  let failWrites: { error: Error; remaining: number } | null = null;
  const secrets = new Map<string, Buffer>();
  const secretAvailable = options.secretStoreAvailable !== false;

  const note = (level: string) => (message: string, detail?: unknown) => {
    if (options.collectLogs !== false) logs.push({ level, message, detail });
  };
  const logger: Logger = { info: note('info'), warn: note('warn'), error: note('error') };

  const fsFacade: FileSystem = {
    exists: (file) => files.has(file),
    readText: (file) => {
      const buffer = files.get(file);
      if (!buffer) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return buffer.toString('utf8');
    },
    readBuffer: (file) => {
      const buffer = files.get(file);
      if (!buffer) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return buffer;
    },
    writeText: (file, content) => {
      if (failWrites && failWrites.remaining > 0) {
        failWrites.remaining -= 1;
        throw failWrites.error;
      }
      files.set(file, Buffer.from(content, 'utf8'));
    },
    remove: (file) => {
      files.delete(file);
    },
    ensureDir: () => {},
    list: (dir) =>
      [...files.keys()].filter((key) => path.dirname(key) === dir).map((key) => path.basename(key)),
    stat: (file) => {
      const buffer = files.get(file);
      if (!buffer) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return { size: buffer.length, mtimeMs: 0 };
    },
  };

  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };

  const secretStore: SecretStore = {
    canEncrypt: () => secretAvailable,
    save: (blob) => {
      if (!secretAvailable) throw new Error('系统安全存储不可用，本次登录只保留到应用退出');
      secrets.set('session', Buffer.from(blob));
    },
    load: () => (secretAvailable ? (secrets.get('session') ?? null) : null),
    clear: () => {
      secrets.clear();
    },
  };

  const root = path.join(os.tmpdir(), 'hongguo-fake-host');

  return {
    logs,
    opened,
    app: () => ({
      name: 'hongguo-drama',
      version: '5.0.0-test',
      platform: 'darwin' as const,
      architecture: 'arm64',
      ...options.app,
    }),
    userDataDir: () => path.join(root, 'userData'),
    downloadsDir: () => path.join(root, 'downloads'),
    temporaryDir: () => path.join(root, 'tmp'),
    logger: () => logger,
    fs: () => fsFacade,
    clock: () => clock,
    secretStore: () => secretStore,
    ffmpeg: () => null,
    fileContents: () => Object.fromEntries([...files].map(([key, value]) => [key, value.toString('utf8')])),
    failWrites: (error, times = 1) => {
      failWrites = { error, remaining: times };
    },
  };
}

/** 真实文件系统的直通实现，供需要落盘的测试使用。 */
export function realFileSystem(): FileSystem {
  return {
    exists: (file) => fs.existsSync(file),
    readText: (file) => fs.readFileSync(file, 'utf8'),
    readBuffer: (file) => fs.readFileSync(file),
    writeText: (file, content, opts) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: opts?.mode ?? 0o600 });
    },
    remove: (file) => {
      fs.rmSync(file, { force: true });
    },
    ensureDir: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    stat: (file) => {
      const info = fs.statSync(file);
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
  };
}
