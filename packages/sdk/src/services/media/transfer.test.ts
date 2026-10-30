/**
 * 媒体传输（迁移自 4.5 `main.js` 的 requestMedia / withMediaRecovery，
 * 等价于旧检查 `check-media-recovery.cjs` 的传输部分）。
 *
 * 这里用真实 loopback HTTP 服务（来源标记为 app，因此不走官网私网守卫），
 * 因为要验的正是「半截 body、错误页、404/403、Range 与重试」这些真实 IO 行为。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  awaitMediaOperation,
  mediaRange,
  mediaTransferError,
  pipeToFile,
  readToBuffer,
  requestMedia,
  withMediaRecovery,
} from './transfer.ts';

const MEDIA = Buffer.from('complete-media');
const hits: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push({ url: String(request.url), headers: request.headers });
    const url = String(request.url);
    if (url === '/missing') {
      response.writeHead(404).end();
      return;
    }
    if (url === '/forbidden') {
      response.writeHead(403).end();
      return;
    }
    if (url === '/html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('bad');
      return;
    }
    if (url === '/json-error') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"error":true}');
      return;
    }
    if (url === '/empty') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '0' });
      response.end();
      return;
    }
    if (url === '/partial') {
      response.writeHead(200, { 'Content-Length': '999' });
      response.write('partial');
      setTimeout(() => response.destroy(), 5);
      return;
    }
    if (url === '/206-full') {
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${MEDIA.length - 1}/${MEDIA.length}`,
        'Content-Length': String(MEDIA.length),
      });
      response.end(MEDIA);
      return;
    }
    if (url === '/206-partial') {
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 5-${MEDIA.length - 1}/${MEDIA.length}`,
        'Content-Length': '9',
      });
      response.end(MEDIA.subarray(5));
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), MEDIA.length - 1);
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const appInfo = (url: string, extra: Record<string, unknown> = {}) => ({
  url: base + url,
  source: 'app',
  vid: '11',
  ...extra,
});

function resetHits(): void {
  hits.length = 0;
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('mediaRange', () => {
  it('无 Range 返回 null，非法/越界返回 false，合法区间给出起止', () => {
    expect(mediaRange(undefined, 14)).toBeNull();
    expect(mediaRange(null, 14)).toBeNull();
    expect(mediaRange('bytes=0-1', 14)).toEqual({ start: 0, end: 1 });
    expect(mediaRange('bytes=2-', 14)).toEqual({ start: 2, end: 13 });
    expect(mediaRange('bytes=-4', 14)).toEqual({ start: 10, end: 13 });
    expect(mediaRange('bytes=20-30', 14)).toBe(false);
    expect(mediaRange('bytes=x', 14)).toBe(false);
    expect(mediaRange('bytes=-', 14)).toBe(false);
    expect(mediaRange('bytes=0-', 0)).toBe(false);
  });
});

describe('requestMedia', () => {
  it('正常取流并保留媒体头', async () => {
    resetHits();
    const response = await requestMedia(appInfo('/ok'));
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(String(MEDIA.length));
    expect(await text(response.data)).toBe('complete-media');
  });

  it('Range 原样透传给上游', async () => {
    resetHits();
    const response = await requestMedia(appInfo('/ok'), { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(await text(response.data)).toBe('mple');
    expect(hits[0]!.headers.range).toBe('bytes=2-5');
  });

  it('错误页（HTML / JSON）必须当传输失败，不能存成视频', async () => {
    for (const url of ['/html', '/json-error']) {
      await expect(requestMedia(appInfo(url))).rejects.toMatchObject({
        code: 'MEDIA_TRANSFER_ERROR',
        mediaRetryable: true,
      });
    }
  });

  it('404 汇报给调用方（带状态码与可重试标记），不做无限重试', async () => {
    resetHits();
    await expect(requestMedia(appInfo('/missing'))).rejects.toMatchObject({ mediaStatus: 404 });
    expect(hits.length).toBe(1);
  });

  it('App 片源的 403 翻一次 Referer 再试，第二次成功', async () => {
    resetHits();
    let attempt = 0;
    const flaky = http.createServer((request, response) => {
      attempt += 1;
      hits.push({ url: String(request.url), headers: request.headers });
      if (attempt === 1) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(MEDIA);
    });
    await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
    const port = (flaky.address() as { port: number }).port;
    try {
      const response = await requestMedia({
        url: `http://127.0.0.1:${port}/media`,
        source: 'app',
        vid: '11',
      });
      expect(response.status).toBe(200);
      expect(hits).toHaveLength(2);
      expect(hits[1]!.headers.referer).toBe('https://novelquickapp.com/');
    } finally {
      flaky.closeAllConnections();
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });

  it('上游擅自给 206：整段才接受（补上总长度），半截直接拒绝', async () => {
    const full = await requestMedia(appInfo('/206-full'));
    expect(full.status).toBe(206);
    expect(full.headers['content-length']).toBe(String(MEDIA.length));
    expect(await text(full.data)).toBe('complete-media');

    await expect(requestMedia(appInfo('/206-partial'))).rejects.toThrow(/不完整/);
  });

  it('只有官网与自定义片源套守卫；App 片源保留既有传输策略', async () => {
    // 回环地址：官网/自定义源必须在建连前就被闸门拦下；App 源不应该被套上闸门，
    // 而是按原策略直连（这里因为没人监听得到连接拒绝）。
    const loopback = 'http://127.0.0.1:1/media.mp4';
    for (const source of ['web', 'custom']) {
      await expect(requestMedia({ url: loopback, source, vid: '11' } as never)).rejects.toMatchObject({
        code: 'ERR_WEB_MEDIA_ADDRESS',
      });
    }
    const appError: any = await requestMedia({ url: loopback, source: 'app', vid: '11' } as never, {
      timeoutMs: 500,
    }).catch((error) => error);
    expect(appError.code).not.toBe('ERR_WEB_MEDIA_ADDRESS');
    expect(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EACCES']).toContain(appError.code);
  });

  it('官网片源指向私网/回环地址时被守卫拦下（不允许借片源地址探内网）', async () => {
    await expect(
      requestMedia({ url: `${base}/ok`, source: 'web', vid: '11' } as never),
    ).rejects.toMatchObject({ code: 'ERR_WEB_MEDIA_ADDRESS' });
  });

  it('取消后立即失败，不等上游', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestMedia(appInfo('/ok'), { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELED',
    });
  });
});

describe('落盘与收流', () => {
  it('pipeToFile 写完整文件；字节数与声明不符时报不完整', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-transfer-'));
    try {
      const ok = path.join(dir, 'ok.mp4');
      const response = await requestMedia(appInfo('/ok'));
      await expect(pipeToFile(response, ok)).resolves.toBe(MEDIA.length);
      expect(fs.readFileSync(ok).toString()).toBe('complete-media');

      const bad = path.join(dir, 'bad.mp4');
      const partial = await requestMedia(appInfo('/partial'), { acceptStatus: [200, 206, 416] });
      await expect(pipeToFile(partial, bad)).rejects.toThrow(/不完整/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空 body 不能当成完整片源：落盘与收流都按「不完整」失败', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-transfer-empty-'));
    try {
      const file = path.join(dir, 'empty.mp4');
      await expect(pipeToFile(await requestMedia(appInfo('/empty')), file)).rejects.toMatchObject({
        code: 'MEDIA_TRANSFER_ERROR',
        mediaRetryable: true,
      });
      await expect(readToBuffer(await requestMedia(appInfo('/empty')))).rejects.toThrow(/不完整/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readToBuffer 超过上限立即放弃，并给出可执行的文案', async () => {
    const response = await requestMedia(appInfo('/ok'));
    const failure = await readToBuffer(response, { maxBytes: 4 }).catch((error) => error);
    expect(failure.code).toBe('MEDIA_TOO_LARGE');
    // 文案是用户直接看到的：过大要给出可执行的下一步
    expect(failure.message).toMatch(/本集过大，请下载后播放/);
  });
});

describe('awaitMediaOperation', () => {
  it('原样透传结果；超时给传输错误；取消给 CANCELED', async () => {
    await expect(awaitMediaOperation(Promise.resolve('v'), undefined)).resolves.toBe('v');
    await expect(awaitMediaOperation(new Promise(() => {}), undefined, 10)).rejects.toThrow(/超时/);
    const controller = new AbortController();
    controller.abort();
    await expect(awaitMediaOperation(new Promise(() => {}), controller.signal)).rejects.toMatchObject({
      code: 'CANCELED',
    });
  });
});

describe('withMediaRecovery', () => {
  it('当前地址失败后按候选逐个重试，成功即返回', async () => {
    const attempts: string[] = [];
    const value = await withMediaRecovery(
      '11',
      '1',
      {
        playInfo: appInfo('/missing', {
          variants: [appInfo('/missing'), appInfo('/ok')],
        }) as never,
      },
      async (candidate) => {
        attempts.push(String(candidate.url));
        const response = await requestMedia(candidate as never);
        return text(response.data);
      },
    );
    expect(value).toBe('complete-media');
    expect(attempts).toHaveLength(2);
  });

  it('片源暂时不可用（超时类）会重新取源并带 force', async () => {
    const calls: Array<{ quality?: string; force?: boolean }> = [];
    let round = 0;
    const value = await withMediaRecovery(
      '11',
      '1',
      {
        open: async (_vid, _sid, options) => {
          calls.push({ quality: options?.quality, force: options?.force });
          round += 1;
          if (round === 1) {
            return {
              url: null,
              code: 'SOURCE_UNAVAILABLE',
              sources: [{ source: 'app', code: 'TIMEOUT' }],
              error: 'temporary',
            } as never;
          }
          return appInfo('/ok') as never;
        },
      },
      async (candidate) => {
        const response = await requestMedia(candidate as never);
        return text(response.data);
      },
    );
    expect(value).toBe('complete-media');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.force).toBe(true);
  });

  it('空响应不是「暂时不可用」：只取一次源就失败', async () => {
    const calls: unknown[] = [];
    await expect(
      withMediaRecovery(
        '11',
        '1',
        {
          open: async (_vid, _sid, options) => {
            calls.push(options);
            return {
              url: null,
              code: 'SOURCE_UNAVAILABLE',
              sources: [{ source: 'app', code: 'EMPTY_RESPONSE' }],
              error: 'empty response',
            } as never;
          },
        },
        async () => 'never',
      ),
    ).rejects.toThrow(/empty response/);
    expect(calls).toHaveLength(1);
  });

  it('磁盘/安全类失败不换更低清晰度（换也救不回来）', async () => {
    const attempts: string[] = [];
    await expect(
      withMediaRecovery(
        '11',
        '1',
        {
          playInfo: appInfo('/ok', {
            variants: [appInfo('/ok'), appInfo('/missing')],
          }) as never,
          allowLowerQuality: true,
        },
        async (candidate) => {
          attempts.push(String(candidate.url));
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(attempts).toHaveLength(1);
  });

  it('取消后不再试下一个候选', async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    await expect(
      withMediaRecovery(
        '11',
        '1',
        {
          playInfo: appInfo('/ok', { variants: [appInfo('/ok'), appInfo('/ok')] }) as never,
          signal: controller.signal,
        },
        async (candidate) => {
          attempts.push(String(candidate.url));
          controller.abort();
          throw mediaTransferError('中断');
        },
      ),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(attempts).toHaveLength(1);
  });

  it('非红果来源不做多轮重试（只有一轮取源）', async () => {
    let opens = 0;
    await expect(
      withMediaRecovery(
        'hema:1:2',
        'hema:1',
        {
          open: async () => {
            opens += 1;
            return {
              url: null,
              code: 'SOURCE_UNAVAILABLE',
              sources: [{ source: 'app', code: 'TIMEOUT' }],
              error: 'temporary',
            } as never;
          },
        },
        async () => 'never',
      ),
    ).rejects.toThrow(/temporary/);
    expect(opens).toBe(1);
  });

  it('候选全部失败时报最后一个错误，不返回半成功', async () => {
    const info = appInfo('/missing', { variants: [appInfo('/missing')] });
    await expect(
      withMediaRecovery(
        '11',
        '1',
        // 每轮重新取源都会拿到同一个已验证可达的地址，不会再碰真网络。
        { open: async () => info as never },
        async (candidate) => {
          await requestMedia(candidate as never);
          return 'never';
        },
      ),
    ).rejects.toMatchObject({ mediaStatus: 404 });
  });
});
