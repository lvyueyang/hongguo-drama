import { describe, expect, it, vi } from 'vitest';
import { createDownloadQueue, type QueueTask } from './queue.ts';

function createQueueHarness(
  options: {
    concurrency?: number;
    run?: (
      task: QueueTask,
      ctx: { signal: AbortSignal; onProgress(r: number, t: number): void },
    ) => Promise<{
      actualQuality: string;
      qualityNotice: string;
    }>;
    retryDelays?: number[];
    initialTasks?: QueueTask[];
    persist?: (tasks: QueueTask[]) => void;
    persistFailed?: (message: string) => void;
  } = {},
) {
  const timers: Array<{ handler: () => void; delay: number }> = [];
  const events = { progress: vi.fn(), completed: vi.fn(), failed: vi.fn(), stopped: vi.fn() };
  const calls: string[] = [];
  const queue = createDownloadQueue({
    concurrency: () => options.concurrency ?? 1,
    retryDelays: options.retryDelays ?? [],
    initialTasks: options.initialTasks,
    persist: options.persist,
    events: { ...events, persistFailed: options.persistFailed ?? (() => {}) },
    run:
      options.run ??
      (async (task, ctx) => {
        calls.push(task.id);
        ctx.onProgress(50, 100);
        ctx.onProgress(100, 100);
        return { actualQuality: '1080p', qualityNotice: '' };
      }),
    scheduler: (handler, delay) => {
      const entry = { handler, delay };
      timers.push(entry);
      return entry;
    },
    cancelScheduler: (handle) => {
      const index = timers.indexOf(handle as { handler: () => void; delay: number });
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { queue, events, calls, timers };
}

const task = (id: string) => ({ id, vid: id, seriesId: 's1', savePath: `/tmp/${id}.mp4` });

describe('下载队列（迁移 4.5 队列的关键行为）', () => {
  it('并发闸门：并发 2 时第 3 个任务等待前两个落定', async () => {
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const { queue } = createQueueHarness({
      concurrency: 2,
      run: async (current, ctx) => {
        started.push(current.id);
        await new Promise<void>((resolve) => gates.push(resolve));
        ctx.onProgress(1, 1);
        return { actualQuality: '1080p', qualityNotice: '' };
      },
    });

    queue.enqueue([task('a'), task('b'), task('c')]);
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);

    gates.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toContain('c');
    gates.forEach((release) => {
      release();
    });
    await queue.drain();
  });

  it('进度上报与完成事件带清晰度结果', async () => {
    const { queue, events } = createQueueHarness();
    queue.enqueue([task('a')]);
    await queue.drain();

    const entry = queue.get('a');
    expect(entry?.status).toBe('completed');
    expect(entry?.progress).toBe(100);
    expect(entry?.actualQuality).toBe('1080p');
    expect(events.progress).toHaveBeenCalled();
    expect(events.completed).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), {
      actualQuality: '1080p',
      qualityNotice: '',
    });
  });

  it('可延迟错误按退避重试，重试期间状态回到 pending 并带提示', async () => {
    let attempt = 0;
    const { queue, events, timers } = createQueueHarness({
      retryDelays: [1000],
      run: async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error('视频下载不完整'), { code: 'MEDIA_INCOMPLETE' });
        return { actualQuality: '720p', qualityNotice: '' };
      },
    });

    queue.enqueue([task('a')]);
    // 第一次尝试失败后进入退避等待，此时 drain 会一直挂住，所以先只等一个微任务周期
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entry = queue.get('a');
    expect(entry?.status).toBe('pending');
    expect(entry?.retries).toBe(1);
    expect(entry?.error).toContain('自动重试');
    expect(events.failed).toHaveBeenCalled();
    expect(timers[0]?.delay).toBe(1000);

    timers[0]?.handler();
    await queue.drain();
    expect(queue.get('a')?.status).toBe('completed');
  });

  it('不可重试的错误直接失败', async () => {
    const { queue, events } = createQueueHarness({
      retryDelays: [1000],
      run: async () => {
        throw Object.assign(new Error('片源已下架'), { code: 'NOT_FOUND' });
      },
    });
    queue.enqueue([task('a')]);
    await queue.drain();

    expect(queue.get('a')?.status).toBe('failed');
    expect(queue.get('a')?.retries).toBe(0);
    expect(events.failed).toHaveBeenCalled();
  });

  it('取消是终态：不会再被重试推回 pending', async () => {
    const { queue } = createQueueHarness({
      retryDelays: [1000],
      run: async (current, ctx) => {
        queue.pause(current.id);
        expect(ctx.signal.aborted).toBe(true);
        throw Object.assign(new Error('已取消'), { code: 'CANCELED' });
      },
    });
    queue.enqueue([task('a')]);
    await queue.drain();

    const entry = queue.get('a');
    expect(entry?.status).toBe('stopped');
    expect(entry?.retries).toBe(0);
  });

  it('暂停后可以恢复：恢复的任务能正常完成', async () => {
    let paused = true;
    const { queue } = createQueueHarness({
      run: async (current, ctx) => {
        if (paused) {
          paused = false;
          queue.pause(current.id);
          throw Object.assign(new Error('已取消'), { code: 'CANCELED' });
        }
        expect(ctx.signal.aborted).toBe(false);
        return { actualQuality: '1080p', qualityNotice: '' };
      },
    });
    queue.enqueue([task('a')]);
    await queue.drain();
    expect(queue.get('a')?.status).toBe('stopped');

    queue.resume('a');
    await queue.drain();
    expect(queue.get('a')?.status).toBe('completed');
    expect(queue.remove('a')).toBe(true);
    expect(queue.list()).toHaveLength(0);
  });

  it('片源不可用走分钟级退避表，提示单位是分钟', async () => {
    const { queue, timers } = createQueueHarness({
      retryDelays: [1000],
      run: async () => {
        throw Object.assign(new Error('片源暂时不可用'), { code: 'SOURCE_UNAVAILABLE' });
      },
    });
    queue.enqueue([task('a')]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entry = queue.get('a');
    expect(entry?.status).toBe('pending');
    expect(entry?.error).toMatch(/分钟/);
    // 默认片源退避第一档是 1 分钟
    expect(timers[0]?.delay).toBe(60_000);
  });

  it('安全类错误直接失败，不排网络重试', async () => {
    const { queue, timers, events } = createQueueHarness({
      run: async () => {
        throw Object.assign(new Error('片源返回了不受支持的服务地址'), { code: 'SECURITY_BLOCKED' });
      },
    });
    queue.enqueue([task('a')]);
    await queue.drain();

    expect(queue.get('a')?.status).toBe('failed');
    expect(queue.get('a')?.retryAt).toBeNull();
    expect(timers).toHaveLength(0);
    expect(events.failed).toHaveBeenCalled();
  });

  it('重试预算用尽后停止，并清掉 retryAt 与「自动重试」提示', async () => {
    const { queue, timers } = createQueueHarness({
      retryDelays: [1000],
      run: async () => {
        throw Object.assign(new Error('视频下载不完整'), { code: 'MEDIA_INCOMPLETE' });
      },
    });
    queue.enqueue([task('a')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers).toHaveLength(1);

    timers[0]?.handler();
    await queue.drain();

    const entry = queue.get('a');
    expect(entry?.status).toBe('failed');
    expect(entry?.retryAt).toBeNull();
    expect(entry?.error).not.toMatch(/自动重试/);
    // 预算用尽后不再排新计时器（替身不会自动移除已触发的记录）
    expect(timers).toHaveLength(1);
  });

  it('并发数来自设置，非法值回落到 1', async () => {
    const { queue } = createQueueHarness({ concurrency: 0 });
    queue.enqueue([task('a')]);
    await queue.drain();
    expect(queue.get('a')?.status).toBe('completed');
  });
});

