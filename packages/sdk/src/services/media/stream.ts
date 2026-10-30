// SPDX-License-Identifier: MIT
/**
 * 播放会话：渲染层只拿到一个随机会话地址，真实 CDN 地址与解密后的内容都留在主进程。
 *
 * 迁移自 4.5 `main.js` 的 `registerStreamProtocol` + `onlineCache`/`onlineSessions`。
 * 三类来源三种供片方式，差别不是实现口味，是能力约束：
 * - **明文**：边下边给，Range 原样透传（拖动进度不能等整集下完）；
 * - **加密（CENC / spade_a）**：必须整集取回来解密后才能切 Range，否则偏移对不上；
 * - **HLS**：先按其清单落盘重封装成 mp4，再按文件供片。
 *
 * 两条不变量（check-media-recovery 守的就是这两条）：
 * - 同一会话内一旦开始供片，就不能中途换成另一份片源：播放器拿到的第 100 字节
 *   和第 200 字节必须来自同一份媒体，换片源只能让播放器重新连接（返回 502）；
 * - 只有「还没开始供片」时才允许换候选重试。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { deriveKey, markWebMediaFailure } from '../../providers/hongguo-web/player.ts';
import { decryptBufferInWorker, decryptContentKeyFile } from './decrypt.ts';
import { remuxHls } from './hls.ts';
import { type MediaTools, probeMedia, resolveMediaTools } from './tools.ts';
import {
  assertSourceEnabled,
  awaitMediaOperation,
  canceledError,
  type MediaOpener,
  mediaRange,
  mediaTransferError,
  type PlayInfo,
  pipeToFile,
  readToBuffer,
  requestMedia,
  withMediaRecovery,
} from './transfer.ts';

/** 会话留出的最大数量：播放器一次最多挂几个会话，超了淘汰最久未用的。 */
const DEFAULT_MAX_SESSIONS = 8;
/** 单集在线内容上限（与 4.5 的 ONLINE_MAX_BYTES 一致）。 */
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;

export interface MediaChunk {
  status: number;
  headers: Record<string, string>;
  /** 明文来源是流（边下边给）；内存/磁盘来源是 Buffer */
  body: Buffer | Readable;
}

export interface MediaSession {
  id: string;
  /** 供片；range 为原始 Range 头 */
  read(range?: string | null, options?: { method?: string }): Promise<MediaChunk>;
  /** 已完整拿到的内容（可写进播放缓存）；明文直播式来源返回 null */
  snapshot?(): Promise<Buffer | null>;
  dispose(): void;
}

export interface SessionRegistry {
  get(id: string): MediaSession | undefined;
  add(session: MediaSession): void;
  release(id: string): void;
  clear(): void;
  size(): number;
}

export interface MediaSessionHost {
  temporaryDir(): string;
  ffmpeg?(): { ffmpeg(): string | null; ffprobe(): string | null; supportsHttp: boolean } | null;
  logger?(): { warn(message: string, detail?: unknown): void };
}

export interface OpenSessionRequest {
  playInfo: PlayInfo;
  vid: string;
  seriesId?: string;
  host: MediaSessionHost;
  tools?: MediaTools;
  /** 解密 worker 路径（CENC 与 spade_a 都在 worker 里解密） */
  decryptWorkerPath?: string;
  maxBytes?: number;
  onProgress?(progress: { received: number; total: number; phase?: string }): void;
  /** 取源入口，默认走内置链路（测试注入用） */
  open?: MediaOpener;
}

export function createSessionRegistry(options: { max?: number } = {}): SessionRegistry {
  const max = Number(options.max) > 0 ? Number(options.max) : DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, MediaSession>();
  const evict = () => {
    while (sessions.size > max) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      const session = sessions.get(oldest);
      sessions.delete(oldest);
      session?.dispose();
    }
  };
  return {
    get(id) {
      const session = sessions.get(id);
      if (!session) return undefined;
      // 重新插入以刷新 LRU 顺序。
      sessions.delete(id);
      sessions.set(id, session);
      return session;
    },
    add(session) {
      sessions.set(session.id, session);
      evict();
    },
    release(id) {
      const session = sessions.get(id);
      sessions.delete(id);
      session?.dispose();
    },
    clear() {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
    size: () => sessions.size,
  };
}

