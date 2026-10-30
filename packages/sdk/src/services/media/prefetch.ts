// SPDX-License-Identifier: MIT
/**
 * 下一集预取：在用户还在看这一集时，把紧随其后的那一集准备好。
 *
 * 决策在主进程做（渲染层不能 import SDK）。三条约定：
 * - 只取**紧随其后**的那一集，且必须是未锁定的：锁定的集预取了也播不了，锁后面那集更没用；
 * - 同一集在飞时不重复请求（进度条每几秒就会触发一次，不去重会打出十几次请求）；
 * - 失败一律静默，绝不因为预取把当前播放搞挂。
 */
export interface PrefetchEpisode {
  vid: string;
  vid_index?: number;
  locked?: boolean;
}

export type PrefetchStatus = 'prefetched' | 'skipped' | 'failed' | 'canceled';

export interface PrefetchResult {
  target: string;
  status: PrefetchStatus;
  error?: string;
}

/** 正在进行的预取（按目标 vid 去重）；失败或完成后清除，允许下次重试。 */
const inFlight = new Map<string, Promise<unknown>>();

export function resetPrefetchState(): void {
  inFlight.clear();
}

/**
 * 纯决策：返回应该预取的那一集，没有就返回 null。
 * 顺序以传入的列表为准（调用方按播放顺序给），不看 vid_index —— 分季列表的编号可能不连续。
 */
export function nextPrefetchTarget(episodes: PrefetchEpisode[], currentVid: string): PrefetchEpisode | null {
  if (!Array.isArray(episodes) || !episodes.length) return null;
  const index = episodes.findIndex((episode) => String(episode?.vid ?? '') === String(currentVid));
  if (index < 0) return null;
  const next = episodes[index + 1];
  if (!next?.vid) return null;
  if (next.locked === true) return null;
  return next;
}

export interface PrefetchOptions {
  episodes: PrefetchEpisode[];
  currentVid: string;
  /** 真正的取流入口；通常就是 prepare 播放用的那一个 */
  load(vid: string, episode: PrefetchEpisode): Promise<unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function prefetchNextEpisode(options: PrefetchOptions): Promise<PrefetchResult> {
  const target = nextPrefetchTarget(options.episodes, options.currentVid);
  if (!target) return { target: '', status: 'skipped' };
  if (options.signal?.aborted) return { target: target.vid, status: 'canceled' };
  const pending = inFlight.get(target.vid);
  if (pending) return { target: target.vid, status: 'skipped' };

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000;
  let timer: NodeJS.Timeout | undefined;
  const job = (async () => {
    const work = options.load(target.vid, target);
    if (!timeoutMs) return work;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('预取超时'), { code: 'TIMEOUT' })),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  })();
  inFlight.set(target.vid, job);
  try {
    await job;
    return { target: target.vid, status: 'prefetched' };
  } catch (error) {
    // 预取失败不需要用户知道：切集时会正常取流。
    const code = String((error as { code?: string } | null)?.code ?? '');
    if (code === 'CANCELED' || code === 'ERR_CANCELED' || options.signal?.aborted) {
      return { target: target.vid, status: 'canceled' };
    }
    return { target: target.vid, status: 'failed', error: (error as Error).message };
  } finally {
    clearTimeout(timer);
    inFlight.delete(target.vid);
  }
}
