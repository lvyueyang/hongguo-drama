/**
 * 出站请求安全闸门的**运行时**行为（迁移自 4.5 `scripts/check-web-media-guard.cjs`）。
 *
 * `guard.test.ts` 只覆盖 URL 策略（同步判断）；这里覆盖只有真跑 socket 才暴露的部分：
 * - 守卫 agent 与全局 agent 隔离、已校验 socket 可复用、未校验的暖 socket 不能借道；
 * - 校验发生在**实际连接**时（DNS rebinding 换回内网不会命中）；
 * - 代理 socket 只在仍走代理的请求上可信；
 * - 重定向按媒体 Location 校验，且重定向目标在连接时再校验一次；
 * - 官网可信 DNS（固定解析器）只对该精确 origin 生效、失败关闭、Fake-IP 兼容不外溢。
 *
 * `node:dns` 与 `node:https.get` 被替换成可控替身：前者模拟系统 DNS 答案（含 rebinding），
 * 后者模拟 DoH/固定解析器的响应（含超时、重定向、TLS 失败、超大响应）。
 * 真实 axios 仍走真实 socket，只是连到本机 loopback 夹具。
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Address {
  address: string;
  family: number;
}

const state = vi.hoisted(() => ({
  /** 系统 DNS 答案；可换成按主机名给答案的函数 */
  records: [] as Address[],
  dnsCalls: [] as string[],
  /** 安全 DNS 替身：由各用例设置 */
  resolver: null as null | ((url: string, options: any, callback: any) => any),
  resolverCalls: [] as string[],
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const lookup = (hostname: string, options: any, callback: any) => {
    const settings = typeof options === 'number' ? { family: options } : options || {};
    state.dnsCalls.push(hostname);
    process.nextTick(() => callback(null, state.records.slice()));
    void settings;
  };
  return { ...actual, default: { ...(actual.default ?? actual), lookup } };
});

// 只替换 https.get（安全 DNS 用它访问固定解析器）；axios 仍需要真实的 request/Agent。
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const real = actual.default ?? actual;
  const get = (url: string, options: any, callback: any) => {
    state.resolverCalls.push(String(url));
    return state.resolver?.(String(url), options, callback);
  };
  return {
    ...actual,
    default: new Proxy(real, { get: (target, prop) => (prop === 'get' ? get : Reflect.get(target, prop)) }),
  };
});

const { isPublicMediaUrl, webMediaRequestOptions } = await import('./guard.ts');

/** 让真实守卫完成 DNS 校验后，把连接落到本机 loopback 夹具（不是绕过校验）。 */
function loopbackAfterGuard(agent: any): any {
  agent.createConnection = (connection: any, callback: any) => {
    connection.lookup(connection.host, { all: true }, (error: Error | null) => {
      if (error) return callback(error);
      const socket = http.Agent.prototype.createConnection.call(agent, {
        ...connection,
        host: '127.0.0.1',
        hostname: undefined,
        lookup: undefined,
      });
      callback(null, socket);
    });
  };
  return agent;
}

const touchedAgents: any[] = [];
function guarded(url: string, options?: { trustedOfficialDns?: boolean }): any {
  const result = webMediaRequestOptions(url, options) as any;
  for (const agent of [result.httpAgent, result.httpsAgent]) {
    if (agent && !touchedAgents.includes(agent)) touchedAgents.push(agent);
  }
  return result;
}

function lookupOnce(options: any, hostname: string, settings: any = { all: true }): Promise<any> {
  return new Promise((resolve, reject) =>
    options.lookup(hostname, settings, (error: Error | null, value: any) =>
      error ? reject(error) : resolve(value),
    ),
  );
}

