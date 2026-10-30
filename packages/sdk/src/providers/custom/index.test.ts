/**
 * 自定义源配置校验（迁移自 4.5 `scripts/check-custom-source.cjs` 的校验部分）。
 * 自定义源是用户填的公网地址，因此这里是 SSRF 的第一道门。
 */
import { describe, expect, it } from 'vitest';
import customSource from './index.ts';

// validateSource 只在默认导出对象上（4.5 的 module.exports 里混有别名，无法全量转具名导出）
const { validateSource } = customSource;

const UUID = '0b9c1a2e-1111-2222-3333-444455556666';

describe('validateSource（配置校验）', () => {
  it('接受公网地址，并把根路径补成苹果 CMS 默认路径', () => {
    const source = validateSource({ name: '我的源', url: 'https://example.com/' });
    expect(source.url).toBe('https://example.com/api.php/provide/vod/');
    expect(source.enabled).toBe(true);
  });

  it('已经带路径的地址不被改写，去掉 hash', () => {
    const source = validateSource({ name: '我的源', url: 'https://example.com/api.php/provide/vod/#x' });
    expect(source.url).toBe('https://example.com/api.php/provide/vod/');
  });

  it('拒绝私网、带凭据与非 http(s) 地址', () => {
    for (const url of [
      'http://127.0.0.1/api',
      'http://192.168.1.10/api',
      'http://169.254.169.254/latest/meta-data',
      'https://user:pass@example.com/api',
      'file:///etc/passwd',
    ]) {
      expect(() => validateSource({ name: '源', url })).toThrow(/公网/);
    }
  });

  it('名称长度 1–80，编号必须是 UUID', () => {
    expect(() => validateSource({ name: '', url: 'https://example.com/' })).toThrow(/名称/);
    expect(() => validateSource({ name: 'A'.repeat(81), url: 'https://example.com/' })).toThrow(/名称/);
    expect(() => validateSource({ name: '源', url: 'https://example.com/', id: 'not-a-uuid' })).toThrow(
      /编号/,
    );
    expect(validateSource({ name: '源', url: 'https://example.com/', id: UUID.toUpperCase() }).id).toBe(UUID);
  });

  it('配置不是对象时直接拒绝', () => {
    for (const draft of [null, undefined, 42, 'x']) {
      expect(() => validateSource(draft as never)).toThrow(/配置无效/);
    }
  });

  it('超长地址被拒绝（防止把配置当载荷）', () => {
    expect(() => validateSource({ name: '源', url: `https://example.com/${'a'.repeat(5000)}` })).toThrow();
  });
});
