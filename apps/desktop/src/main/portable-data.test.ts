/**
 * 便携版资料目录（迁移自 4.5 `scripts/check-portable-data.cjs`）。
 *
 * 不变量：非 Windows / 无变量 / 无标记 → 用系统目录；便携版只复制缺失资料、
 * 不动临时缓存；程序目录不可写或迁移未完成 → 回退并给出可见原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPortableDataDir, DATA_FILES, PORTABLE_MARKER, resolvePortableDataDir } from '@hongguo/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root = '';
let appData = '';
let portableDir = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-portable-'));
  appData = path.join(root, 'appdata');
  portableDir = path.join(root, 'portable');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(portableDir, { recursive: true });
  fs.writeFileSync(path.join(appData, 'data.json'), '{"settings":{"theme":"dark"}}');
  fs.writeFileSync(path.join(appData, 'danmaku-client.json'), '{"id":"device-1"}');
  fs.writeFileSync(path.join(appData, 'compat-cache'), 'not migrated');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// 注意：portableDir 在 beforeEach 里才赋值，这里必须是函数而不是模块级常量（否则捕获空串）。
const win = () => ({ env: { PORTABLE_EXECUTABLE_DIR: portableDir }, platform: 'win32' });

describe('便携资料目录解析', () => {
  it('非 Windows 保持系统目录', () => {
    const result = resolvePortableDataDir({ ...win(), platform: 'darwin', defaultUserData: appData });
    expect(result.mode).toBe('default');
    expect(result.dir).toBe(appData);
    expect(result.copied).toEqual([]);
  });

  it('没有便携变量时保持系统目录', () => {
    const result = resolvePortableDataDir({ env: {}, platform: 'win32', defaultUserData: appData });
    expect(result.mode).toBe('default');
    expect(result.dir).toBe(appData);
  });

  it('便携版只复制一次资料，且不搬临时缓存', () => {
    const first = resolvePortableDataDir({ ...win(), defaultUserData: appData });
    expect(first.mode).toBe('portable');
    expect(first.dir).toBe(path.join(portableDir, 'data'));
    expect(first.copied.slice().sort()).toEqual(DATA_FILES.slice().sort());
    expect(fs.readFileSync(path.join(first.dir, 'data.json'), 'utf8')).toBe('{"settings":{"theme":"dark"}}');
    expect(fs.existsSync(path.join(first.dir, 'compat-cache'))).toBe(false);

    // 第二次启动不再复制，也不覆盖程序目录里的新数据
    fs.writeFileSync(path.join(appData, 'data.json'), '{"settings":{"theme":"light"}}');
    const second = resolvePortableDataDir({ ...win(), defaultUserData: appData });
    expect(second.mode).toBe('portable');
    expect(second.copied).toEqual([]);
    expect(fs.readFileSync(path.join(second.dir, 'data.json'), 'utf8')).toBe('{"settings":{"theme":"dark"}}');
  });

  it('可执行文件旁的 portable.marker 也能选中程序目录', () => {
    const execDir = path.join(root, 'app');
    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(path.join(execDir, PORTABLE_MARKER), '');
    const result = resolvePortableDataDir({
      env: {},
      platform: 'win32',
      execPath: path.join(execDir, 'hongguo.exe'),
      defaultUserData: appData,
    });
    expect(result.mode).toBe('portable');
    expect(result.dir).toBe(path.join(execDir, 'data'));
    expect(fs.existsSync(path.join(result.dir, 'data.json'))).toBe(true);
  });

  it('程序目录不可写时回退系统目录并给出原因', () => {
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked, { recursive: true });
    fs.chmodSync(blocked, 0o500);
    const result = resolvePortableDataDir({
      env: { PORTABLE_EXECUTABLE_DIR: blocked },
      platform: 'win32',
      defaultUserData: appData,
    });
    fs.chmodSync(blocked, 0o700);
    expect(result.mode).toBe('default');
    expect(result.dir).toBe(appData);
    expect(result.reason).toMatch(/不可写/);
  });

  it('便携版会同时切换 userData 与 sessionData', () => {
    const paths: Record<string, string> = {};
    const app = {
      setPath(name: string, value: string): void {
        paths[name] = value;
      },
    };
    const result = applyPortableDataDir({ app, ...win(), defaultUserData: appData });
    expect(result.mode).toBe('portable');
    expect(paths.userData).toBe(path.join(portableDir, 'data'));
    expect(paths.sessionData).toBe(path.join(portableDir, 'data'));
  });
});
