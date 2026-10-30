/**
 * 内置工具路径发现（迁移自 4.5 `scripts/check-ffmpeg-resolution.cjs`）。
 *
 * 唯一的安全不变量：打包后只认随包二进制，绝不看 PATH 或工作目录。
 * 其余是开发便利（仓库里的 build/ffmpeg + PATH 兜底）。
 */
import { describe, expect, it } from 'vitest';
import { resolveToolPath } from './tools.ts';

/** 用一组「存在的文件」跑发现逻辑，不碰磁盘。 */
function lookup(options: {
  platform?: 'win32' | 'darwin' | 'linux';
  isPackaged?: boolean;
  resourcesPath?: string | null;
  cwd?: string;
  path?: string | null;
  present: string[];
  name?: string;
}) {
  const present = new Set(options.present);
  return resolveToolPath({
    name: options.name ?? 'ffmpeg',
    platform: options.platform ?? 'linux',
    arch: 'x64',
    isPackaged: options.isPackaged ?? false,
    resourcesPath: 'resourcesPath' in options ? options.resourcesPath : '/app/resources',
    cwd: options.cwd ?? '/repo',
    path: options.path ?? '',
    exists: (file) => present.has(file),
  });
}

describe('打包后', () => {
  it('只认随包二进制：不看 PATH、不看工作目录（否则会执行用户目录里的同名程序）', () => {
    const result = lookup({
      isPackaged: true,
      resourcesPath: '/app/resources',
      present: ['/somewhere/else/ffmpeg'],
      path: '/somewhere/else',
      cwd: '/repo',
    });
    expect(result.path).toBeNull();
    expect(result.searched).toEqual(['/app/resources/bin/ffmpeg']);
  });

  it('随包二进制存在时用它，且它是第一个候选', () => {
    const result = lookup({
      isPackaged: true,
      resourcesPath: '/app/resources',
      present: ['/app/resources/bin/ffmpeg', '/repo/build/ffmpeg/linux-x64/ffmpeg'],
    });
    expect(result.path).toBe('/app/resources/bin/ffmpeg');
  });

  it('打包后没有 resourcesPath 也不回退到别处', () => {
    const result = lookup({
      isPackaged: true,
      resourcesPath: null,
      present: ['/repo/build/ffmpeg/linux-x64/ffmpeg'],
    });
    expect(result.path).toBeNull();
    expect(result.searched).toEqual([]);
  });

  it('Windows 随包路径用 .exe 与反斜杠', () => {
    const result = lookup({
      platform: 'win32',
      isPackaged: true,
      resourcesPath: 'C:\\app\\resources',
      present: ['C:\\app\\resources\\bin\\ffmpeg.exe'],
    });
    expect(result.path).toBe('C:\\app\\resources\\bin\\ffmpeg.exe');
  });
});

describe('开发运行时', () => {
  it('仓库目录里的二进制优先，cwd 深浅两种都试（仓库根 / apps/desktop）', () => {
    const fromRepoRoot = '/repo/build/ffmpeg/linux-x64/ffmpeg';
    expect(lookup({ present: [fromRepoRoot], cwd: '/repo' }).path).toBe(fromRepoRoot);
    expect(lookup({ present: [fromRepoRoot], cwd: '/repo/apps/desktop' }).path).toBe(fromRepoRoot);
  });

  it('随包二进制仍然最先（开发时用真 resources 目录也一致）', () => {
    const result = lookup({
      present: ['/app/resources/bin/ffmpeg', '/repo/build/ffmpeg/linux-x64/ffmpeg'],
    });
    expect(result.path).toBe('/app/resources/bin/ffmpeg');
  });

  it('PATH 兜底可用；Windows 上带引号的目录也能识别', () => {
    expect(lookup({ present: ['/usr/bin/ffmpeg'], path: '/missing:/usr/bin' }).path).toBe('/usr/bin/ffmpeg');
    expect(
      lookup({
        platform: 'win32',
        present: ['C:\\tools with spaces\\ffmpeg.exe'],
        path: 'C:\\missing;"C:\\tools with spaces";C:\\other',
      }).path,
    ).toBe('C:\\tools with spaces\\ffmpeg.exe');
  });

  it('macOS/Linux 用不带扩展名的文件名', () => {
    expect(
      lookup({ platform: 'darwin', name: 'ffprobe', present: ['/repo/build/ffmpeg/darwin-x64/ffprobe'] })
        .path,
    ).toBe('/repo/build/ffmpeg/darwin-x64/ffprobe');
    // 只有 .exe 不算数（macOS 上不会去执行一个 Windows 文件名）
    expect(
      lookup({ platform: 'darwin', present: ['/repo/build/ffmpeg/darwin-x64/ffmpeg.exe'] }).path,
    ).toBeNull();
  });

  it('都没有时返回 null，并给出尝试过的候选（排障要看这个）', () => {
    const result = lookup({ present: [], path: '/p1:/p2' });
    expect(result.path).toBeNull();
    expect(result.searched).toEqual([
      '/app/resources/bin/ffmpeg',
      '/repo/build/ffmpeg/linux-x64/ffmpeg',
      // cwd 为仓库根时，「上一级」被规范化成 /build（真机上 cwd 是 apps/desktop，所以这条只在开发时有效）
      '/build/ffmpeg/linux-x64/ffmpeg',
      '/p1/ffmpeg',
      '/p2/ffmpeg',
    ]);
  });
});
