import { Button, Card, CardContent, Skeleton } from '@hongguo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';

const KINDS = [
  { id: 'hot-drama', label: '综合热播' },
  { id: 'hot-real-drama', label: '真人剧榜' },
  { id: 'hot-comic-drama', label: '漫剧榜' },
  { id: 'hot-ai-drama', label: 'AI剧榜' },
] as const;

interface CardRow {
  series_id?: string;
  series_title?: string;
  cover?: string;
  episode_cnt?: number;
}

function pickRows(payload: unknown): CardRow[] {
  const value = payload as { results?: unknown } | null;
  return Array.isArray(value?.results) ? (value.results as CardRow[]) : [];
}

export default function Rankings() {
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>(KINDS[0].id);
  const query = useQuery({
    queryKey: ['rankings', kind],
    queryFn: () => api.rankings({ kind, page: 1 }),
    placeholderData: (previous) => previous,
  });
  const rows = pickRows(query.data);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        {KINDS.map((entry) => (
          <Button
            key={entry.id}
            variant={kind === entry.id ? 'primary' : 'outline'}
            onClick={() => setKind(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
        <span className="ml-2 text-[var(--font-size-caption)] text-muted">榜单保留来源热度顺序</span>
      </div>

      {query.isError && (
        <p className="text-[var(--font-size-label)] text-danger">
          榜单加载失败：{(query.error as Error).message}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3 xl:grid-cols-5">
        {query.isPending
          ? Array.from({ length: 10 }, (_, index) => `r${index}`).map((key) => (
              <Skeleton key={key} className="aspect-[3/4] w-full" />
            ))
          : rows.map((row, index) => (
              <Card key={String(row.series_id)} className="overflow-hidden">
                <div className="relative aspect-[3/4] w-full bg-selection">
                  {row.cover ? (
                    <img src={row.cover} alt="" loading="lazy" className="size-full object-cover" />
                  ) : null}
                  <span className="absolute left-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[var(--font-size-caption)] text-white">
                    {index + 1}
                  </span>
                </div>
                <CardContent className="pt-3">
                  <p className="line-clamp-2 text-[var(--font-size-label)] font-medium">
                    {String(row.series_title ?? '未命名')}
                  </p>
                </CardContent>
              </Card>
            ))}
        {!query.isPending && !rows.length && (
          <p className="text-[var(--font-size-label)] text-muted">这个榜单暂时没有内容。</p>
        )}
      </div>
    </div>
  );
}
