/**
 * 解密任务（迁移自 4.5 `src/native/decrypt-worker.cjs`）。
 * 重点：计算在 worker 里（取消可生效）、取消后等 worker 真正停下来、
 * 错误要收敛成「片源坏了」而不是把底层异常漏给用户。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptBufferInWorker, decryptContentKeyFile, decryptFileInWorker } from './decrypt.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-decrypt-'));
  dirs.push(dir);
  return dir;
}

function workerScript(dir: string, body: string): string {
  const file = path.join(dir, 'worker.cjs');
  fs.writeFileSync(file, body);
  return file;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('decryptFileInWorker', () => {
  it('在 worker 里把源文件处理成目标文件，源文件不动', async () => {
    const dir = tempDir();
    const workerPath = workerScript(
      dir,
      `const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
fs.writeFileSync(workerData.dstPath, fs.readFileSync(workerData.srcPath));
parentPort.postMessage({ done: true });`,
    );
    const srcPath = path.join(dir, 'a.enc');
    const dstPath = path.join(dir, 'a.mp4');
    fs.writeFileSync(srcPath, 'encrypted');
    await decryptFileInWorker({ srcPath, dstPath, key: [1, 2, 3] }, { workerPath });
    expect(fs.readFileSync(dstPath).toString()).toBe('encrypted');
    expect(fs.readFileSync(srcPath).toString()).toBe('encrypted');
  });

  it('worker 回报错误 → MEDIA_DECODE_ERROR（可重试的片源问题）', async () => {
    const dir = tempDir();
    const workerPath = workerScript(
      dir,
      `require('node:worker_threads').parentPort.postMessage({ error: '样本损坏' });`,
    );
    await expect(
      decryptFileInWorker({ srcPath: '/x', dstPath: '/y', key: [1] }, { workerPath }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
  });

  it('worker 直接崩掉也能收敛成错误，不会挂着', async () => {
    const dir = tempDir();
    const workerPath = workerScript(dir, 'process.exit(2);');
    await expect(
      decryptFileInWorker({ srcPath: '/x', dstPath: '/y', key: [1] }, { workerPath }),
    ).rejects.toThrow(/视频解密意外中断/);
  });

  it('缺少 worker 脚本路径时明确报工具错误', async () => {
    await expect(decryptFileInWorker({ srcPath: '/x', dstPath: '/y', key: [1] })).rejects.toMatchObject({
      code: 'LOCAL_MEDIA_TOOL_ERROR',
    });
  });

  it('已取消的信号不启动 worker；运行中取消也能结束', async () => {
    const dir = tempDir();
    const workerPath = workerScript(
      dir,
      `const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
setTimeout(() => { fs.writeFileSync(workerData.dstPath, 'late'); parentPort.postMessage({ done: true }); }, 5000);`,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      decryptFileInWorker({ srcPath: '/x', dstPath: '/y', key: [1] }, { workerPath, signal: aborted.signal }),
    ).rejects.toMatchObject({ code: 'CANCELED' });

    const controller = new AbortController();
    const dstPath = path.join(dir, 'slow.mp4');
    const pending = decryptFileInWorker(
      { srcPath: '/x', dstPath, key: [1] },
      { workerPath, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(dstPath)).toBe(false);
  });
});

describe('decryptBufferInWorker', () => {
  it('buffer 经 Transferable 回传', async () => {
    const dir = tempDir();
    const workerPath = workerScript(
      dir,
      `const { parentPort, workerData } = require('node:worker_threads');
const source = Buffer.from(workerData.buffer);
const copy = new Uint8Array(source.length);
for (let i = 0; i < source.length; i++) copy[i] = source[i] ^ 0xff;
parentPort.postMessage({ buffer: copy.buffer }, [copy.buffer]);`,
    );
    const buffer = Buffer.from([0x00, 0x0f, 0xf0, 0xff]);
    const result = await decryptBufferInWorker({ buffer, key: [9] }, { workerPath });
    expect([...result]).toEqual([0xff, 0xf0, 0x0f, 0x00]);
    // 入参不被就地改写
    expect([...buffer]).toEqual([0x00, 0x0f, 0xf0, 0xff]);
  });

  it('worker 没返回数据时报错', async () => {
    const dir = tempDir();
    const workerPath = workerScript(
      dir,
      `require('node:worker_threads').parentPort.postMessage({ done: true });`,
    );
    await expect(
      decryptBufferInWorker({ buffer: Buffer.alloc(4), key: [1] }, { workerPath }),
    ).rejects.toThrow(/没有返回数据/);
  });
});

describe('decryptContentKeyFile', () => {
  it('密钥格式非法直接拒绝（不把用户输入的脏值交给 ffmpeg）', async () => {
    await expect(
      decryptContentKeyFile(
        { input: '/x', output: '/y', contentKey: 'not-a-key' },
        { ffmpeg: '/bin/ffmpeg' },
      ),
    ).rejects.toMatchObject({ code: 'SECURITY_BLOCKED' });
  });

  it('没有内置 FFmpeg 时明确报工具错误', async () => {
    await expect(
      decryptContentKeyFile(
        { input: '/x', output: '/y', contentKey: '00112233445566778899aabbccddeeff' },
        { ffmpeg: null },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_MEDIA_TOOL_ERROR' });
  });

  it('解密成功产出非空文件', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
printf 'decrypted' > "$out"`,
    );
    await decryptContentKeyFile(
      { input: path.join(dir, 'in.enc'), output, contentKey: '00112233445566778899aabbccddeeff' },
      { ffmpeg },
    );
    expect(fs.readFileSync(output).toString()).toBe('decrypted');
  });

  it('FFmpeg 失败时报 MEDIA_DECODE_ERROR，并删掉没写完的输出', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
printf 'partial' > "$out"
echo "decrypt failed" >&2
exit 3`,
    );
    await expect(
      decryptContentKeyFile(
        { input: path.join(dir, 'in.enc'), output, contentKey: '00112233445566778899aabbccddeeff' },
        { ffmpeg },
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_DECODE_ERROR' });
    expect(fs.existsSync(output)).toBe(false);
  });

  it('解密中途取消：杀掉子进程、删掉没写完的输出、报 CANCELED', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  case "$arg" in /*) out="$arg";; esac
done
printf 'partial' > "$out"
sleep 5`,
    );
    const controller = new AbortController();
    const pending = decryptContentKeyFile(
      { input: path.join(dir, 'in.enc'), output, contentKey: '00112233445566778899aabbccddeeff' },
      { ffmpeg, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fs.existsSync(output)).toBe(false);
  });

  it('失败信息里不出现解密密钥（日志与界面都不该泄漏）', async () => {
    const dir = tempDir();
    const key = '00112233445566778899aabbccddeeff';
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  case "$arg" in /*) out="$arg";; esac
done
echo "bad media for key ${key}" >&2
exit 1`,
    );
    const error = await decryptContentKeyFile(
      { input: path.join(dir, 'in.enc'), output: path.join(dir, 'out.mp4'), contentKey: key },
      { ffmpeg },
    ).catch((cause: Error) => cause);
    expect((error as Error).message).not.toContain(key);
    expect((error as Error).message).toMatch(/媒体解密失败/);
  });

  it('产出空文件也算失败', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'out.mp4');
    const ffmpeg = script(
      dir,
      'ffmpeg',
      `out=""
for arg in "$@"; do
  # 产物路径总是一个绝对路径；-f/-progress/pipe:1 这些参数不是。
  case "$arg" in /*) out="$arg";; esac
done
: > "$out"`,
    );
    await expect(
      decryptContentKeyFile(
        { input: path.join(dir, 'in.enc'), output, contentKey: '00112233445566778899aabbccddeeff' },
        { ffmpeg },
      ),
    ).rejects.toThrow(/没有生成可用文件/);
  });
});
