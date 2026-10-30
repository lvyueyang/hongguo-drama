/**
 * 播放会话（迁移自 4.5 `main.js` 的 registerStreamProtocol + onlineSessions，
 * 等价于旧检查 `check-media-recovery.cjs` 的供片部分）。
 *
 * 两条不变量：
 * - 同一会话内一旦开始供片，就不能换成另一份媒体（播放器会拿到混合字节）；
 * - 只有「还没开始供片」时才允许换候选重试。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  hits.length = 0;
});

// 夹具走 loopback；真实守卫有自己的边界测试（internal/net/guard.test.ts），这里放行回环地址。
vi.mock('../../internal/net/guard.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const loopback = (url: string) => /127\.0\.0\.1|localhost/.test(String(url));
  return {
    ...actual,
    webMediaRequestOptions: (url: string) => (loopback(url) ? {} : actual.webMediaRequestOptions(url)),
  };
});

const { createSessionRegistry, openBufferSession, openMediaSession } = await import('./stream.ts');

const MEDIA = Buffer.from('complete-media');
let server: http.Server;
let base = '';
/** 媒体请求记账：验「准备阶段不发请求」「超限不重试」这类不变量。 */
const hits: string[] = [];
/** 上游 body 被中断（服务器侧看到连接关闭）。 */
let upstreamClosed = false;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = String(request.url);
    hits.push(url);
    if (url === '/slow') {
      // 边下边给：先给一小段，然后挂着不结束，直到客户端断开。
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '100000' });
      response.write(Buffer.alloc(1024, 7));
      request.on('close', () => {
        upstreamClosed = true;
      });
      return;
    }
    if (url === '/empty') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '0' });
      response.end();
      return;
    }
    if (url === '/media') {
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), MEDIA.length - 1);
        if (start >= MEDIA.length) {
          response.writeHead(416, { 'Content-Range': `bytes */${MEDIA.length}` }).end();
          return;
        }
        response.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${MEDIA.length}`,
          'Content-Length': String(end - start + 1),
        });
        response.end(MEDIA.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(MEDIA.length) });
      response.end(MEDIA);
      return;
    }
    if (url === '/hls/manifest.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (url === '/hls/0.ts') {
      response.writeHead(200, { 'Content-Type': 'video/mp2t' });
      response.end(Buffer.from('segment'));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-stream-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function probeJson(width = 1080, height = 1920, duration = 12): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width,
        height,
        pix_fmt: 'yuv420p',
        r_frame_rate: '30/1',
        time_base: '1/90000',
        extradata_hash: 'abc',
      },
    ],
    format: { duration: String(duration), size: '200000' },
  });
}

function tools(
  dir: string,
  options: { output?: string } = {},
): {
  ffmpeg: string;
  ffprobe: string;
  supportsHttp: false;
} {
  const ffprobe = script(
    dir,
    'ffprobe',
    `cat <<'EOF'
${probeJson()}
EOF`,
  );
  const ffmpeg = script(
    dir,
    'ffmpeg',
    `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
