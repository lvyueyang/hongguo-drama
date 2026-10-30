// SPDX-License-Identifier: MIT
/**
 * 分集播放缓存：把已解密的整集内容放到磁盘，重开同一集不必再取流和解密。
 *
 * 迁移自 4.5 `main.js` 的 `onlineCache`（内存 Map + LRU 淘汰），差别是落在磁盘上：
 * 4.5 用内存缓存，进程重启就没了，而且大文件一直占着内存；文件形式让同一份内容
 * 既能被播放会话复用，也能被下载任务复用。
 *
 * 三条不变量（都是踩出来的）：
 * - 只有 `complete` 的条目能被复用（半截文件比没有更糟）；
 * - 复用前必须比对 vid/来源/剧集与片源指纹 —— 同一集换片源后旧内容不能再用；
 * - 淘汰绝不删正在被读的条目，且至少留一条（否则淘汰会变成「刚存进去就没了」）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 单集缓存预算（与 4.5 的 ONLINE_MAX_BYTES 一致）。 */
export const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;

export interface EpisodeCacheEntry {
  key: string;
  vid: string;
  seriesId: string;
  source: string;
  quality: string;
  mediaIdentity: string;
  bytes: number;
  complete: boolean;
  buffer?: Buffer;
  filePath?: string;
  /** 最近使用序号（单调递增）：用序号而不是墙钟，同一毫秒内连续存取也能排出确定顺序 */
  lastUsed: number;
}

export interface EpisodeCacheHandle {
  key: string;
  size: number;
  complete: boolean;
  read(): Promise<Buffer>;
  release(): void;
}

export interface EpisodeCacheStoreInput {
  key: string;
  vid: string;
  seriesId?: string;
  source?: string;
  quality?: string;
  mediaIdentity?: string;
  bytes?: number;
  complete?: boolean;
  buffer: Buffer;
}

export interface EpisodeCacheLookupInput {
  key: string;
  vid?: string;
  seriesId?: string;
  source?: string;
  /** 片源指纹：URL/密钥变了就不能复用 */
  mediaIdentity?: string;
}

export interface EpisodeCacheStatus {
  dir: string;
  count: number;
  bytes: number;
}

export interface EpisodeCache {
  /** 缓存键：auto 只按 vid，指定清晰度按 vid+清晰度（同一集不同清晰度是两份内容） */
  key(vid: string, quality?: string): string;
  lookup(input: EpisodeCacheLookupInput): EpisodeCacheHandle | null;
  store(input: EpisodeCacheStoreInput): EpisodeCacheHandle;
  clear(): void;
  status(): EpisodeCacheStatus;
}

/** 原子落盘：先写临时文件再改名，避免半截文件被当成完整缓存。 */
export function writeCacheFile(file: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function fileNameFor(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `${safe}-${hash}.mp4`;
}

export interface EpisodeCacheOptions {
  /** 缓存目录（宿主给，通常在 userData 下） */
  cacheDir: string;
  /** 预算字节数，默认 DEFAULT_MAX_BYTES */
  maxBytes?: number;
}

export function createEpisodeCache(options: EpisodeCacheOptions): EpisodeCache {
  const cacheDir = options.cacheDir;
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const entries = new Map<string, EpisodeCacheEntry>();
  const readers = new Map<string, number>();
  let useTick = 0;
  const stamp = (): number => (useTick += 1);

  const hold = (key: string): void => {
    readers.set(key, (readers.get(key) ?? 0) + 1);
  };
  const drop = (key: string): void => {
    const left = (readers.get(key) ?? 1) - 1;
    if (left > 0) readers.set(key, left);
    else readers.delete(key);
  };

  function removeFile(entry: EpisodeCacheEntry | undefined): void {
    if (!entry?.filePath) return;
    try {
      fs.rmSync(entry.filePath, { force: true });
    } catch {
      /* 已经不在磁盘上 */
    }
  }

  function removeEntry(key: string): void {
    const entry = entries.get(key);
    entries.delete(key);
    removeFile(entry);
  }

  function trim(): void {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    while (total > maxBytes && entries.size > 1) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        // 正在被读的条目不能淘汰：调用方手里还握着它的文件路径。
        if ((readers.get(key) ?? 0) > 0) continue;
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      total -= entries.get(oldestKey)?.bytes ?? 0;
      removeEntry(oldestKey);
    }
  }

  function handleFor(entry: EpisodeCacheEntry): EpisodeCacheHandle {
    return {
      key: entry.key,
      size: entry.bytes,
      complete: entry.complete,
      async read() {
        if (entry.buffer) return entry.buffer;
        if (!entry.filePath) throw Object.assign(new Error('缓存条目没有内容'), { code: 'MEDIA_INCOMPLETE' });
        try {
          return await fs.promises.readFile(entry.filePath);
        } catch (error) {
          // 文件被外部删了：条目立即失效，调用方按「缓存未命中」处理。
          removeEntry(entry.key);
          throw Object.assign(new Error('缓存文件已被移除'), { code: 'MEDIA_INCOMPLETE', cause: error });
        }
      },
      release() {
        drop(entry.key);
        trim();
      },
    };
  }

  return {
    key: (vid, quality = 'auto') => (!quality || quality === 'auto' ? String(vid) : `${vid}:${quality}`),

    lookup(input) {
      const entry = entries.get(input.key);
      if (!entry) return null;
      if (!entry.complete) return null;
      if (input.vid !== undefined && entry.vid !== String(input.vid)) return null;
      if (input.seriesId !== undefined && entry.seriesId !== String(input.seriesId ?? '')) return null;
      if (input.source !== undefined && entry.source !== String(input.source ?? '')) return null;
      if (input.mediaIdentity !== undefined && entry.mediaIdentity !== String(input.mediaIdentity ?? ''))
        return null;
      if (!(entry.bytes > 0)) return null;
      if (!entry.buffer && entry.filePath && !fs.existsSync(entry.filePath)) {
        removeEntry(entry.key);
        return null;
      }
      entry.lastUsed = stamp();
      hold(entry.key);
      return handleFor(entry);
    },

    store(input) {
      const buffer = input.buffer;
      const filePath = path.join(cacheDir, fileNameFor(input.key));
      // 大对象不进内存：磁盘是唯一副本，read() 直接读文件。
      writeCacheFile(filePath, buffer);
      const entry: EpisodeCacheEntry = {
        key: input.key,
        vid: String(input.vid),
        seriesId: String(input.seriesId ?? ''),
        source: String(input.source ?? ''),
        quality: String(input.quality ?? 'auto'),
        mediaIdentity: String(input.mediaIdentity ?? ''),
        bytes: Number(input.bytes) > 0 ? Number(input.bytes) : buffer.length,
        complete: input.complete !== false,
        filePath,
        lastUsed: stamp(),
      };
      removeFile(entries.get(input.key));
      entries.set(input.key, entry);
      hold(input.key);
      trim();
      return handleFor(entry);
    },

    clear() {
      for (const key of [...entries.keys()]) removeEntry(key);
      // 目录里可能还有上次进程留下的文件（条目表是内存态）。
      try {
        for (const name of fs.readdirSync(cacheDir)) {
          if (!name.endsWith('.mp4') && !name.endsWith('.tmp')) continue;
          fs.rmSync(path.join(cacheDir, name), { force: true });
        }
      } catch {
        /* 目录不存在 */
      }
    },

    status() {
      let bytes = 0;
      for (const entry of entries.values()) bytes += entry.bytes;
      return { dir: cacheDir, count: entries.size, bytes };
    },
  };
}
