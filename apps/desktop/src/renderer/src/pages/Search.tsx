const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];

import { Badge, Button, Card, CardContent, Input, Skeleton } from '@hongguo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';

/** 输入停顿 220ms 才请求联想，避免每敲一个字都打接口。 */
function useDebounced<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

interface SearchRow {
  series_id?: string;
  series_title?: string;
  cover?: string;
  series_intro?: string;
  [key: string]: unknown;
}

function pickResults(payload: unknown): SearchRow[] {
  const value = payload as { results?: unknown } | null;
  return Array.isArray(value?.results) ? (value.results as SearchRow[]) : [];
}

export default function Search() {
  const [keyword, setKeyword] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [source, setSource] = useState('hongguo');
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.browseSources(), staleTime: 60_000 });
  const [suggestOpen, setSuggestOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(keyword.trim());

  const suggestions = useQuery({
    queryKey: ['suggest', debounced],
    queryFn: () => api.suggest(debounced),
    enabled: debounced.length > 0 && debounced.length <= 30,
    retry: 0,
    staleTime: 60_000,
  });

  const results = useQuery({
    queryKey: ['search', submitted, source],
    queryFn: () => api.searchWeb(submitted, 1, source),
    enabled: submitted.length > 0,
    retry: 1,
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setSuggestOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const items = useMemo(() => suggestions.data ?? [], [suggestions.data]);
  const rows = pickResults(results.data);

  const runSearch = (value: string): void => {
    const next = value.trim();
    if (!next) return;
    setKeyword(next);
    setSubmitted(next);
    setSuggestOpen(false);
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div ref={boxRef} className="relative max-w-2xl">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(keyword);
          }}
        >
          <Input
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setSuggestOpen(true);
            }}
            onFocus={() => setSuggestOpen(true)}
            placeholder="输入剧名，例如：一村人养一个神"
            aria-label="搜索剧名"
            aria-expanded={suggestOpen}
            aria-controls="suggest-list"
            autoComplete="off"
          />
          <Button type="submit" variant="primary">
            搜索
          </Button>
          <select
            aria-label="搜索来源"
            className="h-8 shrink-0 rounded-[var(--radius-control)] border border-border-subtle bg-surface px-2 text-[var(--font-size-label)]"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            {(sources.data ?? [{ id: 'hongguo', label: '红果' }]).map(
              (item: { id: string; label: string }) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ),
            )}
          </select>
        </form>

        {suggestOpen && debounced && items.length > 0 && (
          <Card className="absolute top-10 z-10 max-h-96 w-full overflow-y-auto shadow-lg">
            <ul id="suggest-list" className="divide-y divide-border-subtle">
              {items.map((item) => (
                <li key={`${item.wordType}:${item.keyword}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-selection"
                    onClick={() => runSearch(item.series?.title ?? item.name)}
                  >
                    {item.series?.cover ? (
                      <img
                        src={item.series.cover}
                        alt=""
                        className="h-14 w-10 rounded-[var(--radius-control)] object-cover"
                      />
                    ) : (
                      <span className="flex h-14 w-10 items-center justify-center rounded-[var(--radius-control)] bg-selection text-[var(--font-size-caption)] text-muted">
                        词
                      </span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[var(--font-size-label)] font-medium">{item.name}</span>
                      {item.series ? (
                        <span className="truncate text-[var(--font-size-caption)] text-muted">
                          {item.series.episodeRightText || `全 ${item.series.episodeCount} 集`}
                          {item.series.hotText ? ` · ${item.series.hotText}` : ''}
                        </span>
                      ) : (
                        <span className="text-[var(--font-size-caption)] text-muted">搜索词</span>
                      )}
                    </span>
                    {item.series ? <Badge tone="accent">剧集</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {results.isError && (
        <p className="text-[var(--font-size-label)] text-danger">
          搜索失败：{(results.error as Error).message}
        </p>
      )}

      {results.isFetching ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {SKELETON_KEYS.slice(0, 5).map((key) => (
            <Skeleton key={key} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3 xl:grid-cols-5">
          {rows.map((row) => (
            <Card key={String(row.series_id)} className="overflow-hidden">
              <div className="aspect-[3/4] w-full bg-selection">
                {typeof row.cover === 'string' && row.cover ? (
                  <img src={row.cover} alt="" loading="lazy" className="size-full object-cover" />
                ) : null}
              </div>
              <CardContent className="pt-3">
                <p className="line-clamp-2 text-[var(--font-size-label)] font-medium">
                  {String(row.series_title ?? '未命名')}
                </p>
              </CardContent>
            </Card>
          ))}
          {submitted && !results.isFetching && !rows.length && (
            <p className="text-[var(--font-size-label)] text-muted">没有匹配的剧集。</p>
          )}
        </div>
      )}
    </div>
  );
}
