/**
 * 红果搜索的编排（迁移自 4.5 `main.js` 的 `search-series` 主链路）。
 *
 * 4.5 的搜索不是一个接口：App 搜索（带游标分页）优先、官网接口兜底、官网 5xx 时反过来
 * 用 App 救场、官网没命中时再查一次「今日上新」。重构后这条编排整条丢了——
 * `providers/hongguo-app/search.ts` 与 `new-releases.ts` 都写好了却没有任何调用方。
 *
 * 这里只做决策与拼接，取数全部由注入的依赖完成，因此可以不联网逐条验证：
 * - 渠道顺序与回退条件；
 * - 游标原样回传（分页靠它，不是靠页码重算）；
 * - 三档预算（官网 ≤12.5s、上新留 ≥7s、命中后再补搜 ≤3s）；
 * - 上新的合并与去重，以及「查过」与「查到」分开汇报。
 */

import { normalizeSearchText } from '@hongguo/shared';

/** 总预算：整次搜索（含兜底与补搜）共享，慢来源不能各自重开计时。 */
export const SEARCH_BUDGET_MS = 20_000;
/** 官网接口自己的上限：必须给后面留出兜底与补搜的余量。 */
export const WEB_BUDGET_MS = 12_500;
/** 上新补搜的截止点：从开始算起 8.5s（保证它至少能拿到约 7s 的可请求时间）。 */
export const NEW_RELEASE_BUDGET_MS = 8_500;
/** 主搜命中后只剩下上新的余量。 */
export const NEW_RELEASE_AFTER_HIT_MS = 3_000;

export interface SearchCursor {
  search_id?: string;
  passback?: string;
  next_offset?: number | null;
}

export interface ChannelPayload {
  results?: any[];
  cursor?: SearchCursor | null;
  hasMore?: boolean;
  page?: number;
}

export interface NewReleasePayload {
  results?: any[];
  partial?: boolean;
  cached?: boolean;
}

export interface SearchSeriesDeps {
  /** App 接口搜索：支持游标分页 */
  app(
    keyword: string,
    options: { page: number; cursor: SearchCursor | null; deadline: number },
  ): Promise<ChannelPayload>;
  /** 官网接口搜索 */
  web(keyword: string, options: { page: number; deadline: number }): Promise<ChannelPayload>;
  /** 今日上新列表（用于补搜） */
  newReleases(keyword: string, options: { deadline: number }): Promise<NewReleasePayload>;
  /** `search_app_enabled` 开关 */
  isAppEnabled(): boolean;
  now?(): number;
}

export interface SearchSeriesOptions {
  page?: number;
  cursor?: SearchCursor | null;
  /** 主搜要用哪条线路；`more`（翻页）时必须钉住上一页的线路 */
  channel?: 'app' | 'web';
  /** 是否查上新（翻页时不重复查） */
  checkNewReleases?: boolean;
  deadline?: number;
}

export interface SearchSeriesResult {
  success: true;
  channel: 'app' | 'web';
  page: number;
  results: any[];
  cursor: SearchCursor | null;
  hasMore: boolean;
  /** 走了兜底线路（官网失败后用 App 救场）时为 true */
  partial: boolean;
  /** App 搜索失败的原因（用于界面提示「已改用官网」） */
  appError?: string;
  /** 官网搜索失败的原因 */
  apiError?: string;
  meta: { newRelease: number; newReleaseChecked: boolean; newReleases?: any[] };
}

function messageOf(error: unknown): string {
  const value = error as { message?: string; code?: string } | null;
  return String(value?.message ?? value?.code ?? error ?? '');
}

/** 官网的 HTTP 5xx 属于「服务端暂时不可用」：值得换 App 线路救一次。 */
export function isUpstreamFailure(error: unknown): boolean {
  const value = error as {
    code?: string;
    kind?: string;
    mediaStatus?: number;
    status?: number;
    message?: string;
  } | null;
  const status = Number(value?.status ?? value?.mediaStatus ?? 0);
  if (status >= 500 && status <= 599) return true;
  if (value?.kind === 'upstream') return true;
  return /HTTP\s*5\d\d|ERR_BAD_RESPONSE|ECONNRESET|socket hang up/i.test(String(value?.message ?? ''));
}

