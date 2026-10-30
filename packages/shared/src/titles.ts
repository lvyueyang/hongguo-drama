/**
 * 标题归一化与搜索结果相关性排序。
 * 全角/半角、空格和标点不影响匹配（“言出法随，诸天万界” == “言出法随 诸天万界”）。
 */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export interface RankableItem {
  series_id?: string;
  series_title?: string;
  series_intro?: string;
  description?: string;
  source?: string;
  fuzzy?: boolean;
  new_release?: boolean;
}

export type RankedItem<T extends RankableItem> = T & { relevance: 0 | 1 | 2 | 3; contentMatch: boolean };

export function rankSearchResults<T extends RankableItem>(
  results: T[] | null | undefined,
  keyword: string,
): RankedItem<T>[] {
  const query = normalizeSearchText(keyword);
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of Array.isArray(results) ? results : []) {
    const key = `${item?.source}:${item?.series_id}`;
    if (!item?.series_id || !item?.series_title || seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept
    .map((item) => {
      const title = normalizeSearchText(item.series_title);
      const description = normalizeSearchText(item.series_intro || item.description || '');
      const titleMatch = !!query && title.includes(query);
      // 上新补搜支持“用户多打了季数”的反向匹配，这类结果仍算标题命中。
      const reverseMatch = item.new_release === true && title.length >= 2 && !!query && query.includes(title);
      const contentMatch = !!query && description.includes(query);
      const relevance: 0 | 1 | 2 | 3 =
        title === query ? 0 : titleMatch || reverseMatch ? 1 : contentMatch ? 2 : 3;
      return { ...item, relevance, contentMatch };
    })
    .sort((a, b) => a.relevance - b.relevance || (a.fuzzy === b.fuzzy ? 0 : a.fuzzy ? -1 : 1));
}
