/**
 * 内置工具（ffmpeg / ffprobe）的路径发现。
 *
 * 迁移自 4.5 `main.js` 的 `resolveFfmpeg`。规则只有一条是安全相关的：
 * **打包后只认随包二进制**，不看 PATH、不看当前工作目录——否则应用会执行
 * 用户目录里恰好同名的任意程序。开发运行时才额外找 PATH，方便本地装了 ffmpeg 的人。
 *
 * 抽成纯函数是因为它很容易被改坏，而真实 Electron 里没法构造这些路径组合。
 */
import path from 'node:path';
import type { Platform } from './index.ts';

export interface ToolLookupOptions {
  /** 'ffmpeg' | 'ffprobe' */
  name: string;
  platform: Platform;
  arch: string;
  isPackaged: boolean;
  /** 打包后的 resources 目录（app.isPackaged 时才有意义） */
  resourcesPath?: string | null;
  /** 当前工作目录 */
  cwd: string;
  /** PATH 环境变量（开发运行时才会用到） */
  path?: string | null;
  /** PATH 分隔符；默认按平台推导 */
  pathDelimiter?: string;
  /** 判断文件是否可执行（注入以便测试） */
  exists(file: string): boolean;
}

export interface ToolLookupResult {
  path: string | null;
  /** 依次尝试过的候选，便于排障时打印 */
  searched: string[];
}

/** Windows 的 PATH 里目录可能被引号包着（`"C:\Program Files\ffmpeg\bin"`）。 */
function barePathEntry(entry: string, platform: Platform): string {
  if (platform !== 'win32') return entry;
  return entry.replace(/^"(.*)"$/, '$1');
}

export function resolveToolPath(options: ToolLookupOptions): ToolLookupResult {
  const { name, platform, arch, isPackaged, cwd } = options;
  const executable = platform === 'win32' ? `${name}.exe` : name;
  // 按目标平台拼路径：Windows 用反斜杠且要处理盘符，不能拿本机的分隔符凑。
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const searched: string[] = [];

  const candidates: string[] = [];
  if (options.resourcesPath) candidates.push(join(options.resourcesPath, 'bin', executable));
  if (!isPackaged) {
    // 开发运行时：仓库里的 build/ffmpeg/<platform>-<arch>；
    // cwd 可能是仓库根，也可能是 apps/desktop，两种相对深度都试。
    candidates.push(join(cwd, 'build', 'ffmpeg', `${platform}-${arch}`, executable));
    candidates.push(join(cwd, '..', '..', 'build', 'ffmpeg', `${platform}-${arch}`, executable));
    const delimiter = options.pathDelimiter ?? (platform === 'win32' ? ';' : ':');
    for (const entry of String(options.path ?? '').split(delimiter)) {
      const bare = barePathEntry(entry.trim(), platform);
      if (bare) candidates.push(join(bare, executable));
    }
  }

  for (const candidate of candidates) {
    searched.push(candidate);
    if (options.exists(candidate)) return { path: candidate, searched };
  }
  return { path: null, searched };
}