/** 安全 DNS 替身：按用例给的行为作答。 */
function resolver(
  kind: 'ok' | 'error' | 'hang' | 'redirect' | 'tls' | 'private' | 'oversized',
  answers: { address?: string; ttl?: number } = {},
): (url: string, options: any, callback: any) => any {
  return (_url, options, callback) => {
    const request: any = new EventEmitter();
    request.destroy = (error?: Error) => {
      request.destroyed = true;
      if (error) request.emit('error', error);
      request.emit('close');
    };
    // 固定解析器 IP 不能走本地 DNS，TLS 校验不能关。
    expect(options.lookup).toBeUndefined();
    expect(options.rejectUnauthorized).toBeUndefined();
    process.nextTick(() => {
      if (kind === 'hang') return;
      if (kind === 'error') {
        request.destroy(Object.assign(new Error('unavailable'), { code: 'ECONNRESET' }));
        return;
      }
      if (kind === 'tls') {
        request.destroy(Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' }));
        return;
      }
      const response: any = new EventEmitter();
      response.statusCode = kind === 'redirect' ? 302 : 200;
      response.headers = { location: 'https://127.0.0.1/resolve' };
      response.setEncoding = () => {};
      callback(response);
      response.emit(
        'data',
        kind === 'oversized'
          ? 'x'.repeat(65537)
          : JSON.stringify({
              Status: 0,
              Answer: [
                {
                  type: 1,
                  data: kind === 'private' ? '198.18.0.1' : (answers.address ?? '8.8.8.8'),
                  TTL: answers.ttl ?? 0,
                },
              ],
            }),
      );
      response.emit('end');
      request.emit('close');
    });
    return request;
  };
}

let server: http.Server;
let base = '';
const hits: string[] = [];
const sockets = new Set<any>();
/** 连接复用用例要保活；rebinding 用例要每次都建新连接。 */
let keepAlive = true;

beforeEach(async () => {
  keepAlive = false;
  state.records = [];
  state.dnsCalls = [];
  state.resolver = resolver('ok');
  state.resolverCalls = [];
  hits.length = 0;
  sockets.clear();
  server = http.createServer((request, response) => {
    hits.push(String(request.url));
    sockets.add(request.socket);
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      Connection: keepAlive ? 'keep-alive' : 'close',
    });
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const agent of touchedAgents.splice(0)) delete agent.createConnection;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('守卫 socket 与 agent 隔离', () => {
  it('守卫 agent 独立于全局 agent，且 Range 请求复用同一条已校验 socket', async () => {
    keepAlive = true;
    state.records = [{ address: '8.8.8.8', family: 4 }];
    const url = `http://media.example:${new URL(base).port}/a`;
    const options = guarded(url);
    // 「接线存在」：守卫必须用自己 keep-alive 的 agent，绝不落到全局 agent 上。
    expect(options.httpAgent).not.toBe(http.globalAgent);
    expect(options.httpsAgent).not.toBe((https as any).globalAgent);
    loopbackAfterGuard(options.httpAgent);

    for (let index = 0; index < 3; index++) {
      const response = await axios.get(url, {
        proxy: false,
        timeout: 2000,
        headers: { Range: 'bytes=0-1' },
        ...options,
      });
      expect(response.status).toBe(200);
    }
    expect(hits).toHaveLength(3);
    // 三次请求只开了一条连接：连接被复用时不会再有第二条。
    expect(sockets.size).toBe(1);
  });

  it('未守卫的暖 socket 不能绕过守卫的重校验', async () => {
    state.records = [{ address: '127.0.0.1', family: 4 }];
    const url = `http://media.example:${new URL(base).port}/a`;
    // 先用调用方自己的 lookup 打开一条通往内网的连接
    await axios.get(url, {
      proxy: false,
      timeout: 2000,
      lookup: (_hostname: string, settings: any, callback: any) =>
        callback(null, settings?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
    });
    expect(hits).toHaveLength(1);
    // 同一条（暖）连接不得被守卫请求借道：校验在连接时执行，此路连接直接失败
    await expect(axios.get(url, { proxy: false, timeout: 2000, ...guarded(url) })).rejects.toMatchObject({
      code: 'ERR_WEB_MEDIA_ADDRESS',
    });
    expect(hits).toHaveLength(1);
  });

  it('代理 socket 只在仍走代理的请求上可信', async () => {
    state.records = [{ address: '127.0.0.1', family: 4 }];
    const port = new URL(base).port;
    const url = 'http://media.example/a';
    // 显式代理允许解出私网（用户自己的代理可以是本机）——这是唯一放行面。
    const viaProxy = await axios.get(url, {
      proxy: { host: 'user-proxy.example', port: Number(port), protocol: 'http' },
      timeout: 2000,
      ...guarded(url),
    });
    expect(viaProxy.status).toBe(200);
    const direct = `http://user-proxy.example:${port}/private`;
    await expect(
      axios.get(direct, { proxy: false, timeout: 2000, ...guarded(direct) }),
    ).rejects.toMatchObject({ code: 'ERR_WEB_MEDIA_ADDRESS' });
    expect(hits).toHaveLength(1);
  });
});

describe('DNS 校验时机', () => {
  it('已放行的公网连接在下一次新连接时重新校验（rebinding 不会命中内网）', async () => {
    const url = `http://media.example:${new URL(base).port}/a`;
    state.records = [{ address: '8.8.8.8', family: 4 }];
    const options = guarded(url);
    loopbackAfterGuard(options.httpAgent);
    await axios.get(url, { proxy: false, timeout: 2000, ...options });
    expect(hits).toHaveLength(1);

    // 域名改指向内网：新连接必须被拒，内网服务一个请求都收不到。
    state.records = [{ address: '127.0.0.1', family: 4 }];
    await expect(axios.get(url, { proxy: false, timeout: 2000, ...guarded(url) })).rejects.toMatchObject({
      code: 'ERR_WEB_MEDIA_ADDRESS',
    });
    expect(hits).toHaveLength(1);
  });

  it('重定向目标在连接时同样校验（不只是看 Location 字符串）', async () => {
    state.records = [{ address: '192.168.1.1', family: 4 }];
    const options = guarded('https://media.example/a');
    options.beforeRedirect(
      {},
      { headers: { location: 'https://other.example/b' } },
      { url: 'https://media.example/a' },
    );
    await expect(lookupOnce(options, 'other.example', {})).rejects.toMatchObject({
      code: 'ERR_WEB_MEDIA_ADDRESS',
    });
  });

  it('lookup 保持 all/单值两种形状，且只有初始主机与跳转目标受校验（代理主机可私网）', async () => {
    state.records = [{ address: '8.8.8.8', family: 4 }];
    const options = guarded('https://media.example/a');
    await expect(lookupOnce(options, 'media.example', { all: true })).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);
    const single: any = await new Promise((resolve, reject) =>
      options.lookup('media.example', {}, (error: Error | null, address: any, family: any) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );
    expect(single).toEqual({ address: '8.8.8.8', family: 4 });

    state.records = [{ address: '127.0.0.1', family: 4 }];
    const proxyOptions = guarded('https://media.example/a');
    // 代理主机不在校验集合里：用户选择的本机代理必须能连。
    await expect(lookupOnce(proxyOptions, 'user-proxy.example', {})).resolves.toBe('127.0.0.1');
    // 而同一个私网答案落在初始主机上必须被拒。
    await expect(lookupOnce(proxyOptions, 'media.example', {})).rejects.toMatchObject({
      code: 'ERR_WEB_MEDIA_ADDRESS',
    });
  });

  it('解析出私网、混合私网与映射 IPv6 的答案一律拒绝', async () => {
    for (const records of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '::ffff:192.168.1.1', family: 6 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      [], // 解析不到地址也不能放行
    ]) {
      state.records = records as Address[];
      await expect(lookupOnce(guarded('https://media.example/a'), 'media.example', {})).rejects.toMatchObject(
        {
          code: 'ERR_WEB_MEDIA_ADDRESS',
        },
      );
    }
  });
});

describe('官网可信 DNS（trustedOfficialDns）', () => {
  it('只对精确官网 origin 生效：走独立 agent、强制直连、不受系统 DNS 答案影响', async () => {
    // 系统 DNS 给假 IP（VPN Fake-IP），可信线路必须无视它。
    state.records = [{ address: '198.18.14.190', family: 4 }];
    state.resolver = resolver('ok', { address: '8.8.8.8' });
    const ordinary = guarded('https://hongguoduanju.com/rank/hot-drama');
    const trusted = guarded('https://hongguoduanju.com/rank/hot-drama', { trustedOfficialDns: true });

    await expect(lookupOnce(ordinary, 'hongguoduanju.com')).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);
    // 普通线路走系统 DNS：拿到 Fake-IP 时按 Fake-IP 规则换成可信解析
    expect(state.dnsCalls).toContain('hongguoduanju.com');
    expect(trusted.proxy).toBe(false);
    expect(ordinary.proxy).toBeUndefined();
    expect(trusted.httpsAgent).not.toBe(ordinary.httpsAgent);
    await expect(lookupOnce(trusted, 'hongguoduanju.com')).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);

    // 非官网 origin、非 HTTPS、别的端口、子域都不得进入可信线路
    for (const url of [
      'http://hongguoduanju.com/a',
      'https://hongguoduanju.com:444/a',
      'https://sub.hongguoduanju.com/a',
      'https://other.example/a',
    ]) {
      expect(() => webMediaRequestOptions(url, { trustedOfficialDns: true })).toThrow(/公网/);
    }
  });

  it('并发消费者共享一次安全 DNS 竞争，输家请求被取消', async () => {
    state.records = [{ address: '198.18.14.190', family: 4 }];
    state.resolver = (url, _options, callback) => {
      if (url.startsWith('https://1.1.1.1/')) return resolver('error')(url, _options, callback);
      expect(url).toBe('https://223.5.5.5/resolve?name=hongguoduanju.com&type=A');
      return resolver('ok', { address: '8.8.8.8' })(url, _options, callback);
    };
    const options = guarded('https://hongguoduanju.com/a', { trustedOfficialDns: true });
    const [first, second] = await Promise.all([
      lookupOnce(options, 'hongguoduanju.com'),
      lookupOnce(options, 'hongguoduanju.com'),
    ]);
    expect(first).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(second).toEqual(first);
    // 两个解析器各一次：并发的两次查询共用同一场竞争，不会各打一遍。
    expect(state.resolverCalls).toHaveLength(2);
  });
});

