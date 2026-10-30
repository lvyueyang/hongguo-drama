/**
 * 渲染层安全边界（静态断言，迁移自 4.5 `scripts/check-renderer-security.cjs` 的意图）。
 *
 * 4.5 用 vm + 假 Electron 在运行时验证这些边界；新架构里主进程边界由 `ipc.test.ts`
 * 覆盖运行时行为（可信发送者、入参校验），而 **沙箱 / CSP / preload 暴露面** 这类
 * 只在真实 Chromium 里生效的约束，先用源码与构建产物断言兜住，避免它们被无声改坏。
 * 运行时行为由后续 Playwright `_electron` E2E 补齐（见 docs/refactor-status.md）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const mainSource = read('apps/desktop/src/main/index.ts');
const preloadSource = read('apps/desktop/src/preload/index.ts');
const html = read('apps/desktop/src/renderer/index.html');
const protocolsSource = read('apps/desktop/src/main/protocols.ts');

function cspDirective(name: string): string {
  const match = new RegExp(`${name}\\s+([^;"]+)`).exec(html);
  return match?.[1]?.trim() ?? '';
}

describe('BrowserWindow 沙箱配置', () => {
  it('开启 sandbox 与 contextIsolation，关闭 nodeIntegration', () => {
    expect(mainSource).toMatch(/sandbox:\s*true/);
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
    expect(mainSource).toMatch(/webSecurity:\s*true/);
  });

  it('新窗口一律拒绝在应用内打开，只交给系统浏览器', () => {
    expect(mainSource).toContain('setWindowOpenHandler');
    expect(mainSource).toMatch(/action:\s*'deny'/);
    // 外部地址不再靠正则判断，而是走导航策略决策
    expect(mainSource).toContain('decideNavigation');
  });
});

describe('CSP', () => {
  it('默认只允许自身，脚本不允许内联与 eval', () => {
    expect(cspDirective('default-src')).toBe("'self'");
    expect(cspDirective('script-src')).toBe("'self'");
    expect(html).not.toMatch(/unsafe-eval/);
    expect(cspDirective('script-src')).not.toMatch(/unsafe-inline/);
  });

  it('媒体与连接只放开自有协议', () => {
    for (const directive of ['media-src', 'connect-src']) {
      const value = cspDirective(directive);
      expect(value).toContain("'self'");
      expect(value).toContain('hongguo-stream:');
      expect(value).toContain('hongguo-local:');
    }
  });
});

describe('preload 暴露面', () => {
  it('通过 contextBridge 暴露契约化 API，不泄漏 ipcRenderer 或 Node 能力', () => {
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld');
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*'ipcRenderer'/);
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*'require'/);
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*'process'/);
    // 只应暴露契约里声明的方法名
    const exposed = preloadSource.match(/exposeInMainWorld\('api',\s*api\)/);
    expect(exposed).not.toBeNull();
  });

  it('不把真实媒体地址或磁盘路径交给渲染层', () => {
    expect(preloadSource).not.toMatch(/https?:\/\/[a-z0-9.-]*fqnovel/);
    expect(preloadSource).not.toMatch(/savePath|filePath/);
  });
});

describe('自定义协议', () => {
  it('两个协议都不放行 CSP，且声明为标准安全来源', () => {
    expect(protocolsSource).toContain('bypassCSP: false');
    expect(protocolsSource).toMatch(/standard:\s*true/);
    expect(protocolsSource).toMatch(/secure:\s*true/);
  });

  it('只接受 GET/HEAD，其他方法直接 405', () => {
    expect(protocolsSource).toMatch(/\[\s*'GET',\s*'HEAD'\s*\]/);
    expect(protocolsSource).toContain('405');
  });

  it('本地播放走能力 id，路径不落在 URL 上', () => {
    expect(protocolsSource).toContain('mediaAccess.resolveLocal');
    expect(protocolsSource).toContain('mediaAccess.corsHeaders');
  });
});
