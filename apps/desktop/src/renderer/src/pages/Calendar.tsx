import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';

interface SeriesEntry {
  series_id: string;
  series_title?: string;
  total?: number;
}

interface SequelRow {
  series_id?: string;
  series_title?: string;
  season?: number;
}

export default function Calendar() {
  const [result, setResult] = useState<{ seriesId: string; rows: SequelRow[] } | null>(null);
  const [notice, setNotice] = useState('');
  const library = useQuery({ queryKey: ['library'], queryFn: () => api.libraryList() });
  const entries = Array.isArray(library.data) ? (library.data as SeriesEntry[]) : [];

  const search = useMutation({
    mutationFn: (seriesId: string) => api.seriesSequels(seriesId),
    onSuccess: (data, seriesId) => {
      const rows = (data as { results?: SequelRow[] })?.results ?? [];
      setResult({ seriesId, rows });
      setNotice(rows.length ? `找到 ${rows.length} 部相关季` : '没有找到新的季');
    },
    onError: (error) => setNotice(`查找续集失败：${(error as Error).message}`),
  });

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">收藏与上新</h2>
        <span className="text-[var(--font-size-caption)] text-muted">
          续集查找用标题做一次主搜 + 至多两次补搜
        </span>
      </header>

      {notice && <p className="text-[var(--font-size-label)] text-secondary-text">{notice}</p>}

      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <Card key={entry.series_id}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="truncate">{entry.series_title ?? entry.series_id}</CardTitle>
              <div className="flex items-center gap-2">
                {entry.total ? <Badge>共 {entry.total} 集</Badge> : null}
                <Button size="sm" onClick={() => search.mutate(entry.series_id)} disabled={search.isPending}>
                  查找续集
                </Button>
              </div>
            </CardHeader>
            {result?.seriesId === entry.series_id && (
              <CardContent className="space-y-1">
                {result.rows.map((row) => (
                  <p
                    key={String(row.series_id)}
                    className="text-[var(--font-size-label)] text-secondary-text"
                  >
                    {row.series_title ?? row.series_id}
                    {row.season ? ` · 第 ${row.season} 季` : ''}
                  </p>
                ))}
                {!result.rows.length && (
                  <p className="text-[var(--font-size-caption)] text-muted">没有发现新的季。</p>
                )}
              </CardContent>
            )}
          </Card>
        ))}
        {!entries.length && (
          <p className="text-[var(--font-size-label)] text-muted">剧库为空，先收藏几部剧再来查看上新。</p>
        )}
      </div>
    </div>
  );
}
