/**
 * 自定义协议：hongguo-stream（在线播放）与 hongguo-local（本地文件播放）。
 *
 * 迁移自 4.5 `main.js` 的 `registerStreamProtocol` / 本地协议段：
 * - 渲染层只拿到 `hongguo-stream://play/<sessionId>` 或 `hongguo-local://f/<capabilityId>`，
 *   真实 CDN 地址与磁盘路径都留在主进程；
 * - 会话与能力 id 都是随机 UUID，不可猜；
 * - 方法限制为 GET/HEAD，Range 由会话层处理。
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { MediaSession, SessionRegistry } from '@hongguo/sdk';
import { protocol } from 'electron';
import type { MediaAccess } from './media-access.ts';

export const STREAM_SCHEME = 'hongguo-stream';
export const LOCAL_SCHEME = 'hongguo-local';

function mediaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Cache-Control': 'no-store', ...extra };
}

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: STREAM_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
    },
    {
      scheme: LOCAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
    },
  ]);
}

export interface ProtocolDeps {
  sessions: SessionRegistry;
  mediaAccess: MediaAccess;
}

export function registerProtocols({ sessions, mediaAccess }: ProtocolDeps): void {
  protocol.handle(STREAM_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'play') return new Response('not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const session: MediaSession | undefined = sessions.get(url.pathname.replace(/^\/+/, ''));
    if (!session) return new Response('not ready', { status: 404 });
    try {
      const chunk = await session.read(request.headers.get('range') ?? undefined, {
        method: request.method,
      });
      if (request.method === 'HEAD') {
        return new Response(null, { status: chunk.status, headers: mediaHeaders(chunk.headers) });
      }
      // 明文片源是流（边下边给），加密/HLS 片源是内存或文件切片，两种都要能交给 Response。
      const body =
        chunk.body instanceof Readable
          ? (Readable.toWeb(chunk.body) as ReadableStream)
          : (Readable.toWeb(Readable.from([chunk.body])) as ReadableStream);
      return new Response(body, { status: chunk.status, headers: mediaHeaders(chunk.headers) });
    } catch (error) {
      const message = (error as Error).message || '读取片源失败';
      return new Response(message, { status: 502, headers: mediaHeaders({ 'Content-Type': 'text/plain' }) });
    }
  });

  protocol.handle(LOCAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'f') return new Response('not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const cors = mediaAccess.corsHeaders(request);
    if (!cors) return new Response('forbidden', { status: 403 });
    const file = mediaAccess.resolveLocal(request.url);
    if (!file) return new Response('not found', { status: 404 });
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return new Response('not found', { status: 404 });
    }
    const range = request.headers.get('range');
    const headers = mediaHeaders({ ...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    if (!range) {
      headers['Content-Length'] = String(size);
      const stream = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file));
      return new Response(stream as ReadableStream | null, { status: 200, headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: mediaHeaders(cors) });
    const [, rawStart, rawEnd] = match;
    const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
    const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(start) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: mediaHeaders({ ...cors, 'Content-Range': `bytes */${size}` }),
      });
    }
    headers['Content-Length'] = String(end - start + 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const stream =
      request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(stream as ReadableStream | null, { status: 206, headers });
  });
}
