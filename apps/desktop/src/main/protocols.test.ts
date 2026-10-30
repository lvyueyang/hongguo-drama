/**
 * 自定义协议供片（迁移自 4.5 `scripts/check-streaming.cjs` 的协议段）：
 * `hongguo-stream://play/<sessionId>` 与 `hongguo-local://f/<capabilityId>`。
 *
 * 这两条通道是「渲染层看不到真实 CDN 地址与磁盘路径」的实现，必须守住：
 * - 会话/能力 id 不可猜、找不到就 404，方法只允许 GET/HEAD；
 * - Range 原样交给会话（明文透传上游、加密/文件按整段切片），非法或不满足回 416 并给 `bytes *\/<size>`；
 * - 本地文件读取前先过来源校验，跨来源一律 403；
 * - 会话出错要给播放器一个可诊断的 502，而不是空响应。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { handlers, privileges } = vi.hoisted(() => ({
  handlers: {} as Record<string, (request: Request) => Promise<Response>>,
  privileges: [] as unknown[],
}));

vi.mock('electron', () => ({
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      handlers[scheme] = handler;
    },
    registerSchemesAsPrivileged: (value: unknown[]) => {
      privileges.push(...value);
    },
  },
}));

const { createSessionRegistry, openBufferSession } = await import('@hongguo/sdk');
const { createMediaAccess } = await import('./media-access.ts');
const { LOCAL_SCHEME, registerProtocols, registerSchemes, STREAM_SCHEME } = await import('./protocols.ts');

const MEDIA = Buffer.from('0123456789');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-protocols-'));

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mount() {
  const sessions = createSessionRegistry();
  const mediaAccess = createMediaAccess();
  registerProtocols({ sessions, mediaAccess });
  return { sessions, mediaAccess, stream: handlers[STREAM_SCHEME], local: handlers[LOCAL_SCHEME] };
}

describe('hongguo-stream（在线供片）', () => {
  it('只认 play/<sessionId>：未知会话或别的主机名一律 404，非 GET/HEAD 一律 405', async () => {
    registerSchemes();
    expect(privileges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scheme: STREAM_SCHEME }),
        expect.objectContaining({ scheme: LOCAL_SCHEME }),
      ]),
    );

    const { stream, sessions } = mount();
    expect((await stream(new Request('hongguo-stream://play/unknown'))).status).toBe(404);
    expect((await stream(new Request('hongguo-stream://other/x'))).status).toBe(404);
    expect((await stream(new Request('hongguo-stream://play/unknown', { method: 'POST' }))).status).toBe(405);

    const session = openBufferSession({ buffer: MEDIA, vid: '11' }, sessions);
    expect((await stream(new Request(`hongguo-stream://play/${session.id}`))).status).toBe(200);
  });

  it('Range 原样交给会话，且响应不缓存（同一个地址随时可能换片源）', async () => {
    const { stream, sessions } = mount();
    const session = openBufferSession({ buffer: MEDIA, vid: '11' }, sessions);
    const url = `hongguo-stream://play/${session.id}`;

    const ranged = await stream(new Request(url, { headers: { range: 'bytes=2-4' } }));
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('234');
    expect(ranged.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(ranged.headers.get('content-length')).toBe('3');
    expect(ranged.headers.get('cache-control')).toBe('no-store');

    const full = await stream(new Request(url));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('0123456789');
  });

  it('HEAD 只回头与状态，不给 body（播放器探测大小）', async () => {
    const { stream, sessions } = mount();
    const session = openBufferSession({ buffer: MEDIA, vid: '11' }, sessions);
    const response = await stream(
      new Request(`hongguo-stream://play/${session.id}`, { method: 'HEAD', headers: { range: 'bytes=2-4' } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe('3');
    expect(await response.text()).toBe('');
  });

  it('会话出错时给 502 与可读原因，不返回空响应假装成功', async () => {
    const { stream, sessions } = mount();
    const failing = {
      id: 'failing-session',
      read: async () => {
        throw new Error('片源已变化，请重新连接播放');
      },
      dispose: () => {},
    };
    sessions.add(failing as never);
    const response = await stream(new Request('hongguo-stream://play/failing-session'));
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/片源已变化/);
  });
});

describe('hongguo-local（本地文件供片）', () => {
  it('后缀 Range 与越界 Range：按文件大小切分，越界回 416 带总长度', async () => {
    const { local, mediaAccess } = mount();
    const file = path.join(dir, 'local-range.mp4');
    fs.writeFileSync(file, MEDIA);
    const url = mediaAccess.localUrl(file);

    const full = await local(new Request(url));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('10');
    expect(await full.text()).toBe('0123456789');

    const suffix = await local(new Request(url, { headers: { range: 'bytes=-3' } }));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await suffix.text()).toBe('789');

    for (const range of ['bytes=12-20', 'bytes=5-2', 'bytes=0-2,4-6', 'junk']) {
      const invalid = await local(new Request(url, { headers: { range } }));
      expect(invalid.status, range).toBe(416);
      // 能解析但满足不了的范围必须给出总长度；解析不了的只回 416（与 4.5 的差异，见迁移报告）
      if (/^bytes=\d+-\d+$/.test(range)) {
        expect(invalid.headers.get('content-range'), range).toBe('bytes */10');
      } else {
        expect(invalid.headers.get('content-range'), range).toBeNull();
      }
    }
  });

  it('HEAD 只回头；未知能力 id 与跨来源请求分别 404 与 403', async () => {
    const { local, mediaAccess } = mount();
    const file = path.join(dir, 'head.mp4');
    fs.writeFileSync(file, MEDIA);
    const url = mediaAccess.localUrl(file);

    const head = await local(new Request(url, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');

    expect((await local(new Request('hongguo-local://f/not-a-capability'))).status).toBe(404);
    // 能力 id 是唯一凭据：任何其它来源都不许拿它当跳板
    const foreign = await local(new Request(url, { headers: { origin: 'https://evil.example' } }));
    expect(foreign.status).toBe(403);
    const post = await local(new Request(url, { method: 'POST' }));
    expect(post.status).toBe(405);
  });
});
