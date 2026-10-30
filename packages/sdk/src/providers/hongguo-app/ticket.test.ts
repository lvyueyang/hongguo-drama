/**
 * App 签名请求的输入校验与请求形态（迁移自 4.5 `scripts/check-app-source.cjs` 的校验部分）。
 *
 * SM3 向量已由 `internal/crypto/sm3.test.ts` 覆盖；这里守的是另两条边界：
 * - 设备身份必须形如 19 位数字 / UUID，否则不生成签名（避免把坏身份发给上游）；
 * - 元数据与账号接口的**路径白名单**，防止被改造成任意接口代理。
 */
import { describe, expect, it } from 'vitest';
import { signedAccountRequest, signedMetadataRequest, signedSearchRequest } from './ticket.ts';

const identity = {
  device_id: '1000000000000000001',
  iid: '1000000000000000002',
  cdid: '0b9c1a2e-1111-2222-3333-444455556666',
};

describe('signedSearchRequest', () => {
  it('返回带完整签名头的 URL', () => {
    const { url, headers } = signedSearchRequest({ keyword: '修仙', identity }) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(url.startsWith('https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v?')).toBe(
      true,
    );
    for (const name of ['x-gorgon', 'x-ladon', 'x-argus', 'x-helios', 'x-medusa', 'x-khronos']) {
      expect(headers[name]).toBeTruthy();
    }
    expect(new URL(url).searchParams.get('query')).toBe('修仙');
  });

  it('页码越界与身份非法都不生成请求', () => {
    expect(() => signedSearchRequest({ keyword: 'a', page: 0, identity })).toThrow(/页码/);
    expect(() => signedSearchRequest({ keyword: 'a', page: 51, identity })).toThrow(/页码/);
    expect(() => signedSearchRequest({ keyword: 'a', identity: { ...identity, device_id: 'x' } })).toThrow(
      /身份/,
    );
    expect(() => signedSearchRequest({ keyword: 'a', identity: { ...identity, cdid: 'nope' } })).toThrow(
      /身份/,
    );
    expect(() => signedSearchRequest({ keyword: 'a' })).toThrow(/身份/);
  });

  it('关键词被截断到 80 字，避免把超长输入塞进查询串', () => {
    const { url } = signedSearchRequest({ keyword: '红'.repeat(200), identity }) as { url: string };
    expect(new URL(url).searchParams.get('query')?.length).toBeLessThanOrEqual(80);
  });
});

describe('signedMetadataRequest：路径白名单', () => {
  it('只放行两个目录接口', () => {
    for (const path of [
      '/reading/distribution/category/landpage/v/',
      '/reading/bookapi/bookmall/cell/change/v',
    ]) {
      expect(() => signedMetadataRequest(path)).not.toThrow();
    }
    for (const path of [
      '/reading/bookapi/search/tab/v',
      '/novel/player/multi_video_model/v1/',
      '/anything',
    ]) {
      expect(() => signedMetadataRequest(path)).toThrow(/不支持/);
    }
  });

  it('元数据接口带 x-ss-dp 与签名头', () => {
    const { url, headers } = signedMetadataRequest('/reading/bookapi/bookmall/cell/change/v') as {
      url: string;
      headers: Record<string, string>;
    };
    expect(url.startsWith('https://api5-normal-sinfonlineb.fqnovel.com')).toBe(true);
    expect(headers['x-ss-dp']).toBe('8662');
    expect(headers['x-gorgon']).toBeTruthy();
  });
});

describe('signedAccountRequest：路径白名单与身份校验', () => {
  it('只放行四个账号接口', () => {
    for (const path of [
      '/reading/user/info/v1/',
      '/reading/bookapi/read_history/list/v1/',
      '/reading/bookapi/read_progress/list/v1/',
      '/reading/bookapi/multi-detail/v1/',
    ]) {
      expect(() => signedAccountRequest(path, {}, identity)).not.toThrow();
    }
    expect(() => signedAccountRequest('/reading/bookapi/read_history/list/v2/', {}, identity)).toThrow(
      /不支持/,
    );
  });

  it('设备身份非法时拒绝', () => {
    expect(() => signedAccountRequest('/reading/user/info/v1/', {}, { ...identity, iid: '' })).toThrow(
      /身份/,
    );
    expect(() => signedAccountRequest('/reading/user/info/v1/', {}, {})).toThrow(/身份/);
  });
});
