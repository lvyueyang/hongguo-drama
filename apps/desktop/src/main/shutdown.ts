/**
 * 退出前的收尾编排（4.5 `main.js` 的 `before-quit` 那套）。
 *
 * 4.5 会：取消在飞合并/转码 → 停下载与重试排期 → 等临时文件清理（有界）→ 再真正退出。
 * 重构后这段整条丢了：`quitInProgress` 是个常量 `false`，退出时在飞任务直接被进程带走，
 * 留下半截临时文件与「下载中」的记录（下次启动还能看到幽灵任务）。
 *
 * 抽成模块的原因：真实 Electron 的退出流程没法在测试里跑（`before-quit` + 进程退出），
 * 而这里的顺序与超时恰恰是最容易写错的（先删文件后停任务、无界等待卡住用户）。
 */

export interface ShutdownHooks {
  /** 取消所有在飞合并（合并会读源文件，必须先停） */
  cancelMerges(): void;
  /** 停下载：中止在飞请求，并且不再排期重试 */
  stopDownloads(): void;
  /** 中断转码子进程 */
  abortTranscodes(): void;
  /** 还有没有在飞的工作（停止后到真正落定之间会有延迟） */
  isIdle(): boolean;
  /** 真正退出（再次触发 quit 时 shouldBlock 已放行） */
  quit(): void;
  /** 测试注入 */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface ShutdownOptions {
  /** 有界等待上限：超时也退出，绝不无限期卡住用户 */
  timeoutMs?: number;
  /** 轮询间隔 */
  pollMs?: number;
}

export interface ShutdownController {
  /** 已经进入退出流程（用于阻止更新安装等操作插队） */
  readonly inProgress: boolean;
  /** 处理 `before-quit`：第一次拦截并收尾，收尾完再放行 */
  handleBeforeQuit(event: { preventDefault(): void }): void;
  /** 等到收尾结束（测试用；也便于宿主在别处 await） */
  settled(): Promise<void>;
}

/** 需要收尾的默认判定：合并/转码/下载任一在飞都要等。 */
export function createShutdown(hooks: ShutdownHooks, options: ShutdownOptions = {}): ShutdownController {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10_000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 50;
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let inProgress = false;
  let pending: Promise<void> | null = null;

  async function drain(): Promise<void> {
    // 顺序是有意的：先取消合并（它在读源文件），再停下载（可能在写目标文件），最后断转码。
    hooks.cancelMerges();
    hooks.stopDownloads();
    hooks.abortTranscodes();
    const deadline = now() + timeoutMs;
    while (!hooks.isIdle()) {
      if (now() >= deadline) return; // 超时也退出：宁可留临时文件，也不能让用户等不到退出
      await sleep(pollMs);
    }
  }

  return {
    get inProgress() {
      return inProgress;
    },
    handleBeforeQuit(event) {
      if (inProgress) return; // 第二次进入：收尾已完成，放行
      event.preventDefault();
      inProgress = true;
      pending = drain().finally(() => {
        hooks.quit();
      });
    },
    settled() {
      return pending ?? Promise.resolve();
    },
  };
}
