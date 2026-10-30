/**
 * 本地文件播放的「能力地址」表：渲染层只拿到不可猜的 id，真实路径留在主进程。
 * 迁移自 4.5 `src/native/media-access.js`（破坏性重构 M4），补类型。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface MediaAccess {
  localUrl(file: string): string;
  resolveLocal(value: string): string | null;
  corsHeaders(request: {
    headers: { get(name: string): string | null };
    initiatorOrigin?: string;
  }): Record<string, string> | null;
  clear(): void;
}

export function createMediaAccess(devUrl?: string): MediaAccess {
  const files = new Map<string, string>();
  const ids = new Map<string, string>();
  const devOrigin = devUrl ? new URL(devUrl).origin : '';
  const allowed = (origin: string): boolean =>
    origin === 'null' || origin === 'file://' || (Boolean(devOrigin) && origin === devOrigin);

  return {
    localUrl(file) {
      const resolved = path.resolve(String(file));
      if (!ids.has(resolved)) {
        const id = randomUUID();
        ids.set(resolved, id);
        files.set(id, resolved);
      }
      return `hongguo-local://f/${ids.get(resolved)}`;
    },
    resolveLocal(value) {
      const url = new URL(value);
      if (url.hostname !== 'f' || url.search || url.hash) return null;
      return files.get(url.pathname.slice(1)) ?? null;
    },
    corsHeaders(request) {
      const origin = request.headers.get('origin');
      const initiator = request.initiatorOrigin;
      // 不透明来源不是身份标识：媒体地址始终用不可猜的 id 作为能力凭据。
      if (origin && !allowed(origin)) return null;
      if (initiator && !allowed(initiator)) return null;
      // 两者同时给出且不一致时拒绝；唯一例外是打包页面的 file:// 发起方与 'null' 来源。
      if (origin && initiator && origin !== initiator && !(origin === 'null' && initiator === 'file://')) {
        return null;
      }
      return {
        'Access-Control-Allow-Origin': origin ?? 'null',
        Vary: 'Origin',
        'Cache-Control': 'no-store',
      };
    },
    clear() {
      files.clear();
      ids.clear();
    },
  };
}
