/**
 * 单集下载（迁移自 4.5 `main.js` 的 executeHongguoDownload，
 * 等价于旧检查 `check-download-quality-integration.cjs`）。
 *
 * 用真实 loopback HTTP + 真实的 ffprobe/ffmpeg 替身脚本，验的是行为不是实现：
 * 校验通过才发布、半截文件不落地、清晰度不静默降级、本地错误不换片源、
 * 已存在文件绝不覆盖。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// 夹具走 loopback；真实守卫有自己的边界测试（internal/net/guard.test.ts），这里放行回环地址。
vi.mock('../../internal/net/guard.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const loopback = (url: string) => /127\.0\.0\.1|localhost/.test(String(url));
  return {
    ...actual,
    webMediaRequestOptions: (url: string) => (loopback(url) ? {} : actual.webMediaRequestOptions(url)),
  };
});

const { downloadEpisode, verifyDownloadedFile } = await import('./download.ts');
const { default: store } = await import('../storage/store.ts');
const { probeMedia } = await import('./tools.ts');

const MEDIA = Buffer.from('complete-media');
let server: http.Server;
let base = '';
const hits: string[] = [];
/** 动态路由：值是一个惰性取字节的函数（真实解码器用例要按需生成坏样本）。 */
const dynamicRoutes = new Map<string, () => Buffer>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = String(request.url);
    hits.push(url);
    const dynamic = dynamicRoutes.get(url);
    if (dynamic) {
      const body = dynamic();
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) });
      response.end(body);
      return;
    }
    if (url === '/media') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(MEDIA.length) });
      response.end(MEDIA);
      return;
    }
    if (url === '/partial') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '999' });
      response.write('partial');
      setTimeout(() => response.destroy(), 5);
      return;
    }
    if (url === '/slow') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '1000000' });
      response.write(Buffer.alloc(1024, 1));
      // 保持连接不结束，方便测试中途取消
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-download-'));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function probeJson(width: number, height: number, duration = 12): string {
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

interface Fixture {
  dir: string;
  tools: { ffmpeg: string; ffprobe: string; supportsHttp: boolean };
  host: { temporaryDir(): string; logger(): { warn(): void } };
  log: string;
}

/** 造一套工具替身：ffprobe 报固定分辨率，ffmpeg 按参数判断是解码校验还是 HLS 重封装。 */
function fixture(
  options: { width?: number; height?: number; decodeFails?: boolean; decodeFailsFirst?: number } = {},
): Fixture {
  const { width = 1080, height = 1920, decodeFails = false, decodeFailsFirst = 0 } = options;
  const dir = tempDir();
  const log = path.join(dir, 'ffprobe.log');
  const decodeTries = path.join(dir, 'decode-tries');
  process.env.HONGGUO_FAKE_LOG = log;
  const ffprobe = script(
    dir,
    'ffprobe',
    `echo "$*" >> "$HONGGUO_FAKE_LOG"
cat <<'EOF'
${probeJson(width, height)}
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
case "$*" in
  *null*)
    # 解码校验：前 N 次故意失败，用来模拟「官网片源坏了」。
    tries=0
    [ -f "${decodeTries}" ] && tries=$(cat "${decodeTries}")
    tries=$((tries + 1))
    echo $tries > "${decodeTries}"
    if [ $tries -le ${decodeFailsFirst} ]; then echo "Invalid data found when processing input" >&2; exit 1; fi
    ${decodeFails ? 'echo "Invalid data found when processing input" >&2; exit 1' : 'exit 0'};;
esac
[ -n "$out" ] && printf 'remuxed-media' > "$out"
exit 0`,
  );
  return {
    dir,
    tools: { ffmpeg, ffprobe, supportsHttp: false },
    host: { temporaryDir: () => dir, logger: () => ({ warn: () => {} }) },
    log,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.HONGGUO_FAKE_LOG;
  hits.length = 0;
  dynamicRoutes.clear();
});

const playInfo = (url = '/media', extra: Record<string, unknown> = {}) =>
  ({ url: base + url, source: 'app', vid: '11', ...extra }) as never;

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.enc.tmp') || name.endsWith('.decoded'));
}