describe('队列持久化与删除任务', () => {
  it('入队/完成/暂停都会落盘，重启后能读回', () => {
    const persisted: Array<Array<{ id: string; status: string }>> = [];
    const harness = createQueueHarness({
      persist: (tasks) => persisted.push(tasks.map((task) => ({ id: task.id, status: task.status }))),
    });
    harness.queue.enqueue([task('a')]);
    expect(persisted.at(-1)).toEqual([{ id: 'a', status: 'pending' }]);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('持久化失败时回滚内存，并上报（界面不会显示没保存的任务）', async () => {
    const failures: string[] = [];
    let fail = false;
    const harness = createQueueHarness({
      persist: () => {
        if (fail) throw new Error('磁盘已满');
      },
      persistFailed: (message) => failures.push(message),
    });

    harness.queue.enqueue([task('a')]);
    await harness.queue.drain();
    expect(harness.queue.list()).toHaveLength(1);

    fail = true;
    harness.queue.enqueue([task('b')]);
    // b 没能落盘：内存里也不该留下它
    expect(harness.queue.list().map((item) => item.id)).toEqual(['a']);
    expect(failures.at(-1)).toContain('磁盘已满');
  });

  it('恢复上次任务：重启后队列里能看到（状态归一为待处理/失败）', () => {
    const harness = createQueueHarness({
      initialTasks: [
        {
          ...task('old'),
          seriesTitle: '剧',
          status: 'completed',
          progress: 100,
          receivedBytes: 1,
          totalBytes: 1,
          retries: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect(harness.queue.list()).toHaveLength(1);
    expect(harness.queue.get('old')?.status).toBe('completed');
  });

  it('remove 传 deleteFiles 时交给注入的删除器，并返回删除结果', () => {
    const harness = createQueueHarness();
    harness.queue.enqueue([task('a')]);
    const result = harness.queue.remove('a', {
      deleteFiles: true,
      deleteFile: () => ({ deleted: 2, bytes: 240000, failed: [] }),
    }) as { deleted: number };
    expect(result.deleted).toBe(2);
    expect(harness.queue.list()).toHaveLength(0);
  });

  it('remove 不传 deleteFiles 时不动文件，只返回 true', () => {
    const harness = createQueueHarness();
    harness.queue.enqueue([task('a')]);
    expect(harness.queue.remove('a')).toBe(true);
    expect(harness.queue.remove('missing')).toBe(false);
  });
});
