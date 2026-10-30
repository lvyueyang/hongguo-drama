/**
 * 代理解析（迁移自 4.5 `scripts/check-proxy-routing.cjs` 的核心断言）。
 * 不联网：只验证「设置 → 解析结果 → 环境变量/Chromium 规则/凭据」的映射。
 */
import { describe, expect, it } from 'vitest';
import {
  axiosProxyOption,
  buildProxyUrl,
  envWithProxy,
  PROXY_ENV_KEYS,
  resolveProxyConfig,
  ruleOf,
  snapshotProxyEnv,
  snapshotProxyUrl,
} from './proxy.ts';

const snapshot = snapshotProxyEnv({
  HTTP_PROXY: 'http://system-http:8080',
  HTTPS_PROXY: 'http://system-https:8443',
  NO_PROXY: 'localhost,127.0.0.1',
  PATH: '/usr/bin',
} as Record<string, string | undefined>);

describe('启停与模式', () => {
  it('未启用代理或 mode=direct 时一律直连', () => {
    expect(
      resolveProxyConfig(
        { proxy_enabled: false, proxy_mode: 'custom', proxy_host: 'h', proxy_port: 1 },
        snapshot,
      ),
    ).toEqual({
      mode: 'direct',
      url: null,
    });
    expect(resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'direct' }, snapshot).mode).toBe('direct');
  });

  it('system 只认传入的启动快照，进程环境被改写过也不受影响', () => {
    // 解析只读快照参数：调用方即便把已被改写的 env 传进来，也应当由快照决定结果。
    const resolved = resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'system' }, snapshot);
    expect(resolved.url).toBe('http://system-https:8443');
    expect(resolved.rule).toBe('http://system-https:8443');
  });

  it('快照里没有代理地址时 system 解析为无地址', () => {
    expect(resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'system' }, {})).toMatchObject({
      mode: 'system',
      url: null,
    });
  });
});

describe('buildProxyUrl / 自定义模式', () => {
  it('主机 + 端口组成规范地址', () => {
    expect(buildProxyUrl({ proxy_host: '127.0.0.1', proxy_port: '7890' })).toBe('http://127.0.0.1:7890');
    expect(buildProxyUrl({ proxy_host: 'http://proxy.local', proxy_port: 8080 })).toBe(
      'http://proxy.local:8080',
    );
  });

  it('粘贴完整地址时不重复追加端口', () => {
    expect(buildProxyUrl({ proxy_host: 'http://127.0.0.1:7890' })).toBe('http://127.0.0.1:7890');
    expect(buildProxyUrl({ proxy_host: 'socks5://127.0.0.1:1080' })).toBe('socks5://127.0.0.1:1080');
  });

  it('缺少主机、缺少端口或端口非法时视为不可用', () => {
    expect(buildProxyUrl({ proxy_host: '', proxy_port: '7890' })).toBeNull();
    expect(buildProxyUrl({ proxy_host: '127.0.0.1' })).toBeNull();
    expect(buildProxyUrl({ proxy_host: '127.0.0.1', proxy_port: '0' })).toBeNull();
    expect(buildProxyUrl({ proxy_host: '127.0.0.1', proxy_port: '70000' })).toBeNull();
    expect(buildProxyUrl({ proxy_host: '127.0.0.1', proxy_port: 'abc' })).toBeNull();
  });

  it('带凭据时编码进 URL，但不进入 Chromium 规则', () => {
    const resolved = resolveProxyConfig({
      proxy_enabled: true,
      proxy_mode: 'custom',
      proxy_host: '127.0.0.1',
      proxy_port: '7890',
      proxy_username: 'user@example.com',
      proxy_password: 'p@ss word',
    });
    expect(resolved.url).toContain('user%40example.com');
    expect(resolved.rule).toBe('http://127.0.0.1:7890');
    expect(resolved.rule).not.toContain('user');
    expect(resolved.auth).toMatchObject({ username: 'user@example.com', password: 'p@ss word', port: 7890 });
  });
});

describe('ruleOf / 认证端口推断', () => {
  it('按协议推断默认端口', () => {
    expect(ruleOf('http://u:p@proxy:').auth?.port ?? 80).toBe(80);
    expect(ruleOf('https://u:p@proxy').auth?.port).toBe(443);
    expect(ruleOf('socks5://u:p@proxy').auth?.port).toBe(1080);
  });

  it('IPv6 主机补方括号，规则里不带凭据', () => {
    const resolved = ruleOf('http://u:p@[::1]:7890');
    expect(resolved.rule).toBe('http://[::1]:7890');
    expect(resolved.auth?.host).toBe('::1');
  });

  it('无凭据时 auth 为 null', () => {
    expect(ruleOf('http://127.0.0.1:7890').auth).toBeNull();
  });
});

describe('envWithProxy', () => {
  const base = {
    HTTP_PROXY: 'current',
    HTTPS_PROXY: 'current',
    NO_PROXY: 'keep-me',
    PATH: '/usr/bin',
  } as Record<string, string | undefined>;

  it('direct 清空全部代理变量（含 no_proxy）', () => {
    const next = envWithProxy(base, { mode: 'direct', url: null }, snapshot);
    for (const key of PROXY_ENV_KEYS) expect(next[key]).toBeUndefined();
    expect(next.PATH).toBe('/usr/bin');
  });

  it('custom 写入各代理变量，并清掉 no_proxy（与 4.5 一致：自定义代理不做旁路）', () => {
    const next = envWithProxy(base, { mode: 'custom', url: 'http://127.0.0.1:7890' }, snapshot);
    expect(next.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(next.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(next.ALL_PROXY).toBe('http://127.0.0.1:7890');
    expect(next.NO_PROXY).toBeUndefined();
    expect(next.no_proxy).toBeUndefined();
  });

  it('system 精确还原启动快照', () => {
    const next = envWithProxy(base, { mode: 'system', url: 'http://system-https:8443' }, snapshot);
    expect(next.HTTPS_PROXY).toBe('http://system-https:8443');
    expect(next.HTTP_PROXY).toBe('http://system-http:8080');
    expect(next.NO_PROXY).toBe('localhost,127.0.0.1');
  });

  it('system 模式下快照里没有的键会被删除', () => {
    const next = envWithProxy({ ...base, ALL_PROXY: 'leftover' }, { mode: 'system', url: null }, snapshot);
    expect(next.ALL_PROXY).toBeUndefined();
  });
});

describe('snapshotProxyUrl 优先级', () => {
  it('https > http > all', () => {
    expect(snapshotProxyUrl({ https_proxy: 'a' })).toBe('a');
    expect(snapshotProxyUrl({ http_proxy: 'b' })).toBe('b');
    expect(snapshotProxyUrl({ all_proxy: 'c' })).toBe('c');
    expect(snapshotProxyUrl({ HTTPS_PROXY: 'x', HTTP_PROXY: 'y' })).toBe('x');
    expect(snapshotProxyUrl({})).toBeNull();
  });
});

describe('axiosProxyOption', () => {
  it('直连返回 false，自定义返回协议/主机/端口与凭据', () => {
    expect(axiosProxyOption({ mode: 'direct', url: null })).toBe(false);
    expect(axiosProxyOption({ mode: 'custom', url: 'http://u:p@127.0.0.1:7890' })).toMatchObject({
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      auth: { username: 'u', password: 'p' },
    });
  });
});
