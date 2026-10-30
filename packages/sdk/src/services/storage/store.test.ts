import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, READ_ERROR_MESSAGE } from './store.ts';

const dirs: string[] = [];

function tempFile(name = 'data.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-store-'));
  dirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('本地持久化（迁移自 4.5 src/store.js）', () => {
  it('原子写：落盘为可读 JSON，权限 0600，且不残留临时文件', () => {
    const file = tempFile();
    const store = createStore();
    store.init(file);
    store.saveSettings({ root: '/tmp/downloads', max_concurrent: 3 });

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings.root).toBe('/tmp/downloads');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('读取失败时冻结保存：回滚内存副本、上报错误、原文件不被覆盖', () => {
    const file = tempFile();
    fs.writeFileSync(file, '{ 这不是合法 JSON');
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);
    store.init(file);

    expect(handler).toHaveBeenCalledWith({ error: READ_ERROR_MESSAGE });
    expect(store.getSettings()).toEqual({});
    expect(() => store.saveSettings({ root: '/should/not/land' })).toThrowError(/读取本地数据失败/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 这不是合法 JSON');
  });

  it('文件不存在视为首次启动，不报错', () => {
    const store = createStore();
    const handler = vi.fn();
    store.setErrorHandler(handler);
    store.init(tempFile('missing.json'));

    expect(handler).not.toHaveBeenCalled();
    expect(store.getTasks()).toEqual([]);
    expect(store.getSeries()).toEqual([]);
    expect(store.getPlayback()).toEqual({});
  });

  it('写失败时回滚内存并上报，随后仍抛出原错误', () => {
    const file = tempFile();
    const store = createStore();
    store.init(file);
    store.saveSettings({ root: '/ok' });

    const original = fs.renameSync;
    const handler = vi.fn();
    store.setErrorHandler(handler);
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = () => {
      throw Object.assign(new Error('EACCES: 模拟磁盘失败'), { code: 'EACCES' });
    };
    try {
      expect(() => store.saveSettings({ root: '/bad' })).toThrowError(/EACCES/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = original;
    }
    expect(handler).toHaveBeenCalledWith({ error: expect.stringContaining('保存失败') });
    // 内存已回滚到上一次成功落盘的内容
    expect(store.getSettings().root).toBe('/ok');
  });

  it('公告状态合并而不是覆盖', () => {
    const file = tempFile();
    const store = createStore();
    store.init(file);
    store.saveAnnouncementState({ a: 1 });
    store.saveAnnouncementState({ b: 2 });
    expect(store.getAnnouncementState()).toEqual({ a: 1, b: 2 });
  });
});
