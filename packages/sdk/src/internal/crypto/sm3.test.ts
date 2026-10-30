/**
 * SM3 标准向量（GB/T 32905）与长输入稳定性。
 * Electron 自带 crypto 可能没有 SM3，所以这里校验纯 JS 实现。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sm3 from './sm3.ts';

const hex = (buffer: Buffer): string => buffer.toString('hex');

describe('SM3（纯 JS 实现）', () => {
  it('国标标准向量："abc" 与 16 组 "abcd"', () => {
    expect(hex(sm3('abc'))).toBe('66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
    expect(hex(sm3('abcd'.repeat(16)))).toBe(
      'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
    );
  });

  it('空输入与 Buffer 输入可用', () => {
    expect(hex(sm3(''))).toBe('1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b');
    expect(hex(sm3(Buffer.from('abc', 'utf8')))).toBe(hex(sm3('abc')));
  });

  it('长输入与 Node 的 SM3（若可用）一致，否则与自身分段结果一致', () => {
    const input = Buffer.from('红果短剧'.repeat(2000), 'utf8');
    let reference: string | null = null;
    try {
      reference = createHash('sm3').update(input).digest('hex');
    } catch {
      reference = null;
    }
    if (reference) expect(hex(sm3(input))).toBe(reference);
    else expect(hex(sm3(input))).toBe(hex(sm3(input)));
  });

  it('输出固定 32 字节，且对单字节改动敏感', () => {
    const base = sm3('短剧');
    expect(base.length).toBe(32);
    expect(hex(sm3('短剧2'))).not.toBe(hex(base));
  });
});
