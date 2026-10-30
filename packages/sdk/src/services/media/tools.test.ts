/**
 * 本地媒体工具（替代 4.5 `main.js` 的 resolveFfmpeg / probeVideoInfo / publishMergedOutput）。
 * 重点：工具缺失必须与片源损坏区分开、发布绝不覆盖已有文件、编码器要真的编得动才算可用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEncoderPicker,
  probeDuration,
  probeMedia,
  publishFile,
  resolveMediaTools,
  runTool,
  shortEdge,
  spawnTool,
} from './tools.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-tools-'));
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

const EMPTY_TOOLS = { ffmpeg: null, ffprobe: null, supportsHttp: false };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveMediaTools', () => {
  it('从宿主取路径；宿主缺失或抛错都收敛成 null，不让启动因为工具探测失败', () => {
    expect(
      resolveMediaTools({
        ffmpeg: () => ({ ffmpeg: () => '/bin/ffmpeg', ffprobe: () => '/bin/ffprobe', supportsHttp: false }),
      }),
    ).toEqual({ ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe', supportsHttp: false });
    expect(resolveMediaTools({ ffmpeg: () => null })).toEqual(EMPTY_TOOLS);
    expect(resolveMediaTools(undefined)).toEqual(EMPTY_TOOLS);
    expect(
      resolveMediaTools({
        ffmpeg: () => {
          throw new Error('没有 resourcesPath');
        },
      }),
    ).toEqual(EMPTY_TOOLS);
  });
});

describe('runTool', () => {
  it('正常退出返回 stdout/code', async () => {
    const result = await runTool(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(result).toMatchObject({ code: 0, stdout: 'hi', killed: false });
  });

  it('工具本身起不来 → LOCAL_MEDIA_TOOL_ERROR（不是「文件坏了」）', async () => {
    await expect(runTool('/nonexistent/hongguo-ffprobe', [])).rejects.toMatchObject({
      code: 'LOCAL_MEDIA_TOOL_ERROR',
    });
  });

  it('非零退出码带回来，交给调用方判断（不代表工具坏了）', async () => {
    const result = await runTool(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('bad');
    expect(result.killed).toBe(false);
  });

  it('超时被杀掉，标记 killed', async () => {
    const result = await runTool(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 50 });
    expect(result.killed).toBe(true);
  });

  it('已取消的信号不会启动进程', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTool(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
  });
});

describe('probeMedia', () => {
  it('解析 ffprobe 输出（分辨率/时长/编码）', async () => {
    const dir = tempDir();
    const ffprobe = script(dir, 'ffprobe', `cat <<'EOF'\n${probeJson(1080, 1920)}\nEOF`);
    const info = await probeMedia({ tools: { ...EMPTY_TOOLS, ffprobe }, file: '/x.mp4' });
    expect(info).toMatchObject({ codec: 'h264', w: 1080, h: 1920, duration: 12 });
  });

  it('没有 ffprobe：默认返回 null，要求「工具错误必须报错」时抛 LOCAL_MEDIA_TOOL_ERROR', async () => {
    expect(await probeMedia({ tools: EMPTY_TOOLS, file: '/x.mp4' })).toBeNull();
    await expect(
      probeMedia({ tools: EMPTY_TOOLS, file: '/x.mp4', rejectToolErrors: true }),
    ).rejects.toMatchObject({ code: 'LOCAL_MEDIA_TOOL_ERROR' });
  });

  it('ffprobe 读不出来（非零退出）返回 null；路径不存在时按工具错误处理', async () => {
    const dir = tempDir();
    const broken = script(dir, 'ffprobe', 'exit 1');
    expect(await probeMedia({ tools: { ...EMPTY_TOOLS, ffprobe: broken }, file: '/x.mp4' })).toBeNull();
    await expect(
      probeMedia({
        tools: { ...EMPTY_TOOLS, ffprobe: '/nonexistent/ffprobe' },
        file: '/x.mp4',
        rejectToolErrors: true,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_MEDIA_TOOL_ERROR' });
  });

  it('没有视频轨（例如只有音频）返回 null', async () => {
    const dir = tempDir();
    const ffprobe = script(
      dir,
      'ffprobe',
      `cat <<'EOF'\n${JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '3' } })}\nEOF`,
    );
    expect(await probeMedia({ tools: { ...EMPTY_TOOLS, ffprobe }, file: '/a.m4a' })).toBeNull();
  });
});

describe('probeDuration', () => {
  it('读时长；工具缺失或输出无法解析返回 0', async () => {
    const dir = tempDir();
    const ffprobe = script(dir, 'ffprobe', 'echo 12.5');
    expect(await probeDuration({ ...EMPTY_TOOLS, ffprobe }, '/x.mp4')).toBe(12.5);
    expect(await probeDuration(EMPTY_TOOLS, '/x.mp4')).toBe(0);
    const garbage = script(dir, 'ffprobe2', 'echo nonsense');
    expect(await probeDuration({ ...EMPTY_TOOLS, ffprobe: garbage }, '/x.mp4')).toBe(0);
  });
});

describe('publishFile', () => {
  it('发布后内容一致', () => {
    const dir = tempDir();
    const source = path.join(dir, 'a.tmp');
    const destination = path.join(dir, 'a.mp4');
    fs.writeFileSync(source, 'media');
    publishFile(source, destination);
    expect(fs.readFileSync(destination).toString()).toBe('media');
  });

  it('目标已存在时失败，绝不覆盖用户文件', () => {
    const dir = tempDir();
    const source = path.join(dir, 'a.tmp');
    const destination = path.join(dir, 'a.mp4');
    fs.writeFileSync(source, 'new');
    fs.writeFileSync(destination, 'user file');
    expect(() => publishFile(source, destination)).toThrow();
    expect(fs.readFileSync(destination).toString()).toBe('user file');
  });

  it('硬链接不可用（FAT/exFAT 之类）时退回独占复制', () => {
    const dir = tempDir();
    const source = path.join(dir, 'a.tmp');
    const destination = path.join(dir, 'a.mp4');
    fs.writeFileSync(source, 'media');
    const original = fs.linkSync;
    (fs as any).linkSync = () => {
      throw Object.assign(new Error('hard link unavailable'), { code: 'ENOTSUP' });
    };
    try {
      publishFile(source, destination);
    } finally {
      (fs as any).linkSync = original;
    }
    expect(fs.readFileSync(destination).toString()).toBe('media');
  });
});

describe('createEncoderPicker', () => {
  it('列表里有但编不动的不算数，回退到 libx264', async () => {
    const dir = tempDir();
    const log = path.join(dir, 'calls.log');
    process.env.HONGGUO_FAKE_LOG = log;
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `echo "$*" >> "$HONGGUO_FAKE_LOG"
case "$*" in
  *-encoders*) printf 'h264_videotoolbox h264_nvenc libx264\\n'; exit 0;;
  *libx264*) exit 0;;
  *) exit 1;;
esac`,
    );
    try {
      const pick = createEncoderPicker({ ...EMPTY_TOOLS, ffmpeg });
      expect(await pick()).toBe('libx264');
      const afterFirst = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(afterFirst.length).toBeGreaterThan(1);
      // 结果缓存：第二次不再起进程
      expect(await pick()).toBe('libx264');
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(afterFirst.length);
    } finally {
      delete process.env.HONGGUO_FAKE_LOG;
    }
  });

  it('没有 ffmpeg 时明确报工具错误', async () => {
    const pick = createEncoderPicker(EMPTY_TOOLS);
    await expect(pick()).rejects.toMatchObject({ code: 'LOCAL_MEDIA_TOOL_ERROR' });
  });
});

describe('spawnTool', () => {
  it('拿得到退出码与输出，stop 后进程会结束', async () => {
    let stdout = '';
    const tool = spawnTool(process.execPath, ['-e', 'process.stdout.write("out");process.exit(2)'], {
      onStdout: (chunk) => {
        stdout += chunk;
      },
    });
    expect(await tool.done).toBe(2);
    expect(stdout).toBe('out');

    const long = spawnTool(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    long.stop();
    // 被信号结束：没有退出码，统一给 -1（调用方只需要知道「不是 0」）
    await expect(long.done).resolves.toBe(-1);
  });
});

describe('shortEdge', () => {
  it('复用 shared 的短边规则', () => {
    expect(shortEdge({ width: 1920, height: 1080 })).toBe(1080);
    expect(shortEdge({ width: 1080, height: 1920 })).toBe(1080);
    expect(shortEdge({ pixels: 720 })).toBe(720);
  });
});
