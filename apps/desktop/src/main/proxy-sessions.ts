/**
 * 代理与更新会话（迁移自 4.5 `check-app-update-proxy.cjs` 的不变量）。
 *
 * 三条必须守住的规则：
 * 1. **更新自己的网络会话也要走代理**：只给窗口会话设代理时，更新请求会绕过代理直连；
 * 2. **切换代理后必须断开旧连接**：否则已建立的连接继续走旧线路（用户以为切了其实没切）；
 * 3. **认证只交给更新主机**：代理凭据不能在无关的认证挑战里被发出去。
 *
 * 抽成不依赖 Electron 的纯逻辑，便于断言。
 */

export interface ProxySessionLike {
  setProxy(config: unknown): Promise<void> | void;
  closeAllConnections?(): void;
}

export interface ApplyProxyDeps {
  windowSession: ProxySessionLike;
  /** 更新器自己的会话；某些环境下不存在（例如未打包运行） */
  updateSession?(): ProxySessionLike | undefined;
  logger?: { warn(message: string): void };
}

/**
 * 把同一份代理配置应用到窗口会话与更新会话，并断开两者的旧连接。
 * 更新会话的任何失败都不影响窗口会话（窗口能用是底线）。
 */
export function createProxySessionApplier(deps: ApplyProxyDeps): (config: unknown) => Promise<boolean> {
  return async (config: unknown) => {
    let allApplied = true;
    try {
      await deps.windowSession.setProxy(config);
    } catch (error) {
      allApplied = false;
      deps.logger?.warn(`窗口会话代理设置失败: ${(error as Error).message}`);
    }
    const update = deps.updateSession?.();
    if (update) {
      try {
        await update.setProxy(config);
        // 更新会话刚换了线路：旧连接必须丢掉，否则仍走老代理。
        await update.closeAllConnections?.();
      } catch (error) {
        allApplied = false;
        deps.logger?.warn(`更新会话代理设置失败: ${(error as Error).message}`);
      }
    }
    try {
      await deps.windowSession.closeAllConnections?.();
    } catch {
      /* 断开旧连接失败不影响配置生效 */
    }
    return allApplied;
  };
}

export interface ProxyLoginDetails {
  host: string;
  realm?: string;
}

export interface ProxyLoginCredentials {
  username: string;
  password: string;
}

/**
 * 更新会话的代理认证回调。
 * 只在挑战主机**正是**更新服务主机时给出凭据；其余一律不提供（返回 false）。
 */
export function decideProxyCredentials(
  details: ProxyLoginDetails | undefined,
  credentials: ProxyLoginCredentials | undefined,
  allowedHosts: string[],
): ProxyLoginCredentials | false {
  if (!credentials?.username) return false;
  const host = String(details?.host ?? '')
    .trim()
    .toLowerCase();
  if (!host) return false;
  const allowed = allowedHosts.map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host)) return false;
  return credentials;
}
