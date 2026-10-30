/**
 * 导航与权限策略（补 4.5 `check-renderer-security.cjs` 的导航/权限部分）。
 * 这些是安全边界：外部跳转不能接管应用窗口，敏感权限一律不授权。
 */
import { describe, expect, it, vi } from 'vitest';
import { decideNavigation, decidePermission, isAppUrl } from './navigation-policy.ts';

const context = { appOrigins: ['http://localhost:5173'] };

describe('isAppUrl', () => {
  it('开发服务器与打包后的 file 页面算应用自身', () => {
    expect(isAppUrl('http://localhost:5173/index.html', context)).toBe(true);
    expect(isAppUrl('file:///Applications/app/out/renderer/index.html', context)).toBe(true);
  });

  it('外部站点不算', () => {
    expect(isAppUrl('https://example.com/', context)).toBe(false);
    expect(isAppUrl('http://localhost:5174/', context)).toBe(false);
  });

  it('畸形地址不算', () => {
    expect(isAppUrl('not a url', context)).toBe(false);
    expect(isAppUrl('', context)).toBe(false);
  });
});

describe('decideNavigation', () => {
  it('应用内跳转允许', () => {
    expect(decideNavigation('http://localhost:5173/detail?series_id=1', context)).toBe('allow');
  });

  it('外部 http(s) 交给系统浏览器，不在窗口内加载', () => {
    expect(decideNavigation('https://github.com/jackotom/hongguo-drama', context)).toBe('external');
    expect(decideNavigation('http://example.com/', context)).toBe('external');
  });

  it('其它协议一律拒绝（含 javascript:/data:/自定义协议）', () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'hongguo-stream://play/x',
      'hongguo-local://f/x',
      'ftp://example.com/a',
      'about:blank',
    ]) {
      expect(decideNavigation(target, context), target).toBe('block');
    }
  });

  it('畸形地址拒绝而不是放行', () => {
    expect(decideNavigation('http://[invalid', context)).toBe('block');
  });
});

describe('decidePermission', () => {
  it('摄像头/麦克风/定位/通知一律不授权', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'midi',
      'clipboard-read',
      'openExternal',
    ]) {
      expect(decidePermission(permission), permission).toBe(false);
    }
  });
});

describe('主进程接线（源码断言）', () => {
  it('窗口注册了导航守卫与权限处理，且策略来自本模块', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(source).toContain('will-navigate');
    expect(source).toContain('setPermissionRequestHandler');
    expect(source).toContain('decideNavigation');
    expect(source).toContain('decidePermission');
    void vi;
  });
});
