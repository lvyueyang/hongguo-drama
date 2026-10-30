/**
 * 代理与更新会话（迁移自 4.5 `scripts/check-app-update-proxy.cjs`）。
 *
 * 守三条：更新会话也必须走代理；切换代理要断开两个会话的旧连接；
 * 代理凭据只交给允许的主机，且不会出现在会话调用参数里。
 */
import { describe, expect, it, vi } from 'vitest';
import { createProxySessionApplier, decideProxyCredentials } from './proxy-sessions.ts';

function fakeSession() {
  return {
    calls: [] as unknown[],
    closed: 0,
    setProxy: vi.fn(function setProxy(this: { calls: unknown[] }, config: unknown) {
      this.calls.push(config);
    }),
    closeAllConnections: vi.fn(function closeAllConnections(this: { closed: number }) {
      this.closed += 1;
    }),
  };
}

const custom = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' };

describe('代理应用到两个会话', () => {
  it('窗口会话与更新会话都拿到同一份规则', async () => {
    const windowSession = fakeSession();
    const updateSession = fakeSession();
    const apply = createProxySessionApplier({ windowSession, updateSession: () => updateSession });
    expect(await apply(custom)).toBe(true);
    expect(windowSession.calls).toEqual([custom]);
    expect(updateSession.calls).toEqual([custom]);
  });

  it('切换代理会断开两个会话的旧连接', async () => {
    const windowSession = fakeSession();
    const updateSession = fakeSession();
    await createProxySessionApplier({ windowSession, updateSession: () => updateSession })(custom);
    expect(updateSession.closed).toBe(1);
    expect(windowSession.closed).toBe(1);
  });

  it('没有更新会话时不影响窗口会话', async () => {
    const windowSession = fakeSession();
    const apply = createProxySessionApplier({ windowSession, updateSession: () => undefined });
    expect(await apply(custom)).toBe(true);
    expect(windowSession.calls).toEqual([custom]);
  });

  it('更新会话设置失败时窗口会话仍然生效，并如实回报', async () => {
    const windowSession = fakeSession();
    const warnings: string[] = [];
    const updateSession = {
      setProxy: vi.fn(async () => {
        throw new Error('session unavailable');
      }),
      closeAllConnections: vi.fn(),
    };
    const apply = createProxySessionApplier({
      windowSession,
      updateSession: () => updateSession,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(await apply(custom)).toBe(false);
    expect(windowSession.calls).toEqual([custom]);
    expect(warnings.join(' ')).toMatch(/更新会话/);
  });

  it('直连模式同样要下发，避免沿用上一次的自定义代理', async () => {
    const windowSession = fakeSession();
    const updateSession = fakeSession();
    await createProxySessionApplier({ windowSession, updateSession: () => updateSession })({
      mode: 'direct',
    });
    expect(updateSession.calls.at(-1)).toEqual({ mode: 'direct' });
  });
});

describe('代理认证只给允许的主机', () => {
  const credentials = { username: 'fixture', password: 'synthetic-password' };
  const allowed = ['github.com', 'objects.githubusercontent.com'];

  it('挑战主机命中白名单时给出凭据', () => {
    expect(decideProxyCredentials({ host: 'github.com' }, credentials, allowed)).toEqual(credentials);
    expect(decideProxyCredentials({ host: 'OBJECTS.githubusercontent.com' }, credentials, allowed)).toEqual(
      credentials,
    );
  });

  it('无关主机一律不提供凭据', () => {
    expect(decideProxyCredentials({ host: 'evil.invalid' }, credentials, allowed)).toBe(false);
    expect(decideProxyCredentials({ host: 'github.com.evil.invalid' }, credentials, allowed)).toBe(false);
    expect(decideProxyCredentials({ host: '' }, credentials, allowed)).toBe(false);
    expect(decideProxyCredentials(undefined, credentials, allowed)).toBe(false);
  });

  it('没有配置账号时不提供凭据', () => {
    expect(decideProxyCredentials({ host: 'github.com' }, { username: '', password: '' }, allowed)).toBe(
      false,
    );
    expect(decideProxyCredentials({ host: 'github.com' }, undefined, allowed)).toBe(false);
  });

  it('凭据不出现在会话调用参数里', async () => {
    const windowSession = fakeSession();
    const updateSession = fakeSession();
    await createProxySessionApplier({ windowSession, updateSession: () => updateSession })(
      'http://127.0.0.1:7890',
    );
    const serialized = JSON.stringify([windowSession.calls, updateSession.calls]);
    expect(serialized).not.toContain('synthetic-password');
  });
});