/** 主搜结果里有没有「标题认得出关键词」的条目（认不出就当作没命中，值得补搜上新）。 */
export function hasKeywordMatch(results: any[] | null | undefined, keyword: string): boolean {
  const query = normalizeSearchText(keyword);
  if (!query) return false;
  return (Array.isArray(results) ? results : []).some((item) =>
    normalizeSearchText(item?.series_title ?? item?.series_name ?? item?.title).includes(query),
  );
}

function keyOf(item: any): string {
  return String((item?.series_id ?? item?.series_id === 0) ? item.series_id : (item?.seriesId ?? ''));
}

/** 合并主搜与上新：同一部剧只留一条，上新标记要保留。 */
export function mergeResults(primary: any[], extra: any[]): { results: any[]; added: number } {
  const seen = new Set(primary.map(keyOf).filter(Boolean));
  const merged = [...primary];
  let added = 0;
  for (const item of extra) {
    const key = keyOf(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
    added += 1;
  }
  return { results: merged, added };
}

export async function searchSeriesWithFallback(
  keyword: string,
  options: SearchSeriesOptions,
  deps: SearchSeriesDeps,
): Promise<SearchSeriesResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = Number(options.deadline) > 0 ? Number(options.deadline) : started + SEARCH_BUDGET_MS;
  const page = Number(options.page) >= 1 ? Number(options.page) : 1;
  const cursor = options.cursor ?? null;
  const pinned = options.channel;
  const checkNewReleases = options.checkNewReleases ?? page === 1;

  let channel: 'app' | 'web';
  let payload: ChannelPayload;
  let appError: string | undefined;
  let apiError: string | undefined;
  let partial = false;

  const tryApp = () =>
    deps.app(keyword, { page, cursor, deadline: Math.min(deadline, started + WEB_BUDGET_MS) });
  const tryWeb = () => deps.web(keyword, { page, deadline: Math.min(deadline, started + WEB_BUDGET_MS) });

  if (pinned === 'app' || (pinned === undefined && deps.isAppEnabled())) {
    // App 优先（或翻页时钉住 App 线路）
    try {
      payload = await tryApp();
      channel = 'app';
    } catch (error) {
      if (pinned === 'app') throw error; // 翻页时不能换线路：游标只属于那条线路
      appError = messageOf(error);
      payload = await tryWeb();
      channel = 'web';
    }
  } else {
    try {
      payload = await tryWeb();
      channel = 'web';
    } catch (error) {
      apiError = messageOf(error);
      if (!isUpstreamFailure(error)) throw error;
      // 官网 5xx/连接中断：用 App 救场，并如实标记「部分结果」。
      payload = await tryApp();
      channel = 'app';
      partial = true;
    }
  }

  const primary = Array.isArray(payload?.results) ? payload.results : [];
  let results = primary;
  let newReleaseChecked = false;
  let newRelease = 0;
  let newReleases: any[] | undefined;

  // 上新补搜：首页永远补一次（4.5 就是这么做的），只是余量不同——
  // 主搜没命中时给足 8.5s（它可能才是唯一能找到「今天刚上线」的线索），
  // 已经命中就只给 3s 的补充机会，别让一次搜索拖到总预算。
  const miss = !hasKeywordMatch(primary, keyword);
  if (checkNewReleases) {
    newReleaseChecked = true;
    const budget = started + (miss ? NEW_RELEASE_BUDGET_MS : NEW_RELEASE_AFTER_HIT_MS);
    if (budget > now()) {
      try {
        const fresh = await deps.newReleases(keyword, { deadline: Math.min(deadline, budget) });
        const extra = Array.isArray(fresh?.results) ? fresh.results : [];
        if (extra.length) {
          const merged = mergeResults(primary, extra);
          results = merged.results;
          newRelease = merged.added;
          newReleases = extra;
        }
      } catch {
        /* 补搜失败不影响主搜结果 */
      }
    }
  }

  return {
    success: true,
    channel,
    page,
    results,
    cursor: (payload?.cursor as SearchCursor | null) ?? null,
    hasMore: payload?.hasMore === true,
    partial,
    ...(appError ? { appError } : {}),
    ...(apiError ? { apiError } : {}),
    meta: { newRelease, newReleaseChecked, ...(newReleases ? { newReleases } : {}) },
  };
}
