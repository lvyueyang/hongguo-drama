// 迁移自 4.5 src/native/series-search.js（破坏性重构 M1）。算法未改动，仅模块语法转为 ESM。
import { findSequels, seasonTitle, sourceOf } from '../history/watch-history.ts';

const normalizeTitle = (title) =>
  String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
const score = (title, keyword) => (!keyword ? 2 : title === keyword ? 0 : title.includes(keyword) ? 1 : 2);
function rankedUnique(results, keyword) {
  const seen = new Set(),
    normalized = normalizeTitle(keyword);
  return results
    .filter((item) => {
      if (!item?.series_id || !item.series_title) return false;
      const id = String(item.series_id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(
      (a, b) =>
        score(normalizeTitle(a.series_title), normalized) - score(normalizeTitle(b.series_title), normalized),
    );
}

function nextSeasonQueries(base, season) {
  if (!base || !Number.isInteger(season) || season < 2 || season > 99) return [];
  const digits = '零一二三四五六七八九';
  const chinese =
    season < 10
      ? digits[season]
      : `${season < 20 ? '' : digits[Math.floor(season / 10)]}十${season % 10 ? digits[season % 10] : ''}`;
  return [`${base}第${chinese}季`, `${base}第${season}季`];
}

// One primary search plus at most two supplements; never recursively expand upstream results.
async function searchSeries(
  keyword,
  search,
  knownSeries: any[] = [],
  { afterSeason = 1, deadline = 0 }: any = {},
) {
  const kw = String(keyword || '').trim();
  if (!kw || kw.length > 200) return { success: false, results: [], error: '请输入 1 至 200 字的搜索词' };
  const primary = await search(kw, { fuzzy: true, deadline });
  if (!primary?.success) return primary || { success: false, results: [], error: '搜索暂不可用' };
  const results = [...(primary.results || [])],
    parsed = seasonTitle(kw);
  let queries: any[] = [];
  if (parsed.base && !parsed.invalid && parsed.season <= 99) {
    if (parsed.explicit) {
      if (!results.some((item) => normalizeTitle(item.series_title) === normalizeTitle(kw)))
        queries = [parsed.base];
    } else {
      const seasons = [...results, ...knownSeries]
        .map((item) => seasonTitle(item.series_title))
        .filter((item) => item.base === parsed.base && !item.invalid);
      if (seasons.length) {
        const knownSeasons = new Set(seasons.map((item) => item.season));
        let nextSeason = afterSeason + 1;
        while (nextSeason <= 99 && knownSeasons.has(nextSeason)) nextSeason++;
        queries = nextSeasonQueries(parsed.base, nextSeason);
      }
    }
  }
  const errors: any[] = [];
  for (const query of queries) {
    if (deadline && Date.now() >= deadline) {
      errors.push('搜索时间预算已用完');
      break;
    }
    try {
      const response = await search(query, { fuzzy: false, deadline });
      if (!response?.success) throw new Error(response?.error || '来源未返回结果');
      results.push(...(response.results || []));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const supplementError = errors.length ? `补充搜索未完成：${[...new Set(errors)].join('；')}` : '';
  const partialErrors = [primary.error, supplementError].filter(Boolean);
  return {
    ...primary,
    results: rankedUnique(results, kw),
    ...(partialErrors.length ? { partial: true, error: partialErrors.join('；') } : {}),
  };
}

async function findSeriesSequels(
  series,
  localCandidates,
  search,
  { localOnly = false, deadline = 0 }: any = {},
) {
  const parsed = seasonTitle(series?.series_title),
    source = sourceOf(String(series?.series_id || ''));
  if (!source) return { success: false, results: [], error: '此来源暂不支持查找下一季，请按完整剧名搜索。' };
  if (!parsed.base || parsed.invalid || parsed.season > 99)
    return { success: false, results: [], error: '剧名或季数无法识别，请按完整剧名搜索。' };
  const local = findSequels(series, localCandidates);
  if (localOnly) return { success: true, results: local, candidates: local };
  try {
    const response = await searchSeries(parsed.base, search, [series, ...local], {
      afterSeason: parsed.season,
      deadline,
    });
    if (!response?.success) throw new Error(response?.error || '来源搜索失败');
    // Keep the unfiltered candidates so lower seasons in the same family can reuse one search.
    const candidates = [...local, ...(response.results || [])];
    return {
      success: true,
      results: findSequels(series, candidates),
      candidates,
      ...(response.partial ? { partial: true, error: response.error } : {}),
    };
  } catch (error) {
    return {
      success: local.length > 0,
      results: local,
      candidates: local,
      partial: true,
      error: `联网查找未完成：${error.message}${local.length ? '；已保留本机候选。' : '；可稍后重试。'}`,
    };
  }
}

export default {
  searchSeries,
  findSeriesSequels,
};
export { findSeriesSequels, searchSeries };
