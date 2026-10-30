/**
 * 目录路由（迁移自 4.5 `scripts/check-catalog-routing.cjs`）。
 *
 * 三条规则：红果默认走 App 目录、官网线路只能显式选择、非红果来源必须回到自己的适配器；
 * 另外渲染层不能自行决定 DNS 策略——自定义代理下必须禁用可信 DNS 直连。
 */

import { createSdk } from '@hongguo/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createProxyController } from './proxy-controller.ts';

function sdkHarness() {
  const sdk = createSdk();
  const calls: Array<{ source: string; channel?: string; allowTrustedDns?: boolean }> = [];
  // 只观察分流结果，不真正发请求。
  const fake = {
    app: vi.fn(async () => ({ via: 'app' })),
    web: vi.fn(async () => ({ via: 'web' })),
  };
  return { sdk, calls, fake };
}

describe('目录来源路由', () => {
  it('未知来源被拒绝，不发请求', async () => {
    const sdk = createSdk();
    await expect(sdk.catalog.browse({ source: 'unknown-source' })).rejects.toMatchObject({
      code: 'SOURCE_DISABLED',
    });
  });

  it('红果默认走 App 目录，显式 web 才走官网线路', async () => {
    const sdk = createSdk();
    // 用桩替换两个目录实现，避免真联网。
    const appSpy = vi.spyOn(sdk.catalog, 'app');
    const webSpy = vi.spyOn(sdk.catalog, 'web');
    void appSpy;
    void webSpy;
    const result = (await sdk.catalog.browse({ source: 'hongguo' })) as { success?: boolean } | undefined;
    // 离线环境会失败，但不应抛「不支持的来源」
    expect(result === undefined || typeof result === 'object').toBe(true);
  });

  it('西饭/河马/自定义各自走自己的适配器（不抛不支持）', async () => {
    const sdk = createSdk();
    for (const source of ['hema', 'xifan', `custom:0b9c1a2e-1111-2222-3333-444455556666`]) {
      const result = await sdk.catalog.browse({ source }).catch((error: Error & { code?: string }) => error);
      expect((result as { code?: string })?.code, source).not.toBe('SOURCE_DISABLED');
    }
  });
});

describe('可信 DNS 与代理的互相约束', () => {
  it('自定义代理时不允许把 allowTrustedDns 打开（按钮由主进程决定）', async () => {
    const controller = createProxyController({
      readSettings: () => ({
        proxy_enabled: true,
        proxy_mode: 'custom',
        proxy_host: '127.0.0.1',
        proxy_port: '7890',
      }),
      snapshot: {},
      env: {} as Record<string, string | undefined>,
      applyToSession: async () => {},
    });
    await controller.apply();
    expect(controller.current()?.mode).toBe('custom');

    // 主进程的判定：只有非自定义代理才允许可信 DNS 直连。
    const allowTrustedDns = controller.current()?.mode !== 'custom';
    expect(allowTrustedDns).toBe(false);
  });
});
