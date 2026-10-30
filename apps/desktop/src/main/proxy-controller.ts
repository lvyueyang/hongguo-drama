/**
 * 代理应用编排（迁移自 4.5 `main.js` 的 applyProxyToSession / applyProxyWithTimeout 段）。
 *
 * 纯逻辑，依赖全部注入，可离线测试。守住的三条行为：
 * - **环境变量先于会话生效**：解析出结果就同步改写进程环境，避免会话生效前有请求走错出口；
 * - **会话应用有超时**：原生 setProxy 卡住时回落到直连，不能把应用挂在半路；
 * - **迟到完成不覆盖新状态**：每次应用带代号，旧代号完成时重新应用最新配置。
 */
import { envWithProxy, type ProxySettings, type ResolvedProxy, resolveProxyConfig } from '@hongguo/host';

export interface SessionProxyConfig {
  mode: 'direct' | 'system' | 'fixed_servers';
  proxyRules?: string;
}

export interface ProxyControllerDeps {
  readSettings(): ProxySettings;
  /** 启动时的代理环境变量快照 */
  snapshot: Record<string, string | undefined>;
  /** 进程环境（原地改写） */
  env: Record<string, string | undefined>;
  applyToSession(config: SessionProxyConfig): Promise<void>;
  logger?: { warn(message: string): void };
  /** 会话应用超时（毫秒） */
  timeoutMs?: number;
  now?(): number;
}

export interface ProxyApplyResult {
  mode: ResolvedProxy['mode'];
  rule?: string;
  /** 会话应用超时后退回直连 */
  fallback?: boolean;
  error?: string;
}

export interface ProxyController {
  apply(): Promise<ProxyApplyResult>;
  current(): ProxyApplyResult | null;
  /** 配置无效（例如自定义模式缺少地址）时不改写环境、也不动会话 */
  resolve(): ResolvedProxy;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!(timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('代理应用超时')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function sessionConfigOf(resolved: ResolvedProxy): SessionProxyConfig {
  if (resolved.mode === 'custom' && resolved.rule) {
    return { mode: 'fixed_servers', proxyRules: resolved.rule };
  }
  return { mode: resolved.mode === 'direct' ? 'direct' : 'system' };
}

export function createProxyController(deps: ProxyControllerDeps): ProxyController {
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 0;
  const warn = deps.logger?.warn ?? (() => {});
  let generation = 0;
  let last: ProxyApplyResult | null = null;

  const resolve = (): ResolvedProxy => resolveProxyConfig(deps.readSettings(), deps.snapshot);

  function writeEnv(resolved: ResolvedProxy): void {
    const next = envWithProxy(deps.env, resolved, deps.snapshot);
    for (const key of Object.keys(deps.env)) {
      if (!(key in next)) delete deps.env[key];
    }
    Object.assign(deps.env, next);
  }

  async function applySession(config: SessionProxyConfig, appliedGeneration: number): Promise<void> {
    try {
      await withTimeout(deps.applyToSession(config), timeoutMs);
    } catch (error) {
      warn(`代理应用失败: ${(error as Error).message}`);
      throw error;
    }
    // 迟到的完成不能把新配置顶掉：用当前最新配置再应用一次。
    if (appliedGeneration !== generation) {
      const latest = resolve();
      await withTimeout(deps.applyToSession(sessionConfigOf(latest)), timeoutMs);
    }
  }

  return {
    resolve,

    async apply() {
      const resolved = resolve();
      const appliedGeneration = ++generation;

      if (resolved.mode === 'custom' && !resolved.url) {
        // 配置不完整：不改环境、不动会话，交给调用方提示用户。
        last = { mode: 'custom', error: '请填写完整的代理地址与端口' };
        return last;
      }

      writeEnv(resolved);
      const config = sessionConfigOf(resolved);
      try {
        await applySession(config, appliedGeneration);
        last = { mode: resolved.mode, rule: resolved.rule };
        return last;
      } catch (error) {
        // 会话失败时回落到直连，并把环境变量也改回直连，避免"环境走代理、会话直连"的半吊子状态。
        writeEnv({ mode: 'direct', url: null });
        try {
          await applySession({ mode: 'direct' }, appliedGeneration);
        } catch {
          /* 回落也失败时保持现状并已记录日志 */
        }
        last = { mode: 'direct', fallback: true, error: (error as Error).message };
        return last;
      }
    },

    current: () => last,
  };
}
