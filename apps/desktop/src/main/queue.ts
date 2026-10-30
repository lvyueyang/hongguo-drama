/**
 * 下载队列：并发闸门 + 状态机 + 延迟重试 + 持久化钩子。**不 import electron**，因此可直接单测。
 *
 * 迁移自 4.5 `main.js` 的 `enqueueEpisodes` / `processDownloadQueue` /
 * `armSourceRetry` / `isDeferrableSourceError`，保留这些对外可观察的行为：
 * - 并发数来自设置，超出的任务排队；
 * - 「片源暂时不可用」等可延迟错误会退避重试，并给出重试提示；
 * - 取消是终态，重试不会覆盖取消；
 * - 每个状态变化都会广播，宿主负责转发到渲染层。
 */

export type TaskStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'stopped';

export interface QueueTask {
  id: string;
  vid: string;
  seriesId: string;
  seriesTitle: string;
  /** 目标文件（含目录） */
  savePath: string;
  quality?: string;
  allowLowerQuality?: boolean;
  status: TaskStatus;
  progress: number;
  receivedBytes: number;
  totalBytes: number;
  actualQuality?: string | null;
  qualityNotice?: string;
  error?: string;
  retries: number;
  retryAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QueueEvents {
  progress(task: QueueTask): void;
  completed(task: QueueTask, result: { actualQuality: string; qualityNotice: string }): void;
  failed(task: QueueTask): void;
  stopped(task: QueueTask): void;
  /** 持久化失败：内存已回滚为上次成功落盘的状态 */
  persistFailed?(message: string): void;
}

export interface DownloadQueueOptions {
  concurrency(): number;
  run(
    task: QueueTask,
    context: { signal: AbortSignal; onProgress(received: number, total: number): void },
  ): Promise<{
    actualQuality: string;
    qualityNotice: string;
  }>;
  events: QueueEvents;
  /** 传输类重试退避（毫秒）；数组长度决定最大重试次数 */
  retryDelays?: number[];
  /** 片源不可用类重试退避（毫秒）；与传输类分开，因为前者通常是分钟级 */
  sourceRetryDelays?: number[];
  /** 判断错误是否值得重试；默认：超时/来源不可用/传输中断 */
  isDeferrable?(error: unknown): boolean;
  /** 判断是否属于「片源暂时不可用」（用哪套退避表）；默认看 SOURCE_UNAVAILABLE 与 HTTP 404/410 */
  isSourceUnavailable?(error: unknown): boolean;
  now?(): number;
  /** 上次运行留下的任务（重启后恢复队列） */
  initialTasks?: QueueTask[];
  /** 状态变化时落盘；抛错表示没保存成功，内存会回滚 */
  persist?(tasks: QueueTask[]): void;
  /** 仅在测试里替换定时器 */
  scheduler?(handler: () => void, delayMs: number): unknown;
  cancelScheduler?(handle: unknown): void;
}

// 传输中断通常几秒内可恢复；片源不可用（未上架/被下掉）更可能是分钟级。
const DEFAULT_RETRY_DELAYS = [5_000, 30_000, 120_000];
const DEFAULT_SOURCE_DELAYS = [60_000, 180_000, 600_000];

function defaultIsSourceUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const status = (error as { mediaStatus?: number } | null)?.mediaStatus;
  return code === 'SOURCE_UNAVAILABLE' || status === 404 || status === 410;
}

function describeWait(delayMs: number): string {
  return delayMs >= 60_000 ? `${Math.round(delayMs / 60_000)} 分钟` : `${Math.round(delayMs / 1_000)} 秒`;
}

function defaultIsDeferrable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  if (['TIMEOUT', 'SOURCE_UNAVAILABLE', 'MEDIA_INCOMPLETE', 'ECONNRESET', 'ETIMEDOUT'].includes(code))
    return true;
  const message = String((error as Error | null)?.message ?? '');
  return /超时|不完整|中断|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

export interface DeleteFilesResult {
  deleted: number;
  bytes: number;
  failed: string[];
}

