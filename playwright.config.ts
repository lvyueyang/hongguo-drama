import { defineConfig } from '@playwright/test';

/**
 * Electron 端到端验收（L4）。
 *
 * 只跑真实构建产物：out/main/index.js + out/preload/index.js + out/renderer。
 * 不下载浏览器——`_electron` 直接用仓库里的 Electron 二进制。
 * 覆盖的是"静态断言与单测都证明不了"的部分：sandbox 真实生效、preload 暴露面、自定义协议、IPC 往返。
 */
export default defineConfig({
  testDir: 'e2e',
  // Playwright 默认只认 *.spec/*.test，这里用 .e2e.ts 以免被 vitest 的 include 规则抢走。
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'off' },
});
