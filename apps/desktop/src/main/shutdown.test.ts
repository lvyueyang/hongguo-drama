/**
 * 退出收尾编排（迁移自 4.5 `check-backend-lifecycle.cjs` 的退出部分）。
 * 不变量：顺序（合并在前、下载在中、转码在后）、有界等待、只放行一次、收尾后才真退出。
 */
import { describe, expect, it, vi } from 'vitest';
import { createShutdown, type ShutdownHooks } from './shutdown.ts';

function harness(options: { idleAfter?: number; neverIdle?: boolean } = {}) {
  const calls: string[] = [];
  let busy = 1;
  let clock = 0;
  const hooks: ShutdownHooks = {
    cancelMerges: () => calls.push('cancelMerges'),
    stopDownloads: () => calls.push('stopDownloads'),
    abortTranscodes: () => calls.push('abortTranscodes'),
    isIdle: () => {
      if (options.neverIdle) return false;
      busy -= 1;
      return busy < (options.idleAfter ?? 0);
    },
    quit: () => calls.push('quit'),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
  };
  return { hooks, calls, setBusy: (value: number) => (busy = value) };
}

describe('退出收尾', () => {
  it('按顺序取消合并 → 停下载 → 断转码，落定后退出', async () => {
    const h = harness({ idleAfter: 1 });
    const shutdown = createShutdown(h.hooks, { timeoutMs: 1_000, pollMs: 10 });
    const event = { preventDefault: vi.fn() };
    shutdown.handleBeforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await shutdown.settled();
    expect(h.calls).toEqual(['cancelMerges', 'stopDownloads', 'abortTranscodes', 'quit']);
  });

  it('第二次 before-quit 放行（不再拦截），也不会重复收尾', async () => {
    const h = harness({ idleAfter: 1 });
    const shutdown = createShutdown(h.hooks, { timeoutMs: 1_000, pollMs: 10 });
    const first = { preventDefault: vi.fn() };
    shutdown.handleBeforeQuit(first);
    await shutdown.settled();
    const second = { preventDefault: vi.fn() };
    shutdown.handleBeforeQuit(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call === 'quit')).toHaveLength(1);
    expect(shutdown.inProgress).toBe(true);
  });

  it('一直不落定也有上限：超时照样退出，不把用户卡在应用里', async () => {
    const h = harness({ neverIdle: true });
    const shutdown = createShutdown(h.hooks, { timeoutMs: 100, pollMs: 20 });
    const started = Date.now();
    shutdown.handleBeforeQuit({ preventDefault: () => {} });
    await shutdown.settled();
    expect(h.calls).toContain('quit');
    // 逻辑时钟推进了 100ms 就放弃等待（不是无限循环）
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('已经落定时第一次 before-quit 也会走完一次收尾（幂等：只 quit 一次）', async () => {
    const h = harness({ idleAfter: 0 });
    const shutdown = createShutdown(h.hooks, { timeoutMs: 100, pollMs: 10 });
    shutdown.handleBeforeQuit({ preventDefault: () => {} });
    shutdown.handleBeforeQuit({ preventDefault: () => {} });
    await shutdown.settled();
    expect(h.calls.filter((call) => call === 'quit')).toHaveLength(1);
    expect(h.calls.filter((call) => call === 'stopDownloads')).toHaveLength(1);
  });
});
