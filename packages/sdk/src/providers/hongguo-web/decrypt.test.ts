/**
 * CENC 解密原语（迁移自 4.5 `scripts/check-decrypt-worker.cjs` 的等价性与错误断言）。
 *
 * 注意：4.5 把解密放在 worker_threads 里跑，这里有两条能力**尚未恢复**（已记入
 * docs/refactor-status.md 的功能缺口）：解密期间不 yield 事件循环、也不支持取消。
 * 因此本文件只覆盖「结果正确性」与「错误可控」，取消/让出仍由旧检查兜着。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptMp4Buffer, decryptMp4File } from './player.ts';

/** 最小的合法 moov（无加密样本），与旧检查用的是同一份构造。 */
const EMPTY_MOOV = Buffer.from([0, 0, 0, 8, 109, 111, 111, 118]);

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-decrypt-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('decryptMp4Buffer', () => {
  it('没有加密样本时原样返回（等价性）', () => {
    expect(decryptMp4Buffer(EMPTY_MOOV, Buffer.alloc(16))).toEqual(EMPTY_MOOV);
  });

  it('缺少 moov 时报可判断的错误，而不是崩溃或静默返回空', () => {
    expect(() => decryptMp4Buffer(Buffer.from('invalid'), Buffer.alloc(16))).toThrow(
      /moov|bounds|offset|MP4/i,
    );
    expect(() => decryptMp4Buffer(Buffer.alloc(0), Buffer.alloc(16))).toThrow();
  });

  it('没有加密样本时密钥根本用不上，短密钥也不会报错（与 4.5 一致）', () => {
    // 密钥只在真正解样本时被消费；离线没有加密夹具，所以这里断言的是“不会误报”。
    expect(decryptMp4Buffer(EMPTY_MOOV, Buffer.alloc(8))).toEqual(EMPTY_MOOV);
  });
});

describe('decryptMp4File', () => {
  it('写出目标文件，源文件保持不变', () => {
    const dir = tempDir();
    const src = path.join(dir, 'input.mp4');
    const dst = path.join(dir, 'out.mp4');
    const inputs = [
      { label: 'empty', value: Buffer.from([0, 0, 0, 8, 109, 111, 111, 118]) },
      {
        label: 'moov+free',
        value: Buffer.concat([
          Buffer.from([0, 0, 0, 8, 109, 111, 111, 118]),
          Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]),
        ]),
      },
    ];
    fs.writeFileSync(src, inputs[0]!.value);
    decryptMp4File(src, dst, Buffer.alloc(16));
    expect(fs.readFileSync(dst)).toEqual(inputs[0]!.value);

    fs.writeFileSync(src, inputs[1]!.value);
    decryptMp4File(src, dst, Buffer.alloc(16));
    expect(fs.readFileSync(dst)).toEqual(inputs[1]!.value);
    expect(fs.readFileSync(src)).toEqual(inputs[1]!.value);
  });

  it('源文件不存在时抛错且不创建目标文件', () => {
    const dir = tempDir();
    const dst = path.join(dir, 'out.mp4');
    expect(() => decryptMp4File(path.join(dir, 'missing.mp4'), dst, Buffer.alloc(16))).toThrow();
    expect(fs.existsSync(dst)).toBe(false);
  });
});
