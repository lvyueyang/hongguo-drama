import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn, Input, Skeleton } from '@hongguo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];

const CATEGORIES = [
  { id: 'real-drama', label: '真人剧' },
  { id: 'comic-drama', label: '漫剧' },
  { id: 'ai-drama', label: 'AI剧' },
] as const;

interface CardRow {
  series_id?: string;
  series_title?: string;
  cover?: string;
  episode_cnt?: number;
  content_type?: number;
  [key: string]: unknown;
}

/** 从 App 目录响应里取卡片；结构兼容披着不同外壳的返回。 */
function pickCards(payload: unknown): CardRow[] {
  const value = payload as { results?: unknown; items?: unknown; video_data?: unknown } | null;
  for (const candidate of [value?.results, value?.items, payload]) {
    if (Array.isArray(candidate)) return candidate as CardRow[];
  }
  return [];
}

export default function Discover() {
  const [category, setCategory] = useState<string>(CATEGORIES[0].id);
  // 换一批 = 真实下一页；失败保留旧卡片（由 React Query 的 keepPreviousData 行为保证）。
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['browse', category, page],
    queryFn: () => api.browseList({ source: 'hongguo', category, page, appCatalog: true }),
    placeholderData: (previous) => previous,
  });

  const cards = pickCards(query.data);

  // 切换分类回到第一页，避免把上一分类的页码带过去。
  useEffect(() => {
    setPage(1);
  }, [category]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {CATEGORIES.map((entry) => (
            <Button
              key={entry.id}
              variant={category === entry.id ? 'primary' : 'outline'}
              onClick={() => {
                if (category === entry.id) setPage((value) => value + 1);
                else setCategory(entry.id);
              }}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--font-size-caption)] text-muted">第 {page} 批</span>
          <Button onClick={() => setPage((value) => value + 1)} disabled={query.isFetching}>
            换一批
          </Button>
        </div>
      </header>

      {query.isError && (
        <Card className="border-danger/40">
          <CardContent className="pt-4 text-[var(--font-size-label)] text-danger">
            片单加载失败：{(query.error as Error).message}
          </CardContent>
        </Card>
      )}

      {query.isPending ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {SKELETON_KEYS.slice(0, 10).map((key) => (
            <Skeleton key={key} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3 xl:grid-cols-5">
          {cards.map((card) => (
            <Card key={String(card.series_id)} className="overflow-hidden">
              <div className="aspect-[3/4] w-full bg-selection">
                {typeof card.cover === 'string' && card.cover ? (
                  <img src={card.cover} alt="" loading="lazy" className="size-full object-cover" />
                ) : null}
              </div>
              <CardContent className="space-y-1 pt-3">
                <p className={cn('line-clamp-2 text-[var(--font-size-label)] font-medium')}>
                  {String(card.series_title ?? '未命名')}
                </p>
                {card.episode_cnt ? <Badge>全 {Number(card.episode_cnt)} 集</Badge> : null}
              </CardContent>
            </Card>
          ))}
          {!cards.length && !query.isPending && (
            <p className="text-[var(--font-size-label)] text-muted">这一批没有内容，试试换一批。</p>
          )}
        </div>
      )}
    </div>
  );
}

export { CATEGORIES, pickCards };
