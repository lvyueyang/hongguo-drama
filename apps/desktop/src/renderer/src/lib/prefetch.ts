/**
 * 渲染层预取入口。
 *
 * 注意边界：这里**不能** import '@hongguo/sdk'——SDK 带 fs/crypto/axios 等
 * node 侧模块，进浏览器包会在启动时炸掉（实测 "e is not a constructor"）。
 * 预取决策与执行都在主进程，渲染层只发一次 IPC。
 */
import { api } from './api.ts';

export interface PrefetchOutcome {
  target: string;
  status: 'prefetched' | 'skipped' | 'failed' | 'canceled';
  error?: string;
}

export async function prefetchNextEpisode(options: {
  seriesId: string;
  currentVid: string;
  episodes: Array<{ vid: string; locked?: boolean }>;
}): Promise<PrefetchOutcome> {
  try {
    return (await api.prefetch(options.seriesId, options.currentVid, options.episodes)) as PrefetchOutcome;
  } catch (error) {
    // 预取失败对用户不可见：切集时再正常取流。
    return { target: '', status: 'failed', error: (error as Error).message };
  }
}
