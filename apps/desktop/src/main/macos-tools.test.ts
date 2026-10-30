/**
 * 内置工具（ffmpeg / ffprobe）在 macOS 上的路径发现——**宿主侧接线**的运行时验证。
 *
 * 迁移自 4.5 `scripts/check-macos.cjs` 的前半段（Mac 打包/开发下的可执行文件发现、
 * 缺失与不可执行都算「没有工具」、PATH 兜底）。
 *
 * `packages/host/src/tools.test.ts` 已经把纯函数 `resolveToolPath` 的候选顺序钉住了
 * （包括 win32 的 `.exe` 与反斜杠，那些路径在 macOS 上无法落到真实文件）；
 * 这里补的是纯函数覆盖不到的部分：`electron-host` 真正交给它什么环境，
 * 以及 **可执行位（X_OK）** ——4.5 用注入的假 `accessSync` 模拟，这里用真实文件权限。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ElectronAppLike {
  getPath(name: string): string;
  getName(): string;
  getVersion(): string;
  readonly isPackaged: boolean;
}

const h = vi.hoisted(() => ({ isPackaged: false, userData: '' }));

vi.mock('electron', () => {
  const app: ElectronAppLike = {
    getPath: () => h.userData,
    getName: () => 'hongguo-drama',
    getVersion: () => '5.0.0-test',
    get isPackaged() {
      return h.isPackaged;
    },
  };
  return {
    app,
    net: {},
    safeStorage: {},
    shell: { openExternal: async () => undefined },
  };
});

const originalCwd = process.cwd();
const originalPath = process.env.PATH ?? '';
const tempDirs: string[] = [];
let root = '';

/** 造一个真正的可执行文件（带执行位）。 */
function executable(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

function setResourcesPath(dir: string | null): void {
  if (dir) Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true });
  else Reflect.deleteProperty(process, 'resourcesPath');
}

async function findTool(name: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  const { createElectronHost } = await import('./electron-host.ts');
  return createElectronHost().ffmpeg()?.[name]() ?? null;
}

// 这些路径是 POSIX 形态（Windows 上 mkdir 会让它们变成另一种路径），真机只有 macOS 走这段。
describe.skipIf(process.platform === 'win32')('macOS 工具发现（宿主接线）', () => {
  beforeEach(() => {
    // realpath：macOS 的 /var 是指向 /private/var 的软链，process.cwd() 返回的是后者
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-macos-tools-')));
    tempDirs.push(root);
    h.userData = path.join(root, 'user-data');
    h.isPackaged = false;
    process.env.PATH = '';
    setResourcesPath(null);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    setResourcesPath(null);
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('打包后认 Resources/bin 下的 macOS 文件名（不带 .exe）', async () => {
    h.isPackaged = true;
    setResourcesPath(path.join(root, 'Resources'));
    const ffmpeg = executable(path.join(root, 'Resources/bin/ffmpeg'));

    expect(await findTool('ffmpeg')).toBe(ffmpeg);
  });

  it('打包后 Resources 里没有工具就不去 PATH 或工作目录找（否则会执行用户目录里的同名程序）', async () => {
    h.isPackaged = true;
    setResourcesPath(path.join(root, 'Resources'));
    const fallbackDir = path.join(root, 'tools with spaces');
    executable(path.join(fallbackDir, 'ffmpeg'));
    executable(path.join(root, 'build/ffmpeg/darwin-arm64/ffmpeg'));
    process.env.PATH = fallbackDir;

    expect(await findTool('ffmpeg')).toBeNull();
  });

  it('打包后连 resourcesPath 都没有时也不猜别处', async () => {
    h.isPackaged = true;
    setResourcesPath(null);
    executable(path.join(root, 'build/ffmpeg/darwin-arm64/ffprobe'));

    expect(await findTool('ffprobe')).toBeNull();
  });

  it('开发运行时用仓库里的 build/ffmpeg/darwin-arm64（仓库根与 apps/desktop 两种 cwd）', async () => {
    const ffprobe = executable(path.join(root, 'build/ffmpeg/darwin-arm64/ffprobe'));

    expect(await findTool('ffprobe')).toBe(ffprobe);

    fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    process.chdir(path.join(root, 'apps/desktop'));
    expect(await findTool('ffprobe')).toBe(ffprobe);
  });

  it('缺少工具与「有文件但没有执行位」都报不可用', async () => {
    setResourcesPath(path.join(root, 'Resources'));
    expect(await findTool('ffmpeg')).toBeNull();

    h.isPackaged = true;
    const ffmpeg = executable(path.join(root, 'Resources/bin/ffmpeg'));
    fs.chmodSync(ffmpeg, 0o644);
    // macOS 上藏起可执行位就等于不能执行；这里不用假 accessSync，用真实权限
    expect(await findTool('ffmpeg')).toBeNull();

    fs.chmodSync(ffmpeg, 0o755);
    expect(await findTool('ffmpeg')).toBe(ffmpeg);
  });

  it('开发运行时的 PATH 兜底能找到带空格的目录里的工具', async () => {
    const dir = path.join(root, 'tools with spaces');
    const ffmpeg = executable(path.join(dir, 'ffmpeg'));
    process.env.PATH = `/missing:${dir}`;

    expect(await findTool('ffmpeg')).toBe(ffmpeg);
  });
});
