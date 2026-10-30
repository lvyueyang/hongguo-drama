/**
 * 红果官网搜索联想。
 *
 * 接口来自搜索页内联的埋点配置（`window._SdkGlueInit` 的 `bdms.paths.include`
 * 同时列出 `/api/search/result/?$` 与 `/api/search/suggestion/?$`），实测：
 * - `GET https://hongguoduanju.com/api/search/suggestion/?query=<关键词>`
 * - 无签名、无 Cookie，默认 UA 即可；
 * - `query` 必须非空且 ≤ 30 字符，否则返回 `{ code: 'invalid_query' }`；
 * - 固定返回 10 条，`count/limit/offset/aid` 被忽略，未知参数直接报错。
 *
 * 条目里 `keyword` 的语义不一致：`short_play_name` 时它是 19 位 `series_id`
 * （**必须按字符串处理**，否则会丢精度），`common_query` 时才是普通搜索词。
 */
import { ErrorCodes, SdkError } from '@hongguo/shared';

export const SUGGEST_ORIGIN = 'https://hongguoduanju.com';
export const SUGGEST_PATH = '/api/search/suggestion/';
export const SUGGEST_MAX_QUERY = 30;
const DEFAULT_TIMEOUT_MS = 6000;

export type SuggestWordType = 'short_play_name' | 'common_query';

export interface SuggestSeries {
  seriesId: string;
  title: string;
  intro: string;
  cover: string;
  episodeCount: number;
  episodeRightText: string;
  vids: string[];
  hotScore: number;
  hotText: string;
  categories: Array<{ id: string; name: string }>;
  celebrities: string[];
}

export interface SuggestItem {
  wordType: SuggestWordType;
  /** 展示文本 */
  name: string;
  /** 剧名类为 series_id，通用词类为 `1_<hash>` */
  keyword: string;
  displayWords: string[];
  series: SuggestSeries | null;
}

export interface SuggestResponse {
  status: number;
  body: string;
}

export type SuggestTransport = (url: string, init: { signal?: AbortSignal }) => Promise<SuggestResponse>;

export interface SuggestOptions {
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  transport?: SuggestTransport;
}

const text = (value: unknown): string =>
  String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** 只接受整数形式的编号；19 位大整数必须走字符串，不能用 Number。 */
const idText = (value: unknown): string => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '';
  const raw = String(value ?? '').trim();
  return /^\d{1,30}$/.test(raw) && /[1-9]/.test(raw) ? raw : '';
};

/** HEIC 封面换成可渲染的 WebP/JPEG 变体；其余只接受 http(s)。 */
export function normalizeSuggestCover(value: unknown): string {
  const raw = String(value ?? '').trim();
  const url = raw.startsWith('//') ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const parsed = new URL(url);
    if (/\.heic$/i.test(parsed.pathname)) {
      if (!/(^|\.)(novelpic|fqnovelpic|byteimg)\.com$/i.test(parsed.hostname)) return '';
      if (!parsed.pathname.startsWith('/novel-pic/') || !parsed.pathname.includes('~')) return '';
      return `https://p3-novel.byteimg.com${parsed.pathname.split('~', 1)[0]}~tplv-shrink:640:0.image`;
    }
    return url;
  } catch {
    return '';
  }
}

function parseSeries(video: Record<string, unknown> | undefined): SuggestSeries | null {
  if (!video) return null;
  const seriesId = idText(video.series_id);
  if (!seriesId) return null;
  const hot = (video.hot_score_data ?? {}) as Record<string, unknown>;
  const categories = Array.isArray(video.category_list)
    ? video.category_list
        .map((entry) => {
          const row = (entry ?? {}) as Record<string, unknown>;
          const id = idText(row.category_id);
          const name = text(row.name);
          return id && name ? { id, name } : null;
        })
        .filter((entry): entry is { id: string; name: string } => entry !== null)
    : [];
  const celebrities = Array.isArray(video.celebrities)
    ? video.celebrities
        .map((entry) => text((entry as Record<string, unknown> | null)?.name ?? entry))
        .filter(Boolean)
    : [];
  const vids = Array.isArray(video.vid_list)
    ? video.vid_list.map(idText).filter((value): value is string => value.length > 0)
    : [];
  return {
    seriesId,
    title: text(video.series_title),
    intro: text(video.series_intro),
    cover: normalizeSuggestCover(video.series_cover),
    episodeCount: Math.max(0, Number(video.episode_cnt) || 0),
    episodeRightText: text(video.episode_right_text),
    vids,
    hotScore: Math.max(0, Number(hot.score) || 0),
    hotText: text(hot.text),
    categories,
    celebrities,
  };
}

