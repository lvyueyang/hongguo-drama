/**
 * 观看记录的后台续作刷新（迁移自 4.5 `main.js: refresh-watch-history` 与
 * `scripts/check-watch-history-backend.cjs`）。
 *
 * 4.5 里这段逻辑长在 IPC handler 里，新架构把它抽成纯编排：给它"剧表 + 播放记录 +
 * 搜索实现"，它返回"要写回哪些记录"。这样不依赖 Electron，也能直接断言查询次数。
 *
 * 三条必须守住的规则：
 * 1. **同来源、有限次查询**：续作搜索只走该剧自己的来源，且查询次数有上限；
 * 2. **24 小时检查点只由成功刷新推进**：部分失败时保留已找到的续作，
 *    但不写 `lastSequelCheckAt`——否则失败会被当成"检查过了"，24 小时内不再重试；
 * 3. 失败要在记录里留下可读原因，不能静默。
 */
import { findSequels, sequelKeyword } from './watch-history.ts';

export interface RefreshSeries {
  series_id: string;
  series_title: string;
  total?: number;
  episodes?: unknown[];
}

export interface RefreshRecord {
  lastSequelCheckAt?: number;
  sequels?: Array<{ series_id: string; series_title: string }>;
  lastCheckError?: string;
  /** 分集与续作分开记原因：用户/界面需要知道是哪一类检查没完成 */
  lastEpisodeCheckError?: string;
  lastSequelCheckError?: string;
  [key: string]: unknown;
}

export interface RefreshResult {
  /** 真正发起过续作检查的剧数 */
  checked: number;
  /** 其中检查未完成的剧数 */
  failed: number;
  /** 需要写回的记录（key = series_id） */
  updates: Record<string, RefreshRecord>;
}

export interface RefreshDeps {
  series: RefreshSeries[];
  playback: Record<string, RefreshRecord | undefined>;
  /** 某剧的续作搜索（应绑定该剧自己的来源）；返回候选与是否完整完成 */
  searchSequels(
    series: RefreshSeries,
    keyword: string,
  ): Promise<{ success: boolean; results?: RefreshSeries[]; error?: string }>;
  now?: number;
  /** 检查点间隔，默认 24 小时 */
  intervalMs?: number;
  /** 单次刷新最多检查多少部剧（按最近观看排序后的前 N 部） */
  limit?: number;
  /** 只检查这一部剧（单行重检：忽略 24 小时检查点） */
  seriesId?: string;
}

export const SEQUEL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REFRESH_LIMIT = 20;

export async function refreshWatchHistory(deps: RefreshDeps): Promise<RefreshResult> {
  const now = Number.isFinite(deps?.now) ? (deps.now as number) : Date.now();
  const interval = Number(deps?.intervalMs) > 0 ? Number(deps.intervalMs) : SEQUEL_CHECK_INTERVAL_MS;
  const limit = Number(deps?.limit) > 0 ? Number(deps.limit) : DEFAULT_REFRESH_LIMIT;
  const updates: Record<string, RefreshRecord> = {};
  let checked = 0;
  let failed = 0;

  // 只看已看过的剧，且最近的优先；没有播放记录的剧不需要检查续作。
  const only = deps?.seriesId ? String(deps.seriesId) : '';
  const candidates = (deps?.series ?? [])
    .filter((item) => item?.series_id && deps.playback?.[item.series_id])
    .filter((item) => !only || String(item.series_id) === only)
    .slice(0, only ? 1 : limit);

  for (const item of candidates) {
    const record = deps.playback?.[item.series_id] as RefreshRecord | undefined;
    if (!record) continue;
    const last = Number(record.lastSequelCheckAt) || 0;
    // 单行重检是用户明确要求，忽略 24 小时检查点。
    if (!only && last && now - last < interval) continue;

    checked += 1;
    const keyword = sequelKeyword(item);
    let outcome: { success: boolean; results?: RefreshSeries[]; error?: string };
    try {
      outcome = await deps.searchSequels(item, keyword);
    } catch (error) {
      outcome = { success: false, error: (error as Error)?.message ?? '搜索失败' };
    }

    // 只认同一部剧、更高季数的候选；来源由 searchSequels 保证。
    const found = findSequels(item, outcome?.results ?? []);
    const survived = record.sequels ?? [];
    // 合并：新找到的优先，旧记录里仍在候选中的保留（避免一次失败把已有结果抹掉）。
    const merged = [
      ...found,
      ...survived.filter((old) => !found.some((next) => next.series_id === old.series_id)),
    ];
    const base: RefreshRecord = { ...record, sequels: merged };

    const reason = `续作检查未完成：${outcome?.error || '来源暂不可用'}`;
    if (outcome?.success) {
      updates[item.series_id] = {
        ...base,
        lastSequelCheckAt: now,
        lastSequelCheckError: '',
        // 分集没问题时把总错误清掉（保留分集自己的那份原因）
        lastCheckError: record.lastEpisodeCheckError || '',
      };
    } else {
      failed += 1;
      updates[item.series_id] = {
        ...base,
        // 关键：不推进检查点，24 小时内还会再试
        lastSequelCheckError: reason,
        lastCheckError: reason,
      };
    }
  }

  return { checked, failed, updates };
}
