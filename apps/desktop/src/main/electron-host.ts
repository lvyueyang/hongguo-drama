/**
 * Electron 宿主实现：把 Electron API 收敛到 HostServices 接口。
 * 这是唯一允许 import 'electron' 的宿主层文件（SDK 与 SDK 服务都不碰 electron）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type AppInfo,
  type Clock,
  type FileSystem,
  type HostServices,
  type Logger,
  resolveToolPath,
  type SecretStore,
} from '@hongguo/host';
import { app, net, safeStorage, shell } from 'electron';

const fileSystem: FileSystem = {
  exists: (file) => fs.existsSync(file),
  readText: (file) => fs.readFileSync(file, 'utf8'),
  readBuffer: (file) => fs.readFileSync(file),
  writeText: (file, content, options) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: options?.mode ?? 0o600 });
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

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function createSecretStore(filePath: string): SecretStore {
  return {
    canEncrypt: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    save(blob) {
      if (!this.canEncrypt()) throw new Error('系统安全存储不可用，本次登录只保留到应用退出');
      const encrypted = safeStorage.encryptString(blob.toString('base64'));
      const temporary = `${filePath}.tmp`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, encrypted);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, filePath);
    },
    load() {
      if (!fs.existsSync(filePath)) return null;
      if (!this.canEncrypt()) return null;
      return Buffer.from(safeStorage.decryptString(fs.readFileSync(filePath)), 'base64');
    },
    clear() {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function createElectronHost(): HostServices {
  const secretPath = path.join(app.getPath('userData'), 'account-session.bin');
  return {
    app: (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform as AppInfo['platform'],
      architecture: process.arch,
    }),
    userDataDir: () => app.getPath('userData'),
    downloadsDir: () => app.getPath('downloads'),
    temporaryDir: () => app.getPath('temp'),
    logger: (): Logger => ({
      info: (message, detail) => console.log(`[info] ${message}`, detail ?? ''),
      warn: (message, detail) => console.warn(`[warn] ${message}`, detail ?? ''),
      error: (message, detail) => console.error(`[error] ${message}`, detail ?? ''),
    }),
    fs: () => fileSystem,
    clock: () => clock,
    secretStore: () => createSecretStore(secretPath),
    netTransport: () => net,
    ffmpeg: () => {
      // 路径发现逻辑在 @hongguo/host 的纯函数里（打包后只认随包二进制），这里只提供环境。
      const find = (name: string): string | null =>
        resolveToolPath({
          name,
          platform: process.platform as 'darwin' | 'win32' | 'linux',
          arch: process.arch,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath ?? null,
          cwd: process.cwd(),
          path: process.env.PATH ?? '',
          exists: (file) => {
            try {
              fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
              return true;
            } catch {
              return false;
            }
          },
        }).path;
      return { ffmpeg: () => find('ffmpeg'), ffprobe: () => find('ffprobe'), supportsHttp: false };
    },
    windows: undefined,
    openExternal: (url: string) => shell.openExternal(url),
  } as HostServices;
}