function parseItems(payload: unknown): SuggestItem[] {
  const list = (payload as { suggestionList?: unknown } | null)?.suggestionList;
  if (!Array.isArray(list)) throw new SdkError(ErrorCodes.UPSTREAM_SCHEMA, '搜索联想返回格式异常');
  const items: SuggestItem[] = [];
  for (const entry of list) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const name = text(row.name);
    const keyword = String(row.keyword ?? '').trim();
    if (!name || !keyword) continue;
    const wordType: SuggestWordType =
      row.word_type === 'short_play_name' ? 'short_play_name' : 'common_query';
    const displayWords = Array.isArray(row.display_words) ? row.display_words.map(text).filter(Boolean) : [];
    items.push({
      wordType,
      name,
      keyword,
      displayWords,
      series: wordType === 'short_play_name' ? parseSeries(row.video_data as Record<string, unknown>) : null,
    });
  }
  return items;
}

async function defaultTransport(url: string, init: { signal?: AbortSignal }): Promise<SuggestResponse> {
  const response = await fetch(url, {
    signal: init.signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  return { status: response.status, body: await response.text() };
}

/** 关键词本地校验：空或超长直接拒绝，不发请求（与接口的约束保持一致）。 */
export function validateSuggestQuery(keyword: unknown): string {
  const query = String(keyword ?? '')
    .normalize('NFKC')
    .trim();
  const length = [...query].length;
  if (!query) throw new SdkError(ErrorCodes.INPUT_INVALID, '请输入搜索关键词');
  if (length > SUGGEST_MAX_QUERY) {
    throw new SdkError(ErrorCodes.INPUT_INVALID, `搜索联想最多 ${SUGGEST_MAX_QUERY} 个字符`);
  }
  return query;
}

export function suggestUrl(keyword: string): string {
  return `${SUGGEST_ORIGIN}${SUGGEST_PATH}?query=${encodeURIComponent(keyword)}`;
}

export async function suggestSuggestions(
  keyword: unknown,
  options: SuggestOptions = {},
): Promise<SuggestItem[]> {
  const query = validateSuggestQuery(keyword);
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(suggestUrl(query), { signal: controller.signal });
    if (response.status !== 200) {
      throw new SdkError(ErrorCodes.SOURCE_UNAVAILABLE, `搜索联想失败（HTTP ${response.status}）`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body || '{}');
    } catch {
      throw new SdkError(ErrorCodes.UPSTREAM_SCHEMA, '搜索联想返回的不是合法 JSON');
    }
    const error = (payload as { code?: unknown; message?: unknown } | null) ?? {};
    if (error.code) {
      const code = error.code === 'invalid_query' ? ErrorCodes.INPUT_INVALID : ErrorCodes.SOURCE_UNAVAILABLE;
      throw new SdkError(code, text(error.message) || '搜索联想暂不可用');
    }
    const items = parseItems(payload);
    const limit = Number(options.limit);
    return Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items;
  } catch (error) {
    if (error instanceof SdkError) throw error;
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new SdkError(ErrorCodes.TIMEOUT, '搜索联想超时，请重试');
    }
    throw new SdkError(ErrorCodes.SOURCE_UNAVAILABLE, '搜索联想请求失败，请重试', error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export default { suggestSuggestions, suggestUrl, validateSuggestQuery, normalizeSuggestCover };
