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
}

/** 判断某个 URL 是否属于应用自身（含 file 协议与空来源）。 */
export function isAppUrl(target: string, context: NavigationContext): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  // 只认 file: 与显式列出的应用来源；不要放行 origin === 'null'——
  // javascript:/data: 这类 URL 的 origin 也是 'null'，放行等于把脚本注入当自家页面。
  if (url.protocol === 'file:') return true;
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

/** 播放/下载都不需要敏感权限：一律拒绝，避免误授权。 */
export function decidePermission(permission: string): boolean {
  void permission;
  return false;
}
