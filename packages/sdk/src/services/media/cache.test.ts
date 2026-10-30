/**
 * 分集播放缓存（替代 4.5 的内存 onlineCache）。
 * 三条不变量：半截条目不复用、片源指纹变了不复用、淘汰不删正在读的条目且至少留一条。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEpisodeCache, DEFAULT_MAX_BYTES, writeCacheFile } from './cache.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-cache-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: '11',
    vid: '11',
    seriesId: '1',
    source: 'hongguo',
    quality: 'auto',
    mediaIdentity: JSON.stringify(['https://cdn/video.mp4', null, null]),
    buffer: Buffer.from('decrypted-media'),
    ...overrides,
  };
}

describe('缓存键', () => {
  it('auto 只按 vid，指定清晰度分开存（同一集不同清晰度是两份内容）', () => {
    const cache = createEpisodeCache({ cacheDir: tempDir() });
    expect(cache.key('11')).toBe('11');
    expect(cache.key('11', 'auto')).toBe('11');
    expect(cache.key('11', '1080p')).toBe('11:1080p');
  });
});

describe('存取', () => {
  it('存进去能读回同样的字节，并落到磁盘上', async () => {
    const dir = tempDir();
    const cache = createEpisodeCache({ cacheDir: dir });
    const handle = cache.store(entry());
    handle.release();
    const cached = cache.lookup({ key: '11' })!;
    expect(cached.size).toBe('decrypted-media'.length);
    expect((await cached.read()).toString()).toBe('decrypted-media');
    cached.release();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.mp4'))).toHaveLength(1);
  });

  it('片源指纹/剧集/来源/vid 不同一律不复用', () => {
    const cache = createEpisodeCache({ cacheDir: tempDir() });
    cache.store(entry()).release();
    const identity = entry().mediaIdentity;
    expect(cache.lookup({ key: '11', vid: 'other' })).toBeNull();
    expect(cache.lookup({ key: '11', seriesId: 'other' })).toBeNull();
    expect(cache.lookup({ key: '11', source: 'hema' })).toBeNull();
    expect(cache.lookup({ key: '11', mediaIdentity: JSON.stringify(['https://cdn/other.mp4']) })).toBeNull();
    // 对齐的查询才命中
    expect(
      cache.lookup({ key: '11', vid: '11', seriesId: '1', source: 'hongguo', mediaIdentity: identity }),
    ).not.toBeNull();
  });

  it('未完成（complete=false）的条目不参与复用', () => {
    const cache = createEpisodeCache({ cacheDir: tempDir() });
    cache.store(entry({ complete: false })).release();
    expect(cache.lookup({ key: '11' })).toBeNull();
  });

  it('文件被外部删掉后条目立即失效，不会读到半个文件', async () => {
    const dir = tempDir();
    const cache = createEpisodeCache({ cacheDir: dir });
    cache.store(entry()).release();
    const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith('.mp4'))!);
    fs.rmSync(file);
    const c1 = createEpisodeCache({ cacheDir: dir });
    expect(c1.lookup({ key: '11' })).toBeNull();
    const cached = cache.lookup({ key: '11' });
    if (cached) {
      await expect(cached.read()).rejects.toMatchObject({ code: 'MEDIA_INCOMPLETE' });
      cached.release();
      expect(cache.lookup({ key: '11' })).toBeNull();
    }
  });
});

describe('淘汰', () => {
  it('超预算按最近使用淘汰，且至少留一条', () => {
    const dir = tempDir();
    const cache = createEpisodeCache({ cacheDir: dir, maxBytes: 1000 });
    cache.store(entry({ key: 'a', buffer: Buffer.alloc(400, 1) })).release();
    cache.store(entry({ key: 'b', buffer: Buffer.alloc(400, 2) })).release();
    cache.store(entry({ key: 'c', buffer: Buffer.alloc(400, 3) })).release();
    // 1200 > 1000：淘汰最久未用的 a，b/c 留着
    expect(cache.lookup({ key: 'a' })).toBeNull();
    expect(cache.lookup({ key: 'b' })).not.toBeNull();
    expect(cache.lookup({ key: 'c' })).not.toBeNull();
    expect(cache.status().count).toBe(2);
    // 淘汰过的文件不能留在磁盘上
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.mp4'))).toHaveLength(2);
  });

  it('读取会刷新 lastUsed，被淘汰的是另一条', () => {
    const cache = createEpisodeCache({ cacheDir: tempDir(), maxBytes: 1000 });
    cache.store(entry({ key: 'a', buffer: Buffer.alloc(400) })).release();
    cache.store(entry({ key: 'b', buffer: Buffer.alloc(400) })).release();
    // a 刚被读过 → b 变成最久未用
    cache.lookup({ key: 'a' })?.release();
    cache.store(entry({ key: 'c', buffer: Buffer.alloc(400) })).release();
    expect(cache.lookup({ key: 'a' })).not.toBeNull();
    expect(cache.lookup({ key: 'b' })).toBeNull();
  });

  it('正在被读的条目不会被淘汰，内容仍交回调用方', async () => {
    const dir = tempDir();
    const cache = createEpisodeCache({ cacheDir: dir, maxBytes: 900 });
    cache.store(entry({ key: 'pinned', buffer: Buffer.alloc(600, 7) })).release();
    const pinned = cache.lookup({ key: 'pinned' })!;
    // 读之前再塞两条，刚好超预算；pinned 被持有中，只能淘汰别人
    cache.store(entry({ key: 'x', buffer: Buffer.alloc(400) })).release();
    cache.store(entry({ key: 'y', buffer: Buffer.alloc(400) })).release();
    const bytes = await pinned.read();
    expect(bytes.length).toBe(600);
    pinned.release();
    expect(cache.status().count).toBeGreaterThanOrEqual(1);
  });

  it('clear 会连磁盘文件一起清掉', () => {
    const dir = tempDir();
    const cache = createEpisodeCache({ cacheDir: dir });
    cache.store(entry()).release();
    cache.clear();
    expect(cache.status().count).toBe(0);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.mp4'))).toHaveLength(0);
  });

  it('默认预算与 4.5 的在线缓存一致', () => {
    expect(DEFAULT_MAX_BYTES).toBe(300 * 1024 * 1024);
  });
});

describe('writeCacheFile', () => {
  it('先写临时文件再改名：失败不会留下半截正式文件', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'a.mp4');
    writeCacheFile(file, Buffer.from('ok'));
    expect(fs.readFileSync(file).toString()).toBe('ok');
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
