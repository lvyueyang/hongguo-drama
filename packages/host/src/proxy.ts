/**
 * 代理配置解析（迁移自 4.5 `main.js` 的 resolveProxyConfig / applyProxyToEnv /
 * proxyRuleForSession / snapshotProxyUrl）。
 *
 * 三条容易踩的规则原样保留：
 * - `proxy_enabled !== true` 或 `mode: 'direct'` → 一律直连；
 * - `system` 必须读**启动时的环境变量快照**，否则会把上一次手动/直连的改写当成系统代理；
 * - Chromium 的 proxyRules 会忽略 URL 里的账号密码，认证必须单独给出（login 事件用）。
 */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

export interface ProxySettings {
  proxy_enabled?: boolean;
  proxy_mode?: 'system' | 'custom' | 'direct';
  proxy_host?: string;
  proxy_port?: string | number;
  proxy_username?: string;
  proxy_password?: string;
}

export interface ResolvedProxy {
  mode: 'direct' | 'system' | 'custom';
  /** 完整的代理地址（含凭据）；`null` 表示该模式下没有可用代理 */
  url: string | null;
  /** 给 Chromium session.setProxy 用的规则（不含凭据） */
  rule?: string;
  /** 给登录挑战用的凭据 */
  auth?: { host: string; port: number; username: string; password: string } | null;
}

export function snapshotProxyEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) snapshot[key] = env[key];
  return snapshot;
}

/** 把 `host`（可能带 scheme、路径或已含端口）与单独的 `port` 组合成规范化 URL。 */
export function buildProxyUrl(settings: ProxySettings): string | null {
  const host = String(settings.proxy_host ?? '').trim();
  const port = String(settings.proxy_port ?? '').trim();
  if (!host) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    if (!port && !/:\d+\/?$/.test(host)) return null;
    if (port) {
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
      url.port = port;
    }
    const username = String(settings.proxy_username ?? '').trim();
    if (username) {
      url.username = encodeURIComponent(username);
      url.password = encodeURIComponent(String(settings.proxy_password ?? ''));
    } else {
      url.username = '';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** 从启动快照里按代理环境变量规则挑出一个地址（对齐 proxy-from-env 的优先级）。 */
export function snapshotProxyUrl(snapshot: Record<string, string | undefined>): string | null {
  const read = (key: string): string => String(snapshot[key] ?? '').trim();
  const https = read('https_proxy') || read('HTTPS_PROXY');
  const http = read('http_proxy') || read('HTTP_PROXY');
  const all = read('all_proxy') || read('ALL_PROXY');
  const picked = https || http || all;
  return picked || null;
}

export function resolveProxyConfig(
  settings: ProxySettings | null | undefined,
  snapshot: Record<string, string | undefined> = {},
): ResolvedProxy {
  const s = settings ?? {};
  if (s.proxy_enabled !== true) return { mode: 'direct', url: null };
  const mode = s.proxy_mode ?? 'system';
  if (mode === 'direct') return { mode: 'direct', url: null };
  if (mode === 'custom') {
    const url = buildProxyUrl(s);
    return url ? { mode: 'custom', url, ...ruleOf(url) } : { mode: 'custom', url: null };
  }
  const url = snapshotProxyUrl(snapshot);
  return url ? { mode: 'system', url, ...ruleOf(url) } : { mode: 'system', url: null };
}

/** 拆出 Chromium 规则与登录凭据；IPv6 需要补方括号。 */
export function ruleOf(url: string): Pick<ResolvedProxy, 'rule' | 'auth'> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { rule: undefined, auth: null };
  }
  const protocol = (parsed.protocol || 'http:').replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostname = host.includes(':') ? `[${host}]` : host;
  if (!hostname) return { rule: undefined, auth: null };
  const port = parsed.port;
  return {
    rule: port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`,
    auth: parsed.username
      ? {
          host,
          port: port ? Number(port) : protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80,
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password || ''),
        }
      : null,
  };
}

/** 生成新的环境变量表：system 还原快照，custom 写入代理（除 no_proxy 外），direct 清空。 */
export function envWithProxy(
  env: Record<string, string | undefined>,
  resolved: ResolvedProxy,
  snapshot: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  for (const key of PROXY_ENV_KEYS) {
    if (resolved.mode === 'system') {
      if (snapshot[key] !== undefined) next[key] = snapshot[key];
      else delete next[key];
    } else if (resolved.mode === 'custom' && resolved.url && key.toLowerCase() !== 'no_proxy') {
      next[key] = resolved.url;
    } else {
      delete next[key];
    }
  }
  return next;
}

/** axios 的 proxy 选项形状；`false` 表示显式直连。 */
export function axiosProxyOption(
  resolved: ResolvedProxy,
): false | { protocol: string; host: string; port: number; auth?: { username: string; password: string } } {
  if (!resolved.url) return false;
  try {
    const url = new URL(resolved.url);
    const option = {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    } as { protocol: string; host: string; port: number; auth?: { username: string; password: string } };
    if (url.username) {
      option.auth = {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
    return option;
  } catch {
    return false;
  }
}