[ -n "$out" ] && printf '${options.output ?? 'decrypted-media'}' > "$out"
exit 0`,
  );
  return { ffmpeg, ffprobe, supportsHttp: false };
}

function host(dir: string): { temporaryDir(): string } {
  return { temporaryDir: () => dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 空 body 会话：HEAD/416 只回头与状态，不回字节。 */
function bodyLength(chunk: { body: Buffer | Readable }): number {
  return Buffer.isBuffer(chunk.body) ? chunk.body.length : -1;
}

async function bodyOf(chunk: { body: Buffer | Readable }): Promise<string> {
  if (Buffer.isBuffer(chunk.body)) return chunk.body.toString();
  const chunks: Buffer[] = [];
  for await (const part of chunk.body) chunks.push(Buffer.from(part as Buffer));
  return Buffer.concat(chunks).toString();
}

const playInfo = (url: string, extra: Record<string, unknown> = {}) =>
  ({ url: base + url, source: 'app', vid: '11', ...extra }) as never;

describe('会话注册表', () => {
  it('超过上限淘汰最久未用的会话，并释放它的资源', () => {
    const registry = createSessionRegistry({ max: 2 });
    const disposed: string[] = [];
    const make = (id: string) => ({
      id,
      async read() {
        return { status: 200, headers: {}, body: Buffer.alloc(0) };
      },
      dispose: () => disposed.push(id),
    });
    const a = make('a');
    const b = make('b');
    const c = make('c');
    registry.add(a);
    registry.add(b);
    // 读一次 a：b 变成最久未用
    registry.get('a');
    registry.add(c);
    expect(disposed).toEqual(['b']);
    expect(registry.get('b')).toBeUndefined();
    expect(registry.get('a')).toBeDefined();
    expect(registry.size()).toBe(2);
    registry.release('a');
    expect(disposed).toEqual(['b', 'a']);
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

describe('内存会话', () => {
  it('支持整段、Range 与 HEAD；非法 Range 返回 416', async () => {
    const registry = createSessionRegistry();
    const session = openBufferSession({ buffer: MEDIA, vid: '11' }, registry);
    const full = await session.read();
    expect(full.status).toBe(200);
    expect(await bodyOf(full)).toBe('complete-media');
    const ranged = await session.read('bytes=2-5');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['Content-Range']).toBe(`bytes 2-5/${MEDIA.length}`);
    expect(await bodyOf(ranged)).toBe('mple');
    const head = await session.read(null, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(bodyLength(head)).toBe(0);
    const beyond = await session.read(`bytes=${MEDIA.length}-`);
    expect(beyond.status).toBe(416);
    expect(await session.snapshot?.()).toEqual(MEDIA);
  });
});

describe('明文会话', () => {
  it('边下边给：Body 是流，Range 透传上游', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      { playInfo: playInfo('/media'), vid: '11', seriesId: '1', host: host(dir) },
      registry,
    );
    const chunk = await session.read('bytes=2-5');
    expect(chunk.status).toBe(206);
    expect(chunk.headers['Content-Range']).toBe(`bytes 2-5/${MEDIA.length}`);
    expect(Buffer.isBuffer(chunk.body)).toBe(false);
    expect(await bodyOf(chunk)).toBe('mple');
  });

  it('准备好会话时一个媒体字节都还没请求（播放器拉流才出网）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    hits.length = 0;
    const session = await openMediaSession(
      { playInfo: playInfo('/media', { spadeA: '' }), vid: '11', seriesId: '1', host: host(dir) },
      registry,
    );
    expect(hits).toEqual([]);
    expect(session.id).toBeTruthy();
    expect(await bodyOf(await session.read())).toBe('complete-media');
    expect(hits).toEqual(['/media']);
  });

  it('释放会话会中止正在传输的上游 body（不把 CDN 连接留到进程结束）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      { playInfo: playInfo('/slow'), vid: '11', host: host(dir) },
      registry,
    );
    const chunk = await session.read();
    const reader = (chunk.body as Readable)[Symbol.asyncIterator]();
    await reader.next();
    upstreamClosed = false;
    registry.release(session.id);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 3000 });
    expect(registry.get(session.id)).toBeUndefined();
  });

  it('地址查询期间释放会话：取消失败，且不会因为迟到的地址再发起下载', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    hits.length = 0;
    const session = await openMediaSession(
      {
        // 取源还没回来（暂时不可用 → 会重新取源）；此时播放器断开连接
        playInfo: {
          url: null,
          source: 'app',
          vid: '11',
          code: 'SOURCE_UNAVAILABLE',
          error: 'temporary',
          sources: [{ source: 'app', code: 'TIMEOUT' }],
        } as never,
        vid: '11',
        host: host(dir),
        open: () => new Promise(() => {}),
      },
      registry,
    );
    const pending = session.read();
    const settled = pending.catch((error) => error);
    registry.release(session.id);
    await expect(settled).resolves.toMatchObject({ code: 'CANCELED' });
    expect(hits).toEqual([]);
  });

  it('明文会话不做整段缓冲：预算再小也直接给流，不先攒够再播', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    hits.length = 0;
    const session = await openMediaSession(
      { playInfo: playInfo('/media'), vid: '11', host: host(dir), maxBytes: 1 },
      registry,
    );
    const chunk = await session.read();
    expect(chunk.status).toBe(200);
    expect(Buffer.isBuffer(chunk.body)).toBe(false);
    expect(await bodyOf(chunk)).toBe('complete-media');
    expect(hits).toEqual(['/media']);
    session.dispose();
  });

  it('供片前允许换候选恢复；换到可用地址后正常出片', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/missing', { variants: [playInfo('/missing'), playInfo('/media')] }),
        vid: '11',
        seriesId: '1',
        host: host(dir),
      },
      registry,
    );
    const chunk = await session.read();
    expect(chunk.status).toBe(200);
    expect(await bodyOf(chunk)).toBe('complete-media');
  });

  it('开始供片后片源被换掉：拒绝继续供片（不能让播放器拿到混合字节）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const info = playInfo('/media') as Record<string, unknown>;
    const session = await openMediaSession({ playInfo: info as never, vid: '11', host: host(dir) }, registry);
    expect((await session.read()).status).toBe(200);
    // 模拟会话持有的片源地址被替换（4.5 里由并发的另一路准备改掉 entry.playInfo）
    info.url = `${base}/media?other=1`;
    await expect(session.read('bytes=2-5')).rejects.toThrow(/片源已变化/);
  });

  it('上游 416 原样交回播放器', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      { playInfo: playInfo('/media'), vid: '11', host: host(dir) },
      registry,
    );
    const chunk = await session.read('bytes=14-20');
    expect(chunk.status).toBe(416);
    expect(bodyLength(chunk)).toBe(0);
  });

  it('HEAD 也能供片（播放器探测大小）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      { playInfo: playInfo('/media'), vid: '11', host: host(dir) },
      registry,
    );
    const chunk = await session.read(null, { method: 'HEAD' });
    expect(chunk.status).toBe(200);
    expect(bodyLength(chunk)).toBe(0);
  });
});

describe('加密会话', () => {
  it('整集解密后按 Range 供片，snapshot 交给缓存层', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/media', { contentKey: '00112233445566778899aabbccddeeff' }),
        vid: '11',
        seriesId: '1',
        host: host(dir),
        tools: tools(dir, { output: 'decrypted-media' }),
      },
      registry,
    );
    const snapshot = await session.snapshot?.();
    expect(snapshot?.toString()).toBe('decrypted-media');
    const ranged = await session.read('bytes=0-3');
    expect(ranged.status).toBe(206);
    expect(await bodyOf(ranged)).toBe('decr');
  });

  it('dispose 会清掉解密临时目录', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/media', { contentKey: '00112233445566778899aabbccddeeff' }),
        vid: '11',
        host: host(dir),
        tools: tools(dir),
      },
      registry,
    );
    await session.read();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('hongguo-decrypt-'))).toBe(true);
    session.dispose();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('hongguo-decrypt-'))).toBe(false);
  });

  it('整集解密后仍支持后缀 Range，越界 Range 回 416（播放器拖到末尾）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/media', { contentKey: '00112233445566778899aabbccddeeff' }),
        vid: '11',
        host: host(dir),
        tools: tools(dir, { output: 'decrypted-media' }),
      },
      registry,
    );
    const suffix = await session.read('bytes=-3');
    expect(suffix.status).toBe(206);
    expect(suffix.headers['Content-Range']).toBe('bytes 12-14/15');
    expect(await bodyOf(suffix)).toBe('dia');
    for (const range of ['bytes=99-200', 'bytes=5-2', 'bytes=0-2,4-6', 'junk']) {
      const invalid = await session.read(range);
      expect(invalid.status, range).toBe(416);
      expect(bodyLength(invalid)).toBe(0);
    }
    session.dispose();
  });

  it('空 body 不能当成内容：按传输失败收敛（不是空视频）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    // 非红果来源只有一轮取源：空响应不会被「换片源」掩盖
    const session = await openMediaSession(
      {
        playInfo: playInfo('/empty', { contentKey: '00112233445566778899aabbccddeeff' }),
        vid: 'hema:11:1',
        host: host(dir),
        tools: tools(dir),
      },
      registry,
    );
    await expect(session.read()).rejects.toMatchObject({ code: 'MEDIA_TRANSFER_ERROR' });
    await expect(session.read()).rejects.toThrow(/不完整/);
    session.dispose();
  });

  it('超过预算的加密内容直接被拒，且释放会话后解密临时目录清空', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/media', { contentKey: '00112233445566778899aabbccddeeff' }),
        vid: '11',
        host: host(dir),
        tools: tools(dir, { output: 'decrypted-media' }),
        maxBytes: 8,
      },
      registry,
    );
    // 校验发生在把整集读进内存之前：超限直接失败，不返回截断内容
    await expect(session.read()).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    session.dispose();
    // 工具替身也在这个目录里：只断言会话自己的临时目录被清掉
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('hongguo-decrypt-'))).toEqual([]);
  });
});

describe('会话资源归属（迁移自 4.5 的 online disk lifecycle）', () => {
  it('两个会话各自持有一份产物：释放其中一个，另一个照常供片', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const request = () => ({
      playInfo: playInfo('/hls/manifest.m3u8', { format: 'hls' }),
      vid: '11',
      host: host(dir),
      tools: tools(dir, { output: 'hls-media' }),
    });
    const first = await openMediaSession(request(), registry);
    const second = await openMediaSession(request(), registry);
    expect(await bodyOf(await first.read('bytes=0-2'))).toBe('hls');
    expect(await bodyOf(await second.read('bytes=0-2'))).toBe('hls');

    first.dispose();
    // 另一个会话的产物不受影响（不能被「有人释放了」连带删掉）
    expect(await bodyOf(await second.read('bytes=0-2'))).toBe('hls');
    second.dispose();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('hongguo-hls-play-'))).toBe(false);
  });

  it('临时目录被占用（Windows EBUSY）时不抛异常，稍后重试删掉', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/hls/manifest.m3u8', { format: 'hls' }),
        vid: '11',
        host: host(dir),
        tools: tools(dir, { output: 'hls-media' }),
      },
      registry,
    );
    await session.read();
    const original = fs.rmSync;
    let failures = 2;
    (fs as unknown as { rmSync: unknown }).rmSync = (...args: unknown[]) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('file open'), { code: 'EBUSY' });
      }
      return (original as (...rest: unknown[]) => unknown)(...args);
    };
    try {
      // dispose 不能把调用方带崩（缓存淘汰、来源停用都会走这一步）
      expect(() => session.dispose()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      (fs as unknown as { rmSync: unknown }).rmSync = original;
    }
    expect(fs.readdirSync(dir).some((name) => name.startsWith('hongguo-hls-play-'))).toBe(false);
  });
});

describe('HLS 会话', () => {
  it('先重封装成 mp4 再供片；snapshot 不把大文件塞进播放缓存', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const session = await openMediaSession(
      {
        playInfo: playInfo('/hls/manifest.m3u8', { format: 'hls' }),
        vid: '11',
        host: host(dir),
        tools: tools(dir, { output: 'hls-media' }),
      },
      registry,
    );
    const chunk = await session.read('bytes=0-2');
    expect(chunk.status).toBe(206);
    expect(await bodyOf(chunk)).toBe('hls');
    expect(await session.snapshot?.()).toBeNull();
    session.dispose();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('hongguo-hls-play-'))).toBe(false);
  });

  it('重封装产物校验不过就失败（退出码为 0 但文件不可读）', async () => {
    const dir = tempDir();
    const registry = createSessionRegistry();
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
[ -n "$out" ] && printf 'garbage' > "$out"
exit 0`,
    );
    const ffprobe = script(
      dir,
      'ffprobe',
      `cat <<'EOF'
${JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }], format: { duration: '0' } })}
EOF`,
    );
    const session = await openMediaSession(
      {
        playInfo: playInfo('/hls/manifest.m3u8', { format: 'hls' }),
        vid: '11',
        host: host(dir),
        tools: { ffmpeg, ffprobe, supportsHttp: false },
      },
      registry,
    );
    await expect(session.read()).rejects.toThrow(/缺少有效视频轨或时长/);
  });
});
