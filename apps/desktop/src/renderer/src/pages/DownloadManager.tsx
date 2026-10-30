import { Events } from '@hongguo/contract';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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

/** 合并方式：直复制 / 兼容（HEVC→H.264）/ 只并 1080P 分集（对应 4.5 的三个入口）。 */
type MergeMode = 'fast' | 'compatible' | 'require1080';

interface MergeRun {
  stage: string;
  stageText?: string;
  progress: number;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已暂停',
};

const MERGE_LABEL: Record<MergeMode, string> = {
  fast: '快速合并',
  compatible: '兼容合并',
  require1080: '仅 1080P',
};

export default function DownloadManager() {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const [mergeRuns, setMergeRuns] = useState<Record<string, MergeRun>>({});
  const [transcodePercent, setTranscodePercent] = useState<Record<string, number>>({});
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
  // 合并进度：不订阅的话进度条永远是 0，用户只能干等。
  useEffect(
    () =>
      window.api.on(Events.mergeProgress, (payload) => {
        setMergeRuns((previous) => ({
          ...previous,
          [payload.seriesId]: {
            stage: payload.stage,
            stageText: payload.stageText,
            progress: Math.max(0, Math.min(100, Number(payload.progress) || 0)),
          },
        }));
      }),
    [],
  );
  useEffect(
    () =>
      window.api.on(Events.mergeState, (payload) => {
        setMergeRuns((previous) => {
          const next = { ...previous };
          if (payload.status === 'running')
            next[payload.seriesId] = next[payload.seriesId] ?? { stage: 'running', progress: 0 };
          else delete next[payload.seriesId];
          return next;
        });
        setNotice(
          payload.status === 'completed'
            ? `合并完成：${payload.outputPath ?? ''}`
            : `合并${payload.status === 'stopped' ? '已取消' : '失败'}：${payload.error ?? ''}`,
        );
      }),
    [],
  );
  // 转码进度：转码是分钟级的，没有进度就跟卡死一样。
  useEffect(
    () =>
      window.api.on(Events.transcodeProgress, (payload) => {
        setTranscodePercent((previous) => ({
          ...previous,
          [payload.taskId]: Math.max(0, Math.min(100, Number(payload.percent) || 0)),
        }));
      }),
    [],
  );
  // 存储写失败必须让用户看到，否则「设置没保存上」是无声的。
  useEffect(
    () =>
      window.api.on(Events.storageError, (payload) => {
        setNotice(`本地数据保存失败：${payload.error}`);
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
    mutationFn: (input: { seriesId: string; mode: MergeMode }) =>
      api.mergeStart({
        seriesId: input.seriesId,
        compatible: input.mode === 'compatible',
        require1080: input.mode === 'require1080',
      }),
    onSuccess: (result) => setNotice(`合并已启动：${result.outputPath}`),
    onError: (error) => setNotice(`合并失败：${(error as Error).message}`),
  });

  const cancelMerge = useMutation({
    mutationFn: (seriesId: string) => api.mergeCancel(seriesId),
    onSuccess: () => setNotice('已请求取消合并'),
    onError: (error) => setNotice(`取消失败：${(error as Error).message}`),
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
    onSuccess: (result) => {
      setNotice(`转码完成，可直接播放：${result.url}`);
      setTranscodePercent((previous) => {
        const next = { ...previous };
        for (const id of Object.keys(next)) {
          if (result.url.endsWith(id)) delete next[id];
        }
        return next;
      });
    },
    onError: (error) => setNotice(`转码失败：${(error as Error).message}`),
  });

  const completed = tasks.filter((task) => task.status === 'completed');
  const seriesIds = [...new Set(completed.map((task) => task.seriesId))];
  const titleOf = (seriesId: string) =>
    tasks.find((task) => task.seriesId === seriesId)?.seriesTitle ?? seriesId;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">下载管理</h2>
      </header>

      {notice && <p className="text-[var(--font-size-label)] text-secondary-text">{notice}</p>}

      {seriesIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>剧集合集</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {seriesIds.map((seriesId) => {
              const run = mergeRuns[seriesId];
              return (
                <div key={seriesId} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 truncate text-[var(--font-size-label)]">
                      《{titleOf(seriesId)}》
                    </span>
                    {(Object.keys(MERGE_LABEL) as MergeMode[]).map((mode) => (
                      <Button
                        key={mode}
                        size="sm"
                        variant={mode === 'fast' ? 'primary' : 'outline'}
                        disabled={merge.isPending || Boolean(run)}
                        onClick={() => merge.mutate({ seriesId, mode })}
                      >
                        {MERGE_LABEL[mode]}
                      </Button>
                    ))}
                    {run && (
                      <Button size="sm" variant="ghost" onClick={() => cancelMerge.mutate(seriesId)}>
                        取消合并
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={deleteSeriesFiles.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `只删除《${titleOf(seriesId)}》已下载的文件（其它剧不受影响），此操作不可恢复。`,
                          )
                        ) {
                          deleteSeriesFiles.mutate(seriesId);
                        }
                      }}
                    >
                      删除文件
                    </Button>
                  </div>
                  {run && (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-selection">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{ width: `${run.progress}%` }}
                        />
                      </div>
                      <p className="text-[var(--font-size-caption)] text-muted">
                        {run.stageText || run.stage} · {run.progress}%
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-2">
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
                  <Button size="sm" onClick={() => transcode.mutate(task.id)} disabled={transcode.isPending}>
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
                {transcodePercent[task.id] !== undefined ? ` · 转码 ${transcodePercent[task.id]}%` : ''}
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
