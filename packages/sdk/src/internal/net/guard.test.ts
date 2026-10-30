/**
 * 出站请求安全闸门（迁移自 4.5 `scripts/check-web-media-guard.cjs` 的核心断言）。
 *
 * 这些断言保护的是 SSRF 面：私网/链路本地/保留网段、带凭据的 URL、非 http(s) 协议
 * 都必须在发起请求之前被拒。属于不能退让的安全契约。
 */
import { describe, expect, it } from 'vitest';
import { isPublicMediaUrl, webMediaRequestOptions } from './guard.ts';

describe('isPublicMediaUrl：只放行公网 http(s)', () => {
  it('放行公网地址（含端口与路径）', () => {
    for (const url of [
      'https://hongguoduanju.com/api/search/result?q=1',
      'https://p3-novel.byteimg.com/novel-pic/a.jpg',
      'https://example.com:8443/a/b.mp4',
      'http://example.com/plain',
    ]) {
      expect(isPublicMediaUrl(url)).toBe(true);
    }
  });

  it('拒绝 IPv4 私网与保留网段', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.1.1/',
      'http://172.16.5.5/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://198.18.0.1/',
      'http://224.0.0.1/',
    ]) {
      expect(isPublicMediaUrl(url)).toBe(false);
    }
  });

  it('拒绝 IPv6 回环、唯一本地与文档段', () => {
    for (const url of ['http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[2001:db8::1]/']) {
      expect(isPublicMediaUrl(url)).toBe(false);
    }
  });

  it('拒绝带账号密码、非 http(s) 协议与畸形输入', () => {
    for (const url of [
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'file:///etc/passwd',
      'ftp://example.com/a.mp4',
      'data:text/plain,hi',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isPublicMediaUrl(url)).toBe(false);
    }
  });

  it('webMediaRequestOptions 对不安全地址在建立连接前就抛错', () => {
    expect(() => webMediaRequestOptions('http://127.0.0.1/a.mp4')).toThrow();
    expect(() => webMediaRequestOptions('https://user:pass@example.com/a.mp4')).toThrow();
  });

  it('webMediaRequestOptions 对公网地址返回受控的请求选项', () => {
    const options = webMediaRequestOptions('https://example.com/a.mp4') as Record<string, unknown>;
    expect(options).toBeTypeOf('object');
    expect(Number(options.maxRedirects)).toBeLessThanOrEqual(5);
  });

  it('trustedOfficialDns 只接受官网源站', () => {
    expect(() => webMediaRequestOptions('https://example.com/a.mp4', { trustedOfficialDns: true })).toThrow();
    expect(() =>
      webMediaRequestOptions('https://hongguoduanju.com/a.mp4', { trustedOfficialDns: true }),
    ).not.toThrow();
  });
});
