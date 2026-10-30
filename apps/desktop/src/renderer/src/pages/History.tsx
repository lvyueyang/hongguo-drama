import { Button, Card, CardContent, Skeleton } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';

const SCOPES = [
  { id: 'all', label: '全部' },
  { id: 'latest', label: '每剧最近' },
  { id: 'unfinished', label: '未看完' },
] as const;

export default function History() {
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('all');
  const query = useQuery({
    queryKey: ['history', scope],
    queryFn: () => api.historyList({ scope }),
    placeholderData: (previous) => previous,
  });
  const rows = Array.isArray(query.data) ? (query.data as Array<Record<string, unknown>>) : [];
  const client = useQueryClient();
  const [refreshNotice, setRefreshNotice] = useState('');
  // 后台续作刷新：只查各剧自己的来源；部分失败会如实说明，不谎报"已完成"。
  const refresh = useMutation({
    mutationFn: () => api.historyRefresh(),
    onSuccess: (result) => {
      setRefreshNotice(
        result.failed
          ? `已检查 ${result.checked} 部，其中 ${result.failed} 部未完成，稍后会再试`
          : `已检查 ${result.checked} 部`,
      );
      void client.invalidateQueries({ queryKey: ['history'] });
    },
    onError: (error) => setRefreshNotice(`刷新失败：${(error as Error).message}`),
  });

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? '检查续作…' : '检查续作'}
        </Button>
        {SCOPES.map((entry) => (
          <Button
            key={entry.id}
            variant={scope === entry.id ? 'primary' : 'outline'}
            onClick={() => setScope(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {refreshNotice && (
        <p className="text-[var(--font-size-caption)] text-secondary-text">{refreshNotice}</p>
      )}

      {query.isError && (
        <p className="text-[var(--font-size-label)] text-danger">
          观看记录加载失败：{(query.error as Error).message}
        </p>
      )}

      <div className="flex flex-col gap-2 overflow-y-auto">
        {query.isPending
          ? Array.from({ length: 5 }, (_, index) => `h${index}`).map((key) => (
              <Skeleton key={key} className="h-16 w-full" />
            ))
          : rows.map((row) => (
              <Card key={String(row.series_id)}>
                <CardContent className="flex items-center gap-3 pt-3">
                  {typeof row.cover === 'string' && row.cover ? (
                    <img
                      src={row.cover}
                      alt=""
                      className="h-14 w-10 rounded-[var(--radius-control)] object-cover"
                    />
                  ) : (
                    <div className="h-14 w-10 rounded-[var(--radius-control)] bg-selection" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[var(--font-size-label)] font-medium">
                      {String(row.series_title ?? '未命名')}
                    </p>
                    <p className="text-[var(--font-size-caption)] text-muted">
                      看到第 {String(row.vid_index ?? '?')} 集
                      {row.duration
                        ? ` · ${Math.floor(Number(row.currentTime) || 0)}s / ${Math.floor(Number(row.duration))}s`
                        : ''}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
        {!query.isPending && !rows.length && (
          <p className="text-[var(--font-size-label)] text-muted">还没有观看记录。</p>
        )}
      </div>
    </div>
  );
}
