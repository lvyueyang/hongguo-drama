/**
 * 弹幕签名器黄金向量（迁移自 4.5 `src/native/danmaku-sign.test.cjs`）。
 *
 * 签名算法没有官方文档：唯一能证明移植正确的办法是拿参考实现
 * （`nas-backend/danmaku.py`，仓库外）在固定输入下的输出逐字节比对。
 * 向量由 `scripts/gen-danmaku-sign-vectors.py` 生成，可复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sign from './danmaku-sign.ts';

const fixturePath = path.resolve(process.cwd(), 'scripts/fixtures/danmaku-sign-vectors.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  source: string;
  vectors: Array<Record<string, string>>;
};

describe('弹幕签名黄金向量', () => {
  it('向量文件记录了参考实现来源，避免用到来路不明的期望值', () => {
    expect(fixture.source).toBe('nas-backend/danmaku.py');
    expect(Array.isArray(fixture.vectors)).toBe(true);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
  });

  it('构建出的 raw query 与参考实现一致（含排序与编码）', () => {
    for (const vector of fixture.vectors) {
      const actual = sign.buildQuery({
        stampMs: Number(vector.stamp_ms),
        deviceId: vector.device_id,
        installId: vector.install_id,
      });
      expect(actual).toBe(vector.raw_query);
    }
  });

  it('X-Gorgon / X-Ladon / X-Argus 与参考实现逐字节一致', () => {
    for (const vector of fixture.vectors) {
      const nonce = Buffer.from(vector.nonce_hex, 'hex');
      const stamp = Number(vector.stamp);
      expect(sign.commentXGorgon(vector.raw_query, stamp, nonce)).toBe(vector.x_gorgon);
      expect(sign.commentLadon(vector.aid, stamp, nonce.subarray(2, 6))).toBe(vector.x_ladon);
      expect(sign.commentArgus(vector.raw_query, stamp, nonce)).toBe(vector.x_argus);
    }
  });

  it('签名结果随 query、时间戳与各自 nonce 段变化（防止退化成常量）', () => {
    const nonce = Buffer.from('000102030405060708090a', 'hex');
    const base = sign.commentXGorgon('a=1', 1760000000, nonce);
    expect(sign.commentXGorgon('a=2', 1760000000, nonce)).not.toBe(base);
    expect(sign.commentXGorgon('a=1', 1760000001, nonce)).not.toBe(base);
    expect(sign.commentXGorgon('a=1', 1760000000, Buffer.from('010102030405060708090a', 'hex'))).not.toBe(
      base,
    );
  });
});
