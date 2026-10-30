import { Events } from '@hongguo/contract';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

interface Task {
  id: string;
  vid: string;
  seriesId: string;
  seriesTitle: string;
  savePath: string;
  status: string;
  progress: number;
  receivedBytes: number;
  totalBytes: number;
  actualQuality?: string | null;
  qualityNotice?: string;
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已暂停',
};

export default function DownloadManager() {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.downloadList(),
    refetchInterval: 1500,
  });
  const tasks = Array.isArray(query.data) ? (query.data as Task[]) : [];

  // 进度事件到达时刷新列表，避免只靠轮询。
  useEffect(
    () =>
      window.api.on(Events.downloadProgress, () => {
        void client.invalidateQueries({ queryKey: ['downloads'] });
      }),
    [client],
  );
  useEffect(
    () =>
      window.api.on(Events.downloadState, () => {
        void client.invalidateQueries({ queryKey: ['downloads'] });
      }),
    [client],
  );
  useEffect(
    () =>
      window.api.on(Events.mergeState, (payload) => {
        setNotice(
          payload.status === 'completed'
            ? `合并完成：${payload.outputPath ?? ''}`
            : `合并${payload.status === 'stopped' ? '已取消' : '失败'}：${payload.error ?? ''}`,
        );
      }),
    [],
  );

  const act = useMutation({
    mutationFn: async (input: { kind: 'pause' | 'resume' | 'remove'; id: string }) => {
      if (input.kind === 'pause') return api.downloadPause(input.id);
      if (input.kind === 'resume') return api.downloadResume(input.id);
      return api.downloadRemove(input.id);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['downloads'] }),
    onError: (error) => setNotice((error as Error).message),
  });

  const merge = useMutation({
    mutationFn: (seriesId: string) => api.mergeStart({ seriesId, compatible: false }),
    onSuccess: (result) => setNotice(`合并已启动：${result.outputPath}`),
    onError: (error) => setNotice(`合并失败：${(error as Error).message}`),
  });

  const deleteSeriesFiles = useMutation({
    mutationFn: (seriesId: string) => api.storageDeleteSeries(seriesId),
    onSuccess: (result) => {
      const data = result as { deleted: number; bytes: number; failed: string[]; removedDirs: number };
      setNotice(
        `已删除 ${data.deleted} 个文件（${Math.round(data.bytes / 1024)} KiB）${data.failed.length ? `，${data.failed.length} 个失败` : ''}，清理空目录 ${data.removedDirs ?? 0} 个`,
      );
      void client.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (error) => setNotice(`删除文件失败：${(error as Error).message}`),
  });

  const transcode = useMutation({
    mutationFn: (taskId: string) => api.transcode({ taskId }),
    onSuccess: (result) => setNotice(`转码完成，可直接播放：${result.url}`),
    onError: (error) => setNotice(`转码失败：${(error as Error).message}`),
  });

  const seriesIds = [...new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.seriesId))];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">下载管理</h2>
        <div className="flex items-center gap-2">
          {seriesIds.map((seriesId) => (
            <Fragment key={seriesId}>
              <Button onClick={() => merge.mutate(seriesId)} disabled={merge.isPending}>
                合并《{tasks.find((t) => t.seriesId === seriesId)?.seriesTitle ?? seriesId}》
              </Button>
              <Button
                variant="ghost"
                disabled={deleteSeriesFiles.isPending}
                onClick={() => {
                  const title = tasks.find((t) => t.seriesId === seriesId)?.seriesTitle ?? seriesId;
                  if (window.confirm(`只删除《${title}》已下载的文件（其它剧不受影响），此操作不可恢复。`)) {
                    deleteSeriesFiles.mutate(seriesId);
                  }
                }}
              >
                删除《{tasks.find((t) => t.seriesId === seriesId)?.seriesTitle ?? seriesId}》文件
              </Button>
            </Fragment>
          ))}
        </div>
      </header>

      {notice && <p className="text-[var(--font-size-label)] text-secondary-text">{notice}</p>}

      <div className="flex flex-col gap-2 overflow-y-auto">
        {tasks.map((task) => (
          <Card key={task.id}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="truncate">
                {task.seriesTitle || task.seriesId} · 第 {task.vid} 集
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge
                  tone={
                    task.status === 'completed' ? 'success' : task.status === 'failed' ? 'accent' : 'neutral'
                  }
                >
                  {STATUS_LABEL[task.status] ?? task.status}
                </Badge>
                {task.status === 'downloading' || task.status === 'pending' ? (
                  <Button size="sm" onClick={() => act.mutate({ kind: 'pause', id: task.id })}>
                    暂停
                  </Button>
                ) : null}
                {task.status === 'stopped' || task.status === 'failed' ? (
                  <Button size="sm" onClick={() => act.mutate({ kind: 'resume', id: task.id })}>
                    继续
                  </Button>
                ) : null}
                {task.status === 'completed' ? (
                  <Button size="sm" onClick={() => transcode.mutate(task.id)}>
                    转码兜底
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ kind: 'remove', id: task.id })}>
                  移除
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-selection">
                <div className="h-full bg-accent transition-all" style={{ width: `${task.progress}%` }} />
              </div>
              <p className="text-[var(--font-size-caption)] text-muted">
                {Math.round(task.receivedBytes / 1024)} KiB
                {task.totalBytes ? ` / ${Math.round(task.totalBytes / 1024)} KiB` : ''}
                {task.actualQuality ? ` · 实际 ${task.actualQuality}` : ''}
              </p>
              {task.qualityNotice && (
                <p className="text-[var(--font-size-caption)] text-secondary-text">{task.qualityNotice}</p>
              )}
              {task.error && <p className="text-[var(--font-size-caption)] text-danger">{task.error}</p>}
            </CardContent>
          </Card>
        ))}
        {!tasks.length && <p className="text-[var(--font-size-label)] text-muted">还没有下载任务。</p>}
      </div>
    </div>
  );
}
