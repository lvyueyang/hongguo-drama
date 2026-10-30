/**
 * CENC 加密 MP4 的编码还原（迁移自 4.5 `scripts/check-review-native-2-5.cjs` 的样片条目部分）。
 *
 * 合成容器只搭 moov/trak/mdia/minf/stbl/stsd 这一条最短链路，不需要 FFmpeg 或真实样片：
 *   1) 解密后 encv/enca 要换回原始编码（frma 优先，其次按 avcC/hvcC 推断）；
 *   2) sig/解码配置盒子必须保留，sinf 必须去掉，stsd 尺寸自洽；
 *   3) 编码含糊（两套配置、frma 与配置矛盾、未知编码）宁可报错，不猜。
 */
import { describe, expect, it } from 'vitest';
import { decryptMp4Buffer } from './player.ts';

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function encryptedContainer(format: string | null, configs: string[] = ['avcC'], entryType = 'encv'): Buffer {
  const entry = box(
    entryType,
    Buffer.alloc(entryType === 'encv' ? 78 : 28),
    ...configs.map((type) => box(type, Buffer.from([1, 2, 3, 4]))),
    box('sinf', ...(format ? [box('frma', Buffer.from(format))] : [])),
  );
  const count = Buffer.alloc(8);
  count.writeUInt32BE(1, 4);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', count, entry))))));
}

function restoredEntry(
  format: string | null,
  configs: string[],
  entryType = 'encv',
): { codec: string; bytes: Buffer } {
  const bytes = decryptMp4Buffer(encryptedContainer(format, configs, entryType), Buffer.alloc(16));
  const stsd = bytes.indexOf(Buffer.from('stsd'));
  expect(stsd).toBeGreaterThanOrEqual(0);
  expect(bytes.includes(Buffer.from('sinf'))).toBe(false);
  expect(bytes.readUInt32BE(stsd + 12)).toBe(bytes.length - (stsd + 12));
  return { codec: bytes.toString('latin1', stsd + 16, stsd + 20), bytes };
}

describe('加密样片条目还原', () => {
  it('frma 给出的原始编码被保留，解码配置不丢', () => {
    for (const [format, configs] of [
      ['avc1', ['avcC']],
      ['avc3', ['avcC']],
      ['hvc1', ['hvcC']],
      ['hev1', ['hvcC']],
    ] as Array<[string, string[]]>) {
      const result = restoredEntry(format, configs);
      expect(result.codec).toBe(format);
      expect(result.bytes.includes(Buffer.from(configs[0]!))).toBe(true);
    }
  });

  it('没有 frma 时按解码配置推断，音频轨用 mp4a', () => {
    expect(restoredEntry(null, ['avcC']).codec).toBe('avc1');
    expect(restoredEntry(null, ['hvcC']).codec).toBe('hvc1');
    expect(restoredEntry('mp4a', ['esds'], 'enca').codec).toBe('mp4a');
  });

  it('编码含糊或未知时直接报错，不猜', () => {
    for (const [format, configs] of [
      [null, []],
      [null, ['avcC', 'hvcC']],
      ['avc1', ['hvcC']],
      ['hvc1', ['avcC']],
      ['av01', ['av1C']],
    ] as Array<[string | null, string[]]>) {
      expect(() => restoredEntry(format, configs), JSON.stringify([format, configs])).toThrow(/codec|编码/i);
    }
  });

  it('没有 moov 容器的输入明确报错', () => {
    expect(() => decryptMp4Buffer(box('ftyp', Buffer.alloc(4)), Buffer.alloc(16))).toThrow(/moov/);
  });
});