describe('安全 DNS 失败关闭', () => {
  it('重定向、TLS 失败、私网答案、超大响应都不放行', async () => {
    for (const [kind, code] of [
      ['redirect', 'ERR_WEB_MEDIA_ADDRESS'],
      ['tls', 'CERT_HAS_EXPIRED'],
      ['private', 'ERR_WEB_MEDIA_ADDRESS'],
      ['oversized', 'ERR_WEB_MEDIA_ADDRESS'],
    ] as const) {
      state.records = [{ address: '198.18.14.190', family: 4 }];
      state.resolver = resolver(kind);
      const options = guarded('https://hongguoduanju.com/a', { trustedOfficialDns: true });
      await expect(lookupOnce(options, 'hongguoduanju.com')).rejects.toMatchObject({ code });
    }
  });

  it('解析器挂起时按超时失败关闭，不会退回假 IP', async () => {
    state.records = [{ address: '198.18.14.190', family: 4 }];
    state.resolver = resolver('hang');
    const options = guarded('https://hongguoduanju.com/a', { trustedOfficialDns: true });
    // 两个解析器都不给答案时必须超时失败，而不是回头用系统 DNS 的 Fake-IP 连上去
    await expect(lookupOnce(options, 'hongguoduanju.com')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  }, 20_000);
});

describe('真实 axios + 代理', () => {
  it('公网重定向照常跟随，私网目标在第二次请求前就被挡下', async () => {
    const proxyHits: string[] = [];
    const proxy = http.createServer((request, response) => {
      proxyHits.push(String(request.url));
      if (String(request.url).endsWith('/bad')) {
        response.writeHead(302, { Location: 'http://127.0.0.1/private' });
      } else if (String(request.url).endsWith('/start')) {
        response.writeHead(302, { Location: 'http://fc-cdn.example/final' });
      } else {
        response.writeHead(206, { 'Content-Type': 'video/mp4' });
      }
      response.end('ok');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyConfig = {
      host: '127.0.0.1',
      port: (proxy.address() as { port: number }).port,
      protocol: 'http',
    };
    try {
      const bad = 'http://media.example/bad';
      await expect(axios.get(bad, { proxy: proxyConfig, timeout: 2000, ...guarded(bad) })).rejects.toThrow(
        /公网/,
      );
      // 内网目标一个字节都没被请求
      expect(proxyHits).toHaveLength(1);

      const start = 'http://media.example/start';
      const response = await axios.get(start, {
        proxy: proxyConfig,
        timeout: 2000,
        headers: { Range: 'bytes=0-1' },
        ...guarded(start),
      });
      expect(response.status).toBe(206);
      expect(proxyHits.length).toBeGreaterThanOrEqual(2);
      expect(proxyHits.at(-1)).toContain('/final');
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

describe('重定向校验', () => {
  it('用媒体 Location 判断，不看本地代理地址', () => {
    const options = guarded('https://media.example/a');
    const proxyOptions = { hostname: '127.0.0.1' };
    const request = { url: 'https://media.example/a' };
    for (const location of [
      'http://127.0.0.1/a',
      'http://10.0.0.1/a',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a',
      'http://nas.local/a',
      'file:///etc/passwd',
      'https://user:pass@media.example/a',
    ]) {
      expect(() => options.beforeRedirect(proxyOptions, { headers: { location } }, request)).toThrow(/公网/);
    }
    expect(() =>
      options.beforeRedirect(proxyOptions, { headers: { location: '/b' } }, request),
    ).not.toThrow();
    expect(() =>
      options.beforeRedirect(proxyOptions, { headers: { location: 'https://fc-cdn.example/b' } }, request),
    ).not.toThrow();
  });

  it('public/private 名单与 URL 策略一致（回归守卫本体）', () => {
    for (const url of ['https://fc-cdn.example/a', 'https://8.8.8.8/a', 'https://[2606:4700::1111]/a']) {
      expect(isPublicMediaUrl(url)).toBe(true);
    }
    for (const url of [
      'http://2130706433/a',
      'http://0x7f000001/a',
      'http://localhost./a',
      'http://printer/a',
    ]) {
      expect(isPublicMediaUrl(url)).toBe(false);
    }
  });
});