export interface DownloadQueue {
  enqueue(
    tasks: Array<Partial<QueueTask> & { vid: string; seriesId: string; savePath: string }>,
  ): QueueTask[];
  list(): QueueTask[];
  get(id: string): QueueTask | undefined;
  pause(id: string): QueueTask | undefined;
  resume(id: string): QueueTask | undefined;
  /** 返回 false 表示没有该任务；传 deleteFiles 时返回删除结果 */
  remove(
    id: string,
    options?: { deleteFiles?: boolean; deleteFile?: (task: QueueTask) => DeleteFilesResult },
  ): boolean | DeleteFilesResult;
  /** 存储初始化后回填上次任务（构造时可能还没初始化存储） */
  restore(tasks: QueueTask[]): void;
  /** 等待所有已入队任务落定（测试与退出清理用） */
  drain(): Promise<void>;
  stopAll(): void;
}

export function createDownloadQueue(options: DownloadQueueOptions): DownloadQueue {
  const now = options.now ?? Date.now;
  const schedule = options.scheduler ?? ((handler, delay) => setTimeout(handler, delay));
  const cancelSchedule = options.cancelScheduler ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const sourceRetryDelays = options.sourceRetryDelays ?? DEFAULT_SOURCE_DELAYS;
  const isDeferrable = options.isDeferrable ?? defaultIsDeferrable;
  const isSourceUnavailable = options.isSourceUnavailable ?? defaultIsSourceUnavailable;
  const clone = (list: QueueTask[]): QueueTask[] => list.map((task) => ({ ...task }));
  const tasks: QueueTask[] = clone(options.initialTasks ?? []);
  // 上一次成功落盘的内容：持久化失败时内存要回滚到它，避免界面显示"没保存的任务"。
  let durable = clone(tasks);
  const running = new Map<string, AbortController>();
  const retryTimers = new Map<string, unknown>();
  const waiters: Array<() => void> = [];

  const settle = (): void => {
    if (
      running.size === 0 &&
      !tasks.some((task) => task.status === 'pending' || task.status === 'downloading')
    ) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  };

  const touch = (task: QueueTask): QueueTask => {
    task.updatedAt = now();
    return task;
  };

  function commit(): void {
    if (!options.persist) {
      durable = clone(tasks);
      return;
    }
    try {
      options.persist(clone(tasks));
      durable = clone(tasks);
    } catch (error) {
      tasks.length = 0;
      // 回滚的内容里如果有「下载中」，那不是真的在跑（running 里没有它），
      // 直接留着会永久卡住；统一放回 pending 让 pump 重新调度。
      tasks.push(
        ...clone(durable).map((task) =>
          task.status === 'downloading' ? { ...task, status: 'pending' as const } : task,
        ),
      );
      options.events.persistFailed?.((error as Error).message || '任务记录保存失败');
    }
  }

  function pump(): void {
    const limit = Math.max(1, Number(options.concurrency()) || 1);
    while (running.size < limit) {
      // 处于退避等待中的任务不能立刻重启，否则重试退避形同虚设
      const next = tasks.find((task) => task.status === 'pending' && !(task.retryAt && task.retryAt > now()));
      if (!next) break;
      void start(next);
    }
    settle();
  }

  async function start(task: QueueTask): Promise<void> {
    const controller = new AbortController();
    running.set(task.id, controller);
    delete task.retryAt;
    task.status = 'downloading';
    task.progress = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;
    task.error = undefined;
    touch(task);

    try {
      const result = await options.run(task, {
        signal: controller.signal,
        onProgress: (received, total) => {
          task.receivedBytes = received;
          task.totalBytes = total;
          task.progress = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
          touch(task);
          options.events.progress(task);
        },
      });
      task.actualQuality = result.actualQuality;
      task.qualityNotice = result.qualityNotice;
      task.status = 'completed';
      task.progress = 100;
      touch(task);
      commit();
      options.events.completed(task, result);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = (error as Error | null)?.message ?? '下载失败';
      if (cancelled) {
        task.status = 'stopped';
        task.error = '';
        touch(task);
        options.events.stopped(task);
      } else if (
        isDeferrable(error) &&
        task.retries < (isSourceUnavailable(error) ? sourceRetryDelays : retryDelays).length
      ) {
        // 两套退避表：片源不可用是分钟级，传输中断是秒级。
        const delays = isSourceUnavailable(error) ? sourceRetryDelays : retryDelays;
        const delay = delays[task.retries] ?? delays.at(-1) ?? 5_000;
        task.retries += 1;
        task.status = 'pending';
        task.retryAt = now() + delay;
        task.error = `${message} 将在 ${describeWait(delay)}后自动重试（${task.retries}/${delays.length}）`;
        touch(task);
        commit();
        options.events.failed(task);
        retryTimers.set(
          task.id,
          schedule(() => {
            retryTimers.delete(task.id);
            // 计时器才是退避的凭据：不依赖墙钟，避免定时器早触发时被自己挡住。
            task.retryAt = null;
            pump();
          }, delay),
        );
      } else {
        task.status = 'failed';
        // 预算用尽或不可重试：清掉重试时间，避免界面继续显示「即将重试」。
        task.retryAt = null;
        task.error = message;
        touch(task);
        commit();
        options.events.failed(task);
      }
    } finally {
      running.delete(task.id);
      pump();
    }
  }

  return {
    enqueue(input) {
      const created = input.map((item) => {
        const task: QueueTask = {
          id: item.id ?? `task-${now()}-${tasks.length + 1}`,
          vid: String(item.vid),
          seriesId: String(item.seriesId),
          seriesTitle: item.seriesTitle ?? '',
          savePath: item.savePath,
          quality: item.quality,
          allowLowerQuality: item.allowLowerQuality,
          status: 'pending',
          progress: 0,
          receivedBytes: 0,
          totalBytes: 0,
          actualQuality: null,
          retries: 0,
          retryAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        tasks.push(task);
        return task;
      });
      commit();
      pump();
      return created;
    },

    list: () => tasks.map((task) => ({ ...task })),

    get: (id) => tasks.find((task) => task.id === id),

    pause(id) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) return undefined;
      running.get(id)?.abort();
      commit();
      const timer = retryTimers.get(id);
      if (timer) {
        cancelSchedule(timer);
        retryTimers.delete(id);
      }
      if (task.status === 'pending' || task.status === 'downloading') {
        task.status = 'stopped';
        task.error = '';
        touch(task);
      }
      return task;
    },

    resume(id) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task || task.status !== 'stopped') return task;
      task.status = 'pending';
      task.retries = 0;
      task.retryAt = null;
      touch(task);
      pump();
      return task;
    },

    remove(id, options: { deleteFiles?: boolean; deleteFile?: (task: QueueTask) => DeleteFilesResult } = {}) {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return false;
      const task = tasks[index]!;
      running.get(id)?.abort();
      const timer = retryTimers.get(id);
      if (timer) {
        cancelSchedule(timer);
        retryTimers.delete(id);
      }
      tasks.splice(index, 1);
      let fileResult: DeleteFilesResult | null = null;
      if (options.deleteFiles === true) fileResult = options.deleteFile?.(task) ?? null;
      commit();
      settle();
      return fileResult ?? true;
    },

    restore(input) {
      tasks.length = 0;
      tasks.push(...clone(input ?? []));
      durable = clone(tasks);
      pump();
    },

    drain() {
      // 退避等待中的任务也算「未落定」，drain 必须等它重试完
      if (
        running.size === 0 &&
        !tasks.some((task) => task.status === 'pending' || task.status === 'downloading')
      ) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },

    stopAll() {
      for (const [id, controller] of running) {
        controller.abort();
        const task = tasks.find((entry) => entry.id === id);
        if (task) task.status = 'stopped';
      }
      for (const timer of retryTimers.values()) cancelSchedule(timer);
      retryTimers.clear();
    },
  };
}