function identityOf(playInfo: PlayInfo): string {
  return JSON.stringify([playInfo.url, playInfo.contentKey, playInfo.spadeA]);
}

const MEDIA_HEADERS = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };

/**
 * 删掉会话的临时目录/文件。
 *
 * 迁移自 4.5 `disposeOnlineDisk` 的经验：Windows 上还有读者没关掉时删除会 EBUSY/EPERM，
 * 直接抛异常会让 dispose 把调用方一起带崩（缓存淘汰、来源停用都会走这里）。
 * 因此失败不改抛，而是稍后重试几次；重试仍失败就放弃——临时目录留着比坏掉强。
 */
function removePathLater(target: string, attempt = 0): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch (error) {
    const code = String((error as { code?: string }).code ?? '');
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE'].includes(code)) return;
    if (attempt >= 5) return;
    const timer = setTimeout(() => removePathLater(target, attempt + 1), 50 * (attempt + 1));
    timer.unref?.();
  }
}

function fileChunk(file: string, range: string | null | undefined, method: string): MediaChunk {
  const size = fs.statSync(file).size;
  const parsed = mediaRange(range, size);
  if (parsed === false) {
    return {
      status: 416,
      headers: { ...MEDIA_HEADERS, 'Content-Range': `bytes */${size}` },
      body: Buffer.alloc(0),
    };
  }
  const { start, end } = parsed ?? { start: 0, end: size - 1 };
  const headers: Record<string, string> = {
    ...MEDIA_HEADERS,
    'Content-Length': String(end - start + 1),
    ...(parsed ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  };
  if (method === 'HEAD') return { status: parsed ? 206 : 200, headers, body: Buffer.alloc(0) };
  return {
    status: parsed ? 206 : 200,
    headers,
    body: fs.createReadStream(file, { start, end }) as unknown as Readable,
  };
}

function bufferChunk(buffer: Buffer, range: string | null | undefined, method: string): MediaChunk {
  const parsed = mediaRange(range, buffer.length);
  if (parsed === false) {
    return {
      status: 416,
      headers: { ...MEDIA_HEADERS, 'Content-Range': `bytes */${buffer.length}` },
      body: Buffer.alloc(0),
    };
  }
  const { start, end } = parsed ?? { start: 0, end: buffer.length - 1 };
  const headers: Record<string, string> = {
    ...MEDIA_HEADERS,
    'Content-Length': String(end - start + 1),
    ...(parsed ? { 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } : {}),
  };
  if (method === 'HEAD') return { status: parsed ? 206 : 200, headers, body: Buffer.alloc(0) };
  return { status: parsed ? 206 : 200, headers, body: buffer.subarray(start, end + 1) };
}

/** 会话内共享一次的加载：并发请求只有一次真正下载。 */
function createLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}

export function openBufferSession(
  request: { buffer: Buffer; vid: string; seriesId?: string },
  registry: SessionRegistry,
): MediaSession {
  const session: MediaSession = {
    id: crypto.randomUUID(),
    async read(range, options = {}) {
      return bufferChunk(request.buffer, range, String(options.method ?? 'GET').toUpperCase());
    },
    async snapshot() {
      return request.buffer;
    },
    dispose() {
      /* 内存内容随会话一起被回收 */
    },
  };
  registry.add(session);
  return session;
}

