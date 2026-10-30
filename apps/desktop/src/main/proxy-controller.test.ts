/**
 * 代理应用编排（迁移自 4.5 `scripts/check-proxy-routing.cjs` 的编排类断言）。
 * 只测编排语义，不联网：会话应用、环境变量、超时与迟到完成都由替身观察。
 */
import { describe, expect, it, vi } from 'vitest';
import { createProxyController, sessionConfigOf } from './proxy-controller.ts';

const snapshot = {
  HTTP_PROXY: 'http://system-http:8080',
  HTTPS_PROXY: 'http://system-https:8443',
  NO_PROXY: 'localhost',
} as Record<string, string | undefined>;

function harness(
  settings: Record<string, unknown>,
  options: { timeoutMs?: number; applyImpl?: () => Promise<void> } = {},
) {
  const env: Record<string, string | undefined> = { PATH: '/usr/bin', HTTPS_PROXY: 'stale' };
  const calls: Array<{ mode: string; proxyRules?: string }> = [];
  const warnings: string[] = [];
  const controller = createProxyController({
    readSettings: () => settings as never,
    snapshot,
    env,
    timeoutMs: options.timeoutMs,
    logger: { warn: (message) => warnings.push(message) },
    applyToSession: async (config) => {
      calls.push(config);
      if (options.applyImpl) await options.applyImpl();
    },
  });
  return { controller, env, calls, warnings };
}

describe('sessionConfigOf', () => {
  it('自定义代理走 fixed_servers，直连/system 原样映射', () => {
    expect(
      sessionConfigOf({ mode: 'custom', url: 'http://127.0.0.1:7890', rule: 'http://127.0.0.1:7890' }),
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
    });
    expect(sessionConfigOf({ mode: 'direct', url: null })).toEqual({ mode: 'direct' });
    expect(sessionConfigOf({ mode: 'system', url: null })).toEqual({ mode: 'system' });
  });
});

describe('应用代理', () => {
  it('自定义模式：先写环境变量，再按 fixed_servers 应用到会话', async () => {
    const h = harness({
      proxy_enabled: true,
      proxy_mode: 'custom',
      proxy_host: '127.0.0.1',
      proxy_port: '7890',
    });
    const result = await h.controller.apply();

    expect(result).toMatchObject({ mode: 'custom', rule: 'http://127.0.0.1:7890' });
    expect(h.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(h.calls.at(-1)).toEqual({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' });
  });

  it('强制直连：清空代理环境变量并应用 direct', async () => {
    const h = harness({ proxy_enabled: true, proxy_mode: 'direct' });
    await h.controller.apply();
    expect(h.env.HTTPS_PROXY).toBeUndefined();
    expect(h.env.HTTP_PROXY).toBeUndefined();
    expect(h.calls.at(-1)).toEqual({ mode: 'direct' });
  });

  it('跟随系统：从启动快照还原环境变量', async () => {
    const h = harness({ proxy_enabled: true, proxy_mode: 'system' });
    await h.controller.apply();
    expect(h.env.HTTPS_PROXY).toBe('http://system-https:8443');
    expect(h.env.HTTP_PROXY).toBe('http://system-http:8080');
    expect(h.calls.at(-1)).toEqual({ mode: 'system' });
  });

  it('自定义模式缺少端口：不改环境、不动会话，返回可读错误', async () => {
    const h = harness({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1' });
    const result = await h.controller.apply();
    expect(result.error).toMatch(/地址与端口/);
    expect(h.env.HTTPS_PROXY).toBe('stale');
    expect(h.calls).toHaveLength(0);
  });
});

describe('超时与迟到完成', () => {
  it('会话应用超时后回落直连，并把环境变量一并改回直连', async () => {
    const h = harness(
      { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: '7890' },
      {
        timeoutMs: 10,
        applyImpl: () =>
          new Promise<void>((_resolve) => {
            /* 永不完成，触发超时 */
          }),
      },
    );
    const result = await h.controller.apply();
    expect(result).toMatchObject({ mode: 'direct', fallback: true });
    expect(h.env.HTTPS_PROXY).toBeUndefined();
    expect(h.warnings.some((message) => message.includes('超时'))).toBe(true);
  });

  it('迟到的完成不会覆盖新配置：旧代号结束时会再应用最新配置', async () => {
    let release: () => void = () => {};
    let first = true;
    const settings: Record<string, unknown> = {
      proxy_enabled: true,
      proxy_mode: 'custom',
      proxy_host: 'a',
      proxy_port: '1',
    };
    const calls: Array<{ mode: string; proxyRules?: string }> = [];
    const controller = createProxyController({
      readSettings: () => settings as never,
      snapshot,
      env: {} as Record<string, string | undefined>,
      applyToSession: async (config) => {
        calls.push(config);
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });

    const pendingFirst = controller.apply();
    settings.proxy_host = 'b';
    settings.proxy_port = '2';
    const second = await controller.apply();
    expect(second).toMatchObject({ mode: 'custom', rule: 'http://b:2' });

    release();
    await pendingFirst;
    // 旧代号完成后应把最新配置再刷一次，最终生效的是 b
    expect(calls.at(-1)).toEqual({ mode: 'fixed_servers', proxyRules: 'http://b:2' });
  });

  it('current 反映最近一次应用结果', async () => {
    const h = harness({ proxy_enabled: false });
    expect(h.controller.current()).toBeNull();
    await h.controller.apply();
    expect(h.controller.current()).toMatchObject({ mode: 'direct' });
  });

  it('会话应用报错时同样回落直连，并记录日志', async () => {
    const h = harness(
      { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: '7890' },
      { applyImpl: async () => Promise.reject(new Error('native failed')) },
    );
    const result = await h.controller.apply();
    expect(result.fallback).toBe(true);
    expect(h.warnings.length).toBeGreaterThan(0);
  });
});
