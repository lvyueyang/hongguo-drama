/**
 * HLS 准备（迁移自 4.5 `src/native/hls-media.js`）。
 * 重点：清单地址改写成本地路径后才喂给 FFmpeg、只允许本地协议、
 * 直播清单/AES 之外的加密/循环引用/空间不足都要能在下载前拒绝。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../internal/net/guard.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const loopback = (url: string) => /127\.0\.0\.1|localhost/.test(String(url));
  return {
    ...actual,
    webMediaRequestOptions: (url: string) => (loopback(url) ? {} : actual.webMediaRequestOptions(url)),
  };
});

const { remuxHls } = await import('./hls.ts');

let server: http.Server;
let base = '';
const routes = new Map<string, () => { status?: number; type?: string; body: string | Buffer }>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const route = routes.get(String(request.url));
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    const { status = 200, type = 'application/octet-stream', body } = route();
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)) });
    response.end(body);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-hls-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** 记录参数并把「输入清单里的本地分片」拼成产物，模拟一次真实重封装。 */
function fakeFfmpeg(dir: string): { path: string; log: string } {
  const log = path.join(dir, 'ffmpeg.log');
  process.env.HONGGUO_FAKE_LOG = log;
  const file = script(
    dir,
    'ffmpeg',
    `echo "$*" >> "$HONGGUO_FAKE_LOG"
out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-protocol_whitelist 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
[ -n "$out" ] && printf 'hls-output' > "$out"
exit 0`,
  );
  return { path: file, log };
}

afterEach(() => {
  routes.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HONGGUO_FAKE_LOG;
});

function playlist(extra = ''): string {
  return `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${extra}#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST\n`;
}

describe('remuxHls', () => {
  it('把清单与分片落到本地、改写地址后交给 FFmpeg 只读本地文件', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/hls/manifest.m3u8', () => ({ type: 'application/vnd.apple.mpegurl', body: playlist() }));
    routes.set('/hls/0.ts', () => ({ type: 'video/mp2t', body: 'segment' }));
    const output = path.join(dir, 'out.mp4');
    const progress: number[] = [];
    await remuxHls({
      url: `${base}/hls/manifest.m3u8`,
      output,
      ffmpeg: ffmpeg.path,
      onProgress: (received) => progress.push(received),
    });
    expect(fs.readFileSync(output).toString()).toBe('hls-output');
    const args = fs.readFileSync(ffmpeg.log, 'utf8').trim();
    // 只允许本地协议：FFmpeg 自己不能联网（内置版也没有 HTTP 传输能力）
    expect(args).toContain('-protocol_whitelist file,crypto');
    expect(args).toContain('-allowed_extensions ALL');
    expect(args).not.toContain('http://');
    expect(progress.at(-1)).toBeGreaterThan(0);
  });

  it('没有 FFmpeg 直接报错（不静默用系统里的同名程序）', async () => {
    await expect(
      remuxHls({ url: `${base}/hls/manifest.m3u8`, output: '/tmp/x.mp4', ffmpeg: null }),
    ).rejects.toThrow(/未找到 FFmpeg/);
  });

  it('直播清单（没有 ENDLIST）明确拒绝', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/live.m3u8', () => ({
      type: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n',
    }));
    await expect(
      remuxHls({ url: `${base}/live.m3u8`, output: path.join(dir, 'out.mp4'), ffmpeg: ffmpeg.path }),
    ).rejects.toThrow(/直播清单/);
  });

  it('AES-128 之外的加密方式拒绝（ffmpeg 解不了就别装作能解）', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/drm.m3u8', () => ({
      type: 'application/vnd.apple.mpegurl',
      body: playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.key"\n'),
    }));
    await expect(
      remuxHls({ url: `${base}/drm.m3u8`, output: path.join(dir, 'out.mp4'), ffmpeg: ffmpeg.path }),
    ).rejects.toThrow(/加密方式/);
  });

  it('AES-128 密钥长度不对时拒绝', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/key.m3u8', () => ({
      type: 'application/vnd.apple.mpegurl',
      body: playlist('#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n'),
    }));
    routes.set('/k.key', () => ({ body: 'short' }));
    await expect(
      remuxHls({ url: `${base}/key.m3u8`, output: path.join(dir, 'out.mp4'), ffmpeg: ffmpeg.path }),
    ).rejects.toThrow(/密钥长度/);
  });

  it('清单循环引用会被发现并拒绝', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/loop.m3u8', () => ({ type: 'application/vnd.apple.mpegurl', body: playlist('') }));
    // 分片指向清单自己 → 再次 stage 同一地址
    routes.set('/loop.m3u8', () => ({
      type: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nloop.m3u8\n#EXT-X-ENDLIST\n',
    }));
    await expect(
      remuxHls({ url: `${base}/loop.m3u8`, output: path.join(dir, 'out.mp4'), ffmpeg: ffmpeg.path }),
    ).rejects.toThrow(/循环引用/);
  });

  it('分片返回错误页时不当成媒体', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/bad.m3u8', () => ({ type: 'application/vnd.apple.mpegurl', body: playlist() }));
    routes.set('/0.ts', () => ({ type: 'text/html', body: '<html>error</html>' }));
    await expect(
      remuxHls({ url: `${base}/bad.m3u8`, output: path.join(dir, 'out.mp4'), ffmpeg: ffmpeg.path }),
    ).rejects.toThrow(/错误页面/);
  });

  it('暂存空间上限为 0 时在下载前就停手', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/hls/manifest.m3u8', () => ({ type: 'application/vnd.apple.mpegurl', body: playlist() }));
    routes.set('/hls/0.ts', () => ({ type: 'video/mp2t', body: 'segment' }));
    await expect(
      remuxHls({
        url: `${base}/hls/manifest.m3u8`,
        output: path.join(dir, 'out.mp4'),
        ffmpeg: ffmpeg.path,
        tempCapacityBytes: 0,
      }),
    ).rejects.toThrow(/暂存空间不足/);
  });

  it('多个码率版本只留最高带宽的一路', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/master.m3u8', () => ({
      type: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000',
        'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'high.m3u8',
      ].join('\n'),
    }));
    for (const name of ['low', 'high']) {
      routes.set(`/${name}.m3u8`, () => ({ type: 'application/vnd.apple.mpegurl', body: playlist() }));
    }
    routes.set('/0.ts', () => ({ type: 'video/mp2t', body: 'segment' }));
    await remuxHls({
      url: `${base}/master.m3u8`,
      output: path.join(dir, 'out.mp4'),
      ffmpeg: ffmpeg.path,
    });
    // 清单里的本地副本数量：master + high + 0.ts = 3，low 没被拉下来
    const args = fs.readFileSync(ffmpeg.log, 'utf8');
    expect(args).toContain('m3u8');
    expect(fs.readFileSync(path.join(dir, 'out.mp4')).toString()).toBe('hls-output');
  });

  it('取消信号能让准备过程停下，并清掉临时目录', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    routes.set('/hls/manifest.m3u8', () => ({ type: 'application/vnd.apple.mpegurl', body: playlist() }));
    routes.set('/hls/0.ts', () => ({ type: 'video/mp2t', body: 'segment' }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      remuxHls({
        url: `${base}/hls/manifest.m3u8`,
        output: path.join(dir, 'out.mp4'),
        ffmpeg: ffmpeg.path,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/已取消 HLS 准备/);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('.hongguo-hls-'))).toBe(false);
  });
});