export async function openMediaSession(
  request: OpenSessionRequest,
  registry: SessionRegistry,
): Promise<MediaSession> {
  const { playInfo, vid, seriesId, host } = request;
  const tools = request.tools ?? resolveMediaTools(host);
  const maxBytes = Number(request.maxBytes) > 0 ? Number(request.maxBytes) : DEFAULT_MAX_BYTES;
  const encrypted = Boolean(playInfo.contentKey || playInfo.spadeA);
  const hls = playInfo.format === 'hls';
  const controller = new AbortController();
  const disposers: Array<() => void> = [];

  // 供片前先确认来源仍启用：自定义源可能在准备过程中被停用。
  const checkAccess = () => assertSourceEnabled(vid);

  async function fetchDecryptedBytes(temporaryDir: string): Promise<Buffer> {
    return withMediaRecovery(
      vid,
      seriesId,
      { playInfo, signal: controller.signal, open: request.open },
      async (candidate) => {
        checkAccess();
        if (!candidate.contentKey && !candidate.spadeA) {
          const response = await requestMedia(candidate, { signal: controller.signal });
          return readToBuffer(response, {
            signal: controller.signal,
            maxBytes,
            onProgress: (received, total) => request.onProgress?.({ received, total, phase: 'downloading' }),
          });
        }
        const response = await requestMedia(candidate, { signal: controller.signal });
        const encryptedPath = path.join(temporaryDir, 'encrypted.tmp');
        await pipeToFile(response, encryptedPath, {
          signal: controller.signal,
          onProgress: (received, total) => request.onProgress?.({ received, total, phase: 'downloading' }),
        });
        request.onProgress?.({ received: 0, total: 0, phase: 'decrypting' });
        if (candidate.spadeA) {
          const key = deriveKey(candidate.spadeA);
          if (!key) throw Object.assign(new Error('密钥派生失败'), { code: 'MEDIA_DECODE_ERROR' });
          const bytes = await decryptBufferInWorker(
            { buffer: fs.readFileSync(encryptedPath), key },
            { signal: controller.signal, workerPath: request.decryptWorkerPath },
          );
          removePathLater(encryptedPath);
          if (bytes.length > maxBytes)
            throw Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
          return bytes;
        }
        const decodedPath = path.join(temporaryDir, 'decoded.tmp');
        await decryptContentKeyFile(
          { input: encryptedPath, output: decodedPath, contentKey: String(candidate.contentKey) },
          { ffmpeg: tools.ffmpeg, signal: controller.signal },
        );
        if (fs.statSync(decodedPath).size > maxBytes)
          throw Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
        const bytes = await fs.promises.readFile(decodedPath);
        removePathLater(encryptedPath);
        removePathLater(decodedPath);
        return bytes;
      },
    );
  }

  function createBufferedSession(load: () => Promise<Buffer>, snapshotMode: 'bytes' | 'none'): MediaSession {
    const ensure = createLoader(load);
    const session: MediaSession = {
      id: crypto.randomUUID(),
      async read(range, options = {}) {
        const buffer = await ensure();
        return bufferChunk(buffer, range, String(options.method ?? 'GET').toUpperCase());
      },
      async snapshot() {
        if (snapshotMode === 'none') {
          await ensure();
          return null;
        }
        return ensure();
      },
      dispose() {
        for (const dispose of disposers) dispose();
      },
    };
    registry.add(session);
    return session;
  }

  if (hls) {
    const temporaryDir = fs.mkdtempSync(path.join(host.temporaryDir(), 'hongguo-hls-play-'));
    const output = path.join(temporaryDir, 'video.mp4');
    disposers.push(() => removePathLater(temporaryDir));
    // 只等「重封装 + 校验」完成，产物留在磁盘上按 Range 供片：
    // HLS 合集动辄几百 MB，读进内存等于把会话数 × 单集大小变成常驻占用。
    const prepare = async (): Promise<void> => {
      await withMediaRecovery(
        vid,
        seriesId,
        { playInfo, signal: controller.signal, open: request.open },
        async (candidate) => {
          checkAccess();
          await remuxHls({
            url: String(candidate.url),
            output,
            ffmpeg: tools.ffmpeg,
            signal: controller.signal,
            checkAccess,
            headers: {
              ...(candidate.userAgent ? { 'User-Agent': candidate.userAgent } : {}),
              ...(candidate.referer ? { Referer: candidate.referer } : {}),
            },
            onProgress: (received) => request.onProgress?.({ received, total: 0, phase: 'downloading' }),
          });
          // 重封装完必须验一次：FFmpeg 退出码为 0 但产物不可读的情况真实存在。
          const info = await probeMedia({ tools, file: output, signal: controller.signal });
          if (!info || !(info.duration > 0) || !(info.w > 0) || !(info.h > 0))
            throw Object.assign(new Error('HLS 产物缺少有效视频轨或时长，已放弃'), {
              code: 'MEDIA_DECODE_ERROR',
            });
          if (controller.signal.aborted) throw canceledError('已取消播放');
          return;
        },
      );
    };
    const session: MediaSession = {
      id: crypto.randomUUID(),
      async read(range, options = {}) {
        await prepare();
        return fileChunk(output, range, String(options.method ?? 'GET').toUpperCase());
      },
      async snapshot() {
        // HLS 产物留在磁盘上由 Range 供片，不进播放缓存内存。
        await prepare();
        return null;
      },
      dispose() {
        for (const dispose of disposers) dispose();
      },
    };
    registry.add(session);
    return session;
  }

  if (encrypted) {
    const temporaryDir = fs.mkdtempSync(path.join(host.temporaryDir(), 'hongguo-decrypt-'));
    disposers.push(() => removePathLater(temporaryDir));
    return createBufferedSession(() => fetchDecryptedBytes(temporaryDir), 'bytes');
  }

  // 明文：Range 透传，边下边给。
  let started = false;
  let identity: string | null = null;
  const session: MediaSession = {
    id: crypto.randomUUID(),
    async read(range, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase();
      checkAccess();
      return withMediaRecovery(
        vid,
        seriesId,
        { playInfo, signal: controller.signal, recover: !started, open: request.open },
        async (candidate) => {
          const current = identityOf(candidate);
          const checkIdentity = () => {
            if (started && identity !== current) throw new Error('片源已变化，请重新连接播放');
          };
          checkIdentity();
          const response = await requestMedia(candidate, {
            method: method === 'HEAD' ? 'HEAD' : 'GET',
            headers: range ? { Range: range } : {},
            signal: controller.signal,
            acceptStatus: [200, 206, 416],
          });
          checkIdentity();
          if (response.status === 416) {
            response.data.destroy();
            return {
              status: 416,
              headers: { ...MEDIA_HEADERS, 'Cache-Control': 'no-store' },
              body: Buffer.alloc(0),
            };
          }
          const headers: Record<string, string> = {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
          };
          // 头名统一成规范写法：上游（axios）给的是小写，交给 Response 之前先归一，
          // 免得同一套会话出现两种大小写（下游按名取头时才不会漏）。
          for (const [name, canonical] of [
            ['content-length', 'Content-Length'],
            ['content-range', 'Content-Range'],
            ['accept-ranges', 'Accept-Ranges'],
          ] as const) {
            const value = response.headers[name];
            if (value !== undefined && value !== null) headers[canonical] = String(value);
          }
          if (method === 'HEAD') {
            response.data.destroy();
            started = true;
            identity = current;
            return { status: response.status, headers, body: Buffer.alloc(0) };
          }
          response.data.once('error', () => {
            if (!controller.signal.aborted) {
              // 断流要记账：下次取源先换掉官网，而不是再试一次同样的坏 body。
              markWebMediaFailure(candidate);
            }
          });
          started = true;
          identity = current;
          return { status: response.status, headers, body: response.data };
        },
      );
    },
    dispose() {
      controller.abort();
      for (const dispose of disposers) dispose();
    },
  };
  registry.add(session);
  return session;
}

/** 只在测试里用：等一次媒体操作，超时按传输失败处理。 */
export { awaitMediaOperation, canceledError, mediaTransferError };
