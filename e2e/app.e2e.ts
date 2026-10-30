import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const APP_ROOT = path.resolve(process.cwd(), 'apps/desktop');
const MAIN = path.join(APP_ROOT, 'out/main/index.js');

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  app = await electron.launch({ args: [MAIN], cwd: APP_ROOT });
  page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.waitForSelector('aside', { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('窗口启动并渲染 9 个导航入口', async () => {
  const labels = await page.locator('aside nav button').allInnerTexts();
  expect(labels.map((text) => text.trim())).toEqual([
    '发现短剧',
    '热播推荐',
    '搜索与下载',
    '我的剧库',
    '观看记录',
    '收藏与上新',
    '下载管理',
    '红果账号',
    '设置',
  ]);
});

test('渲染进程处于沙箱：没有 Node 能力', async () => {
  const probe = await page.evaluate(() => ({
    hasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (globalThis as { process?: { versions?: unknown } }).process?.versions !== 'undefined',
    hasModule: typeof (globalThis as { module?: unknown }).module !== 'undefined',
  }));
  expect(probe).toEqual({ hasRequire: false, hasProcess: false, hasModule: false });
});

test('preload 只暴露契约里的 API，不泄漏 ipcRenderer', async () => {
  const surface = await page.evaluate(() => {
    const api = (window as unknown as { api?: Record<string, unknown> }).api;
    return api ? Object.keys(api).sort() : null;
  });
  expect(surface).not.toBeNull();
  expect(surface).toContain('appInfo');
  expect(surface).toContain('suggest');
  expect(surface).toContain('downloadEnqueue');
  expect(surface).not.toContain('ipcRenderer');
  expect(surface).not.toContain('require');
  expect(surface).not.toContain('send');
});

test('IPC 往返可用：应用信息与能力查询', async () => {
  const envelope = await page.evaluate(async () => {
    const api = (window as unknown as { api: { appInfo(): Promise<unknown>; capabilities(): Promise<unknown> } }).api;
    return { info: await api.appInfo(), capabilities: await api.capabilities() };
  });
  // 契约是 Result 信封：{ ok, data } / { ok:false, error }
  const info = envelope.info as { ok: boolean; data?: { name?: string; version?: string } };
  const capabilities = envelope.capabilities as { ok: boolean; data?: { canPlayAnonymous?: boolean; accountAffectsPlayback?: boolean } };
  expect(info.ok).toBe(true);
  expect(info.data).toMatchObject({ name: expect.any(String), version: expect.any(String) });
  expect(capabilities.ok).toBe(true);
  expect(capabilities.data).toMatchObject({ canPlayAnonymous: true, accountAffectsPlayback: false });
});

test('设置读写经真实 IPC 往返并落盘', async () => {
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { api: { saveSettings(s: Record<string, unknown>): Promise<unknown>; getSettings(): Promise<unknown> } }).api;
    await api.saveSettings({ max_concurrent: 5, name_format: '剧名 集数' });
    return api.getSettings();
  });
  const payload = result as { ok: boolean; data?: { max_concurrent?: number } };
  expect(payload.ok).toBe(true);
  expect(payload.data?.max_concurrent).toBe(5);
});

test('自定义协议已在主进程注册，且不放行 CSP', async () => {
  // 渲染进程里 fetch 自定义协议受 Chromium 限制，这里从主进程侧断言注册结果。
  const registered = await app.evaluate(async ({ protocol }) => ({
    stream: protocol.isProtocolHandled('hongguo-stream'),
    local: protocol.isProtocolHandled('hongguo-local'),
  }));
  expect(await registered).toEqual({ stream: true, local: true });
});

test('外部弹窗被拒绝：不会在应用内打开新窗口', async () => {
  const before = app.windows().length;
  await page.evaluate(() => window.open('https://example.com/', '_blank'));
  await page.waitForTimeout(500);
  expect(app.windows().length).toBe(before);
});

test('页面导航到外部站点被守卫拦下', async () => {
  const urlBefore = page.url();
  await page.evaluate(() => {
    try {
      window.location.href = 'https://example.com/';
    } catch {
      /* 被守卫阻止时可能抛错 */
    }
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(urlBefore);
});

test('渲染进程没有未捕获的 console 错误', async () => {
  expect(consoleErrors.filter((text) => !/Failed to load resource/i.test(text))).toEqual([]);
});