describe('明文下载', () => {
  it('校验通过才发布：成品字节一致、临时文件清空、实际清晰度来自探测', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const result = await downloadEpisode({
      playInfo: playInfo(),
      outputPath: output,
      quality: '1080p',
      allowLowerQuality: true,
      tools: h.tools,
      host: h.host,
    });
    expect(result.actualQuality).toBe('1080p');
    expect(result.qualityNotice).toBe('');
    expect(fs.readFileSync(output).toString()).toBe('complete-media');
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('未给 playInfo 时用 open 现取源（vid 由调用方给出，不能依赖片源结果）', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const opened: string[] = [];
    const result = await downloadEpisode({
      vid: '11',
      seriesId: '1',
      outputPath: output,
      tools: h.tools,
      host: h.host,
      open: async (vid) => {
        opened.push(vid);
        return playInfo() as never;
      },
    });
    expect(opened).toEqual(['11']);
    expect(result.bytes).toBe(MEDIA.length);
  });

  it('只下载到更低清晰度时如实汇报（不静默降级）', async () => {
    const h = fixture({ width: 720, height: 1280 });
    const output = path.join(h.dir, 'out.mp4');
    const notices: string[] = [];
    const result = await downloadEpisode({
      playInfo: playInfo('/media', { width: 720, height: 1280 }),
      outputPath: output,
      quality: '1080p',
      allowLowerQuality: true,
      tools: h.tools,
      host: h.host,
      onProgress: (progress) => {
        if (progress.qualityNotice) notices.push(progress.qualityNotice);
      },
    });
    expect(result.actualQuality).toBe('720p');
    expect(result.qualityNotice).toBe('已下载更低质量片源：720P（原选 1080P）');
    expect(notices.some((notice) => /正在下载更低质量片源：720P/.test(notice))).toBe(true);
  });

  it('不允许降级时低清晰度直接失败，且不留下任何文件', async () => {
    const h = fixture({ width: 720, height: 1280 });
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        playInfo: playInfo(),
        outputPath: output,
        quality: '1080p',
        allowLowerQuality: false,
        tools: h.tools,
        host: h.host,
      }),
    ).rejects.toThrow(/不满足 1080P/);
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('传输中途断开按「不完整」失败，不发布半截文件', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        vid: '11',
        playInfo: playInfo('/partial'),
        outputPath: output,
        tools: h.tools,
        host: h.host,
        recover: false,
      }),
    ).rejects.toThrow(/不完整/);
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('解码校验失败按 MEDIA_DECODE_ERROR 失败（可重试的片源问题）', async () => {
    const h = fixture({ decodeFails: true });
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        playInfo: playInfo(),
        outputPath: output,
        tools: h.tools,
        host: h.host,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('中途取消是终态：不发布、不留临时文件', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const controller = new AbortController();
    await expect(
      downloadEpisode({
        playInfo: playInfo('/slow'),
        outputPath: output,
        tools: h.tools,
        host: h.host,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.receivedBytes > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('已存在的成品可用就直接复用，不覆盖用户文件也不发请求', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    fs.writeFileSync(output, 'user file');
    const result = await downloadEpisode({
      playInfo: playInfo(),
      outputPath: output,
      quality: '1080p',
      tools: h.tools,
      host: h.host,
    });
    expect(result.qualityNotice).toBe('已存在可用文件，跳过下载');
    expect(fs.readFileSync(output).toString()).toBe('user file');
    expect(hits).toEqual([]);
  });

  it('已存在但达不到所选清晰度：如实失败并保留文件，不悄悄覆盖', async () => {
    const h = fixture({ width: 720, height: 1280 });
    const output = path.join(h.dir, 'out.mp4');
    fs.writeFileSync(output, 'user low-res file');
    await expect(
      downloadEpisode({
        playInfo: playInfo(),
        outputPath: output,
        quality: '1080p',
        tools: h.tools,
        host: h.host,
      }),
    ).rejects.toThrow(/已有本地文件实际为 720P/);
    expect(fs.readFileSync(output).toString()).toBe('user low-res file');
  });
});

describe('加密与 HLS', () => {
  it('spade_a 片源派生密钥失败即失败，不把未解密内容当成成品发布', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        vid: '11',
        playInfo: playInfo('/media', { spadeA: 'AAECAwQFBgcICQoLDA0ODw==' }),
        outputPath: output,
        tools: h.tools,
        host: h.host,
        recover: false,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('CENC 片源用内置 FFmpeg 解密后再校验发布', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    await downloadEpisode({
      playInfo: playInfo('/media', { contentKey: '00112233445566778899aabbccddeeff' }),
      outputPath: output,
      tools: h.tools,
      host: h.host,
    });
    expect(fs.readFileSync(output).toString()).toBe('remuxed-media');
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('HLS 片源先落盘重封装，再走同一套校验与发布', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const result = await downloadEpisode({
      playInfo: playInfo('/hls/manifest.m3u8', { format: 'hls' }),
      outputPath: output,
      tools: h.tools,
      host: h.host,
    });
    expect(result.actualQuality).toBe('1080p');
    expect(fs.readFileSync(output).toString()).toBe('remuxed-media');
    expect(hits).toContain('/hls/manifest.m3u8');
    expect(hits).toContain('/hls/0.ts');
  });
});

describe('坏片源的恢复（对应旧检查 check-download-quality-integration 的解码用例）', () => {
  it('官网片源解码失败时重新取源并换到 App 片源，不重复拉同一个坏地址', async () => {
    const h = fixture({ decodeFailsFirst: 1 });
    const output = path.join(h.dir, 'out.mp4');
    const result = await downloadEpisode({
      vid: '11',
      seriesId: '1',
      playInfo: playInfo('/media', { source: 'web' }),
      outputPath: output,
      // 重新取源时官网已记账失败，拿到的就是 App 片源
      open: async () => playInfo('/media') as never,
      tools: h.tools,
      host: h.host,
    });
    expect(result.actualQuality).toBe('1080p');
    expect(fs.readFileSync(output).toString()).toBe('complete-media');
    // 一次官网失败 + 一次 App 成功：不是「不断重试同一个坏地址」
    expect(hits).toEqual(['/media', '/media']);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('坏片源反复失败时停手报错，不发布半成品，也不无限重试', async () => {
    const h = fixture({ decodeFails: true });
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        vid: '11',
        seriesId: '1',
        playInfo: playInfo('/media'),
        outputPath: output,
        open: async () => playInfo('/media') as never,
        tools: h.tools,
        host: h.host,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
    expect(fs.existsSync(output)).toBe(false);
    expect(hits.length).toBeLessThanOrEqual(4);
  });
});

describe('verifyDownloadedFile', () => {
  it('合法文件只读校验，返回实际清晰度且不改动文件', async () => {
    const h = fixture();
    const file = path.join(h.dir, 'existing.mp4');
    fs.writeFileSync(file, Buffer.alloc(200_000, 7));
    const before = fs.statSync(file);
    const result = await verifyDownloadedFile({ path: file, quality: '720p', tools: h.tools });
    expect(result.actualQuality).toBe('1080p');
    expect(fs.readFileSync(file)[0]).toBe(7);
    expect(fs.statSync(file).size).toBe(before.size);
  });

  it('文件已不存在（被用户删掉）时不当作已完成，如实报错', async () => {
    const h = fixture();
    await expect(
      verifyDownloadedFile({ path: path.join(h.dir, 'gone.mp4'), quality: 'auto', tools: h.tools }),
    ).rejects.toThrow(/不存在|无法读取/);
  });

  it('空文件直接拒绝，不浪费一次探测', async () => {
    const h = fixture();
    const file = path.join(h.dir, 'empty.mp4');
    fs.writeFileSync(file, '');
    await expect(verifyDownloadedFile({ path: file, quality: 'auto', tools: h.tools })).rejects.toThrow(
      /为空/,
    );
    expect(fs.existsSync(h.log)).toBe(false);
  });

  it('探测不出视频轨时拒绝，并原样保留文件（不删用户的东西）', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'broken.mp4');
    fs.writeFileSync(file, Buffer.alloc(1000, 3));
    const ffprobe = script(dir, 'ffprobe', 'exit 1');
    await expect(
      verifyDownloadedFile({
        path: file,
        quality: 'auto',
        tools: { ffmpeg: null, ffprobe, supportsHttp: false },
      }),
    ).rejects.toThrow(/缺少有效视频轨/);
    expect(fs.readFileSync(file)[0]).toBe(3);
  });

  it('时长必须有效：0 时长当作坏文件', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'noduration.mp4');
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    const ffprobe = script(
      dir,
      'ffprobe',
      `cat <<'EOF'
${JSON.stringify({
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }],
  format: { duration: '0' },
})}
EOF`,
    );
    await expect(
      verifyDownloadedFile({
        path: file,
        quality: 'auto',
        tools: { ffmpeg: null, ffprobe, supportsHttp: false },
      }),
    ).rejects.toThrow(/缺少有效视频轨/);
  });
});

/**
 * 真实解码器用例（对应旧检查 `check-download-quality-integration.cjs` 的第一条）。
 *
 * 用真实的 FFmpeg 造一段视频，再把 mdat 清零，得到「元数据完好、样本数据损坏」的样本：
 * 这种情况下 ffprobe 依然能读出分辨率与时长，只有真正解码才会失败——
 * 所以我们不能只靠探测就开始发布。这一条需要本机有 ffmpeg/ffprobe（未安装则跳过）。
 */
function detectRealTools(): { ffmpeg: string; ffprobe: string; supportsHttp: boolean } | null {
  const names =
    process.platform === 'win32'
      ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }
      : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const dirs = [
    path.resolve(process.cwd(), 'build', 'ffmpeg', `${process.platform}-${process.arch}`),
    path.resolve(process.cwd(), 'build', 'ffmpeg'),
    ...String(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean),
  ];
  for (const dir of dirs) {
    const ffmpeg = path.join(dir, names.ffmpeg);
    const ffprobe = path.join(dir, names.ffprobe);
    try {
      fs.accessSync(ffmpeg, fs.constants.X_OK);
      fs.accessSync(ffprobe, fs.constants.X_OK);
      return { ffmpeg, ffprobe, supportsHttp: false };
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

const realTools = detectRealTools();

describe.skipIf(!realTools)('真实解码器（需要本机 ffmpeg/ffprobe）', () => {
  it('损坏样本：元数据能读但解码失败，不发布；健康样本正常发布', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tempDir();
    const valid = path.join(dir, 'valid.mp4');
    execFileSync(
      (realTools as { ffmpeg: string }).ffmpeg,
      [
        '-v',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=640x360:r=24:d=1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-qp',
        '0',
        '-pix_fmt',
        'yuv420p',
        valid,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
    );
    const bytes = fs.readFileSync(valid);
    const damaged = Buffer.from(bytes);
    const mdat = damaged.indexOf(Buffer.from('mdat'));
    expect(mdat).toBeGreaterThanOrEqual(4);
    const end = mdat - 4 + damaged.readUInt32BE(mdat - 4);
    expect(end).toBeGreaterThan(mdat + 4);
    damaged.fill(0, mdat + 4, Math.min(end, damaged.length));

    // 元数据探测仍通过：所以「探测通过」不等于「文件没问题」。
    const brokenFile = path.join(dir, 'broken.mp4');
    fs.writeFileSync(brokenFile, damaged);
    const brokenInfo = await probeMedia({ tools: realTools!, file: brokenFile });
    expect(brokenInfo, '坏样本必须有可读的元数据，否则这条用例没意义').not.toBeNull();
    expect(Math.min(brokenInfo!.w, brokenInfo!.h)).toBe(360);
    expect(brokenInfo!.duration).toBeGreaterThan(0);

    dynamicRoutes.set('/real-valid.mp4', () => fs.readFileSync(valid));
    dynamicRoutes.set('/real-broken.mp4', () => fs.readFileSync(brokenFile));

    const host = { temporaryDir: () => dir, logger: () => ({ warn: () => {} }) };
    // 坏样本：解码校验失败，什么都不留
    const badOutput = path.join(dir, 'bad.mp4');
    await expect(
      downloadEpisode({
        vid: '11',
        playInfo: playInfo('/real-broken.mp4'),
        outputPath: badOutput,
        tools: realTools!,
        host,
        recover: false,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
    expect(fs.existsSync(badOutput)).toBe(false);

    // 健康样本：同一套流程能成功，实际清晰度来自真实探测
    const goodOutput = path.join(dir, 'good.mp4');
    const result = await downloadEpisode({
      vid: '11',
      playInfo: playInfo('/real-valid.mp4'),
      outputPath: goodOutput,
      tools: realTools!,
      host,
      recover: false,
    });
    expect(result.actualQuality).toBe('360p');
    expect(fs.readFileSync(goodOutput).equals(bytes)).toBe(true);
  });
});

describe('来源访问复核（对应旧检查 check-source-integration 的权限部分）', () => {
  const SOURCE_ID = 'a066a170-46e7-47aa-9c87-6364d8483e87';
  const customVid = `custom:${SOURCE_ID}:1:0:0`;

  function initStore(options: { enabled: boolean }): void {
    const dir = tempDir();
    store.init(path.join(dir, 'data.json'));
    store.saveSettings({
      ...(store.getSettings() as object),
      custom_sources: [
        { id: SOURCE_ID, name: '夹具源', url: 'https://fixture.example/api', enabled: options.enabled },
      ],
    } as never);
  }

  it('已存在的成品也不能绕过「来源已停用」：排队任务必须失败，文件保留', async () => {
    initStore({ enabled: false });
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    fs.writeFileSync(output, 'user file');
    await expect(
      downloadEpisode({
        vid: customVid,
        seriesId: `custom:${SOURCE_ID}:1`,
        playInfo: playInfo('/media'),
        outputPath: output,
        tools: h.tools,
        host: h.host,
      }),
    ).rejects.toThrow(/禁用|删除/);
    // 失败但不动已有文件
    expect(fs.readFileSync(output).toString()).toBe('user file');
    expect(hits).toEqual([]);
  });

  it('来源启用时照常下载自定义源片源', async () => {
    initStore({ enabled: true });
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const result = await downloadEpisode({
      vid: customVid,
      seriesId: `custom:${SOURCE_ID}:1`,
      playInfo: playInfo('/media'),
      outputPath: output,
      tools: h.tools,
      host: h.host,
    });
    expect(result.actualQuality).toBe('1080p');
    expect(fs.readFileSync(output).toString()).toBe('complete-media');
  });

  it('锁定的分集直接失败，不发布、不留临时文件', async () => {
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    await expect(
      downloadEpisode({
        vid: 'hema:1:2',
        seriesId: 'hema:1',
        playInfo: { url: null, locked: true, error: '该集已锁定', source: 'hema' } as never,
        outputPath: output,
        tools: h.tools,
        host: h.host,
        recover: false,
      }),
    ).rejects.toThrow(/锁定/);
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });

  it('已锁定来源在发布前再复核一次（取流期间被停用的自定义源不会被写进成品）', async () => {
    initStore({ enabled: true });
    const h = fixture();
    const output = path.join(h.dir, 'out.mp4');
    const pending = downloadEpisode({
      vid: customVid,
      seriesId: `custom:${SOURCE_ID}:1`,
      playInfo: playInfo('/media', { source: 'custom' }),
      outputPath: output,
      tools: h.tools,
      host: h.host,
      // 下载完成、发布之前把源停用
      onProgress: (progress) => {
        if (progress.phase === 'verifying') {
          store.saveSettings({
            ...(store.getSettings() as object),
            custom_sources: [
              { id: SOURCE_ID, name: '夹具源', url: 'https://fixture.example/api', enabled: false },
            ],
          } as never);
        }
      },
    });
    await expect(pending).rejects.toThrow(/禁用|删除/);
    expect(fs.existsSync(output)).toBe(false);
    expect(leftovers(h.dir)).toEqual([]);
  });
});
