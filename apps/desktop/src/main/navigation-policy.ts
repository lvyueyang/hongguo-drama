/**
 * 导航与权限策略（补上 4.5 `renderer-security.js` 里的导航/弹窗/权限守卫）。
 *
 * 重构时窗口弹窗守卫被保留了，但**导航守卫与权限请求处理缺失**：
 * 页面内任何 script/link 触发的跳转都会在应用窗口里加载外部站点，
 * 而摄像头/麦克风/定位等权限请求会直接走 Chromium 默认行为。
 * 这里把策略抽成纯函数，便于断言且不依赖真实窗口。
 */

export type NavigationDecision = 'allow' | 'external' | 'block';

export interface NavigationContext {
  /** 允许在应用窗口内加载的来源（开发服务器与打包后的 file 页面） */
  appOrigins: string[];
  /**
   * 允许的本地页面入口（打包后是 out/renderer/index.html）。
   * 只放行名单内的 file: 地址：任意本地文件（用户下载的 HTML、挂载的网盘页面）都不算应用自身。
   */
  appFiles?: string[];
}

/** 判断某个 URL 是否属于应用自身（含 file 协议与空来源）。 */
export function isAppUrl(target: string, context: NavigationContext): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  // 只认名单内的本地入口与显式列出的应用来源；不要放行 origin === 'null'——
  // javascript:/data: 这类 URL 的 origin 也是 'null'，放行等于把脚本注入当自家页面。
  if (url.protocol === 'file:') {
    const allowed = context.appFiles ?? [];
    if (!allowed.length) return false;
    const target = decodeURIComponent(url.pathname).replace(/\\/g, '/');
    return allowed.some((file) => {
      const entry = String(file).replace(/\\/g, '/');
      return target === entry || target.endsWith(entry);
    });
  }
  return context.appOrigins.includes(url.origin);
}

/**
 * - 应用自身地址：允许（页面内路由）；
 * - 外部的 http(s)：交给系统浏览器（窗口内不加载）；
 * - 其它协议（file 之外的 custom/javascript/data 等）：直接拒绝。
 */
export function decideNavigation(target: string, context: NavigationContext): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'block';
  }
  if (isAppUrl(target, context)) return 'allow';
  if (url.protocol === 'https:' || url.protocol === 'http:') return 'external';
  return 'block';
}

/**
 * 权限策略（与 4.5 `main.js` 的 `web-contents-created` 处理一致）：
 * - 只有**可信主 frame**（应用自己的页面 + 主窗口）才能拿全屏与剪贴板；
 * - 摄像头/麦克风/定位/通知这些一律不授权，无论请求来自哪里。
 *
 * 为什么必须放行这三项：播放器「切换全屏」快捷键走的是 `requestFullscreen()`，
 * 复制分享链接/粘贴分享链接用剪贴板；一律拒绝等于把这三个功能默默弄坏（页面只能静默失败）。
 */
export const TRUSTED_PERMISSIONS = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'] as const;

export interface PermissionContext {
  /** 请求是否来自应用自己的主 frame */
  trusted: boolean;
}

/** 除上面三项之外一律拒绝，包括未知权限（宁缺勿滥）。 */
export function decidePermission(
  permission: string,
  context: PermissionContext = { trusted: false },
): boolean {
  if (context.trusted !== true) return false;
  return (TRUSTED_PERMISSIONS as readonly string[]).includes(permission);
}

/** 权限请求是否来自应用自己的主 frame（子 frame、外部地址、拿不到详情都不算）。 */
export function isTrustedPermissionRequest(
  details: { isMainFrame?: boolean; requestingUrl?: string } | null | undefined,
  context: NavigationContext,
): boolean {
  if (!details || details.isMainFrame !== true) return false;
  const target = String(details.requestingUrl ?? '');
  if (!target) return false;
  return decideNavigation(target, context) === 'allow';
}

export default {
  decideNavigation,
  decidePermission,
  isAppUrl,
  isTrustedPermissionRequest,
  TRUSTED_PERMISSIONS,
};
