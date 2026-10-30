import { Events } from '@hongguo/contract';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CustomSourceManager } from '../components/CustomSourceManager.tsx';
import { EnhancementControls, useEnhancementSettings } from '../components/VideoEnhancement.tsx';
import { api } from '../lib/api.ts';
import ShortcutSettings from './ShortcutSettings.tsx';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function Settings() {
  const enhancement = useEnhancementSettings();
  const client = useQueryClient();
  const info = useQuery({ queryKey: ['appInfo'], queryFn: api.appInfo });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [storageNotice, setStorageNotice] = useState('');

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const announcement = useQuery({ queryKey: ['announcement'], queryFn: api.announcementGet, retry: 0 });
  const dismiss = useMutation({
    mutationFn: (mode: 'day' | 'version') => api.announcementDismiss(mode),
    onSuccess: () => client.invalidateQueries({ queryKey: ['announcement'] }),
  });

  const [proxyNotice, setProxyNotice] = useState('');
  const applyProxy = useMutation({
    mutationFn: () => api.proxyApply(),
    onSuccess: (result) => setProxyNotice(`已应用代理模式：${(result as { mode?: string }).mode ?? '—'}`),
    onError: (error) => setProxyNotice(`应用失败：${(error as Error).message}`),
  });
  const testProxy = useMutation({
    mutationFn: () => api.proxyTest(draft),
    onSuccess: (result) => {
      const data = result as { success?: boolean; status?: number; ms?: number };
      setProxyNotice(
        data.success ? `连通正常（HTTP ${data.status}，${data.ms} ms）` : `连通异常（HTTP ${data.status}）`,
      );
    },
    onError: (error) => setProxyNotice(`测试失败：${(error as Error).message}`),
  });

  const usage = useQuery({ queryKey: ['storageUsage'], queryFn: api.storageUsage, retry: 0 });
  const deleteAll = useMutation({
    mutationFn: () => api.storageDeleteAll(),
    onSuccess: (result) => {
      const data = result as {
        deleted: number;
        bytes: number;
        failed: string[];
        skipped?: string[];
        skippedFiles?: number;
      };
      // 正在合并的剧集会被跳过（删源文件会让合并中途失败），必须如实告诉用户。
      const skipped = data.skipped?.length
        ? `；${data.skipped.length} 部剧正在合并已跳过${data.skippedFiles ? `（${data.skippedFiles} 个文件）` : ''}`
        : '';
      setStorageNotice(
        `已删除 ${data.deleted} 个文件（${formatBytes(data.bytes)}）${data.failed.length ? `，${data.failed.length} 个删除失败` : ''}${skipped}`,
      );
      void client.invalidateQueries({ queryKey: ['storageUsage'] });
      void client.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (error) => setStorageNotice(`删除失败：${(error as Error).message}`),
  });

  const update = useQuery({ queryKey: ['updateState'], queryFn: api.updateState, retry: 0 });
  const [updateNotice, setUpdateNotice] = useState('');
  useEffect(
    () =>
      window.api.on(Events.updateChanged, () => void client.invalidateQueries({ queryKey: ['updateState'] })),
    [client],
  );

  const checkUpdate = useMutation({
    mutationFn: () => api.updateCheck(),
    onSuccess: (data) => {
      const release = (data as { release?: { version?: string } | null }).release;
      setUpdateNotice(release ? `发现新版本 ${release.version}` : '已是最新版本');
    },
    onError: (error) => setUpdateNotice(`检查更新失败：${(error as Error).message}`),
  });
  const downloadUpdate = useMutation({
    mutationFn: () => api.updateDownload(),
    onSuccess: (data) => {
      const result = data as { success?: boolean; error?: string };
      setUpdateNotice(result.success ? '更新已下载，可安装' : (result.error ?? '下载失败'));
    },
  });
  const installUpdate = useMutation({
    mutationFn: () => api.updateInstall(),
    onSuccess: (data) => {
      const result = data as { success?: boolean; error?: string };
      setUpdateNotice(result.success ? '正在安装，应用将重启' : (result.error ?? '安装失败'));
    },
  });

  const save = useMutation({
    mutationFn: () => api.saveSettings(draft),
    onSuccess: () => client.invalidateQueries({ queryKey: ['settings'] }),
  });

  const root = typeof draft.root === 'string' ? draft.root : '';

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle>下载目录</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Input
            value={root}
            aria-label="下载目录"
            placeholder="留空则使用系统下载目录"
            onChange={(event) => setDraft((prev) => ({ ...prev, root: event.target.value }))}
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              保存
            </Button>
            {save.isSuccess && <span className="text-[var(--font-size-caption)] text-success">已保存</span>}
            {save.isError && (
              <span className="text-[var(--font-size-caption)] text-danger">
                保存失败：{(save.error as Error).message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {(() => {
        const data = announcement.data as
          | {
              announcement?: { id?: string; title?: string; body?: string; level?: string } | null;
              error?: string;
            }
          | undefined;
        const item = data?.announcement;
        if (!item) return null;
        return (
          <Card className="border-accent/40">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{item.title ?? '公告'}</CardTitle>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => dismiss.mutate('day')}>
                  今天不再提醒
                </Button>
                <Button size="sm" variant="ghost" onClick={() => dismiss.mutate('version')}>
                  本版本不再提醒
                </Button>
              </div>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap text-[var(--font-size-label)] text-secondary-text">
              {item.body ?? ''}
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardHeader>
          <CardTitle>能力与身份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-[var(--font-size-label)]">
          <p className="flex items-center gap-2">
            登录态影响取流：
            <Badge tone={capabilities.data?.accountAffectsPlayback ? 'accent' : 'neutral'}>
              {capabilities.data?.accountAffectsPlayback ? '是' : '否（未验证前按否处理）'}
            </Badge>
          </p>
          <p className="text-muted">
            匿名设备身份：{capabilities.data?.canPlayAnonymous ? '可用' : '不可用'}
          </p>
          <p className="break-all text-muted">联想接口：{capabilities.data?.suggestEndpoint ?? '—'}</p>
        </CardContent>
      </Card>

      <ShortcutSettings />

      <EnhancementControls
        settings={enhancement.settings}
        update={enhancement.update}
        saveError={enhancement.saveError}
      />

      <CustomSourceManager />

      <Card>
        <CardHeader>
          <CardTitle>网络代理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label className="flex items-center gap-2 text-[var(--font-size-label)]">
            <input
              type="checkbox"
              checked={draft.proxy_enabled === true}
              onChange={(event) => setDraft((prev) => ({ ...prev, proxy_enabled: event.target.checked }))}
            />
            启用代理
          </label>
          <label className="flex items-center gap-2 text-[var(--font-size-label)]">
            模式
            <select
              className="input-field h-8 rounded-[var(--radius-control)] border border-border-subtle bg-surface px-2"
              value={String(draft.proxy_mode ?? 'system')}
              onChange={(event) => setDraft((prev) => ({ ...prev, proxy_mode: event.target.value }))}
            >
              <option value="system">跟随系统 / 环境变量</option>
              <option value="custom">手动指定</option>
              <option value="direct">强制直连</option>
            </select>
          </label>
          {draft.proxy_mode === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label="代理主机"
                placeholder="127.0.0.1"
                value={String(draft.proxy_host ?? '')}
                onChange={(event) => setDraft((prev) => ({ ...prev, proxy_host: event.target.value }))}
              />
              <Input
                aria-label="代理端口"
                placeholder="7890"
                value={String(draft.proxy_port ?? '')}
                onChange={(event) => setDraft((prev) => ({ ...prev, proxy_port: event.target.value }))}
              />
              <Input
                aria-label="代理用户名"
                placeholder="用户名（可选）"
                value={String(draft.proxy_username ?? '')}
                onChange={(event) => setDraft((prev) => ({ ...prev, proxy_username: event.target.value }))}
              />
              <Input
                aria-label="代理密码"
                type="password"
                placeholder="密码（可选）"
                value={String(draft.proxy_password ?? '')}
                onChange={(event) => setDraft((prev) => ({ ...prev, proxy_password: event.target.value }))}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => save.mutate(undefined as never)}
              disabled={save.isPending}
            >
              保存
            </Button>
            <Button
              onClick={() => {
                save.mutate(undefined as never, { onSuccess: () => applyProxy.mutate() });
              }}
              disabled={applyProxy.isPending}
            >
              保存并应用
            </Button>
            <Button onClick={() => testProxy.mutate()} disabled={testProxy.isPending}>
              测试连通
            </Button>
            {proxyNotice && (
              <span className="text-[var(--font-size-caption)] text-secondary-text">{proxyNotice}</span>
            )}
          </div>
          <p className="text-[var(--font-size-caption)] text-muted">
            自定义代理会同时改写进程环境变量与窗口会话；认证由浏览器登录事件提供。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>存储占用</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-[var(--font-size-label)] text-secondary-text">
              {(usage.data as { totalFiles?: number } | undefined)?.totalFiles ?? 0} 个文件 ·{' '}
              {formatBytes((usage.data as { totalBytes?: number } | undefined)?.totalBytes ?? 0)}
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={
                deleteAll.isPending || !(usage.data as { totalFiles?: number } | undefined)?.totalFiles
              }
              onClick={() => {
                const count = (usage.data as { totalFiles?: number } | undefined)?.totalFiles ?? 0;
                if (
                  window.confirm(`将删除下载目录中的 ${count} 个文件（含视频与导出的文字），此操作不可恢复。`)
                ) {
                  deleteAll.mutate();
                }
              }}
            >
              删除全部已下载
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 text-[var(--font-size-label)] text-secondary-text">
          <p className="break-all text-muted">
            统计与删除作用于同一目录：{(usage.data as { root?: string } | undefined)?.root ?? '—'}
          </p>
          {(
            usage.data as { groups?: Array<{ group: string; files: number; bytes: number }> } | undefined
          )?.groups?.map((group) => (
            <p key={group.group}>
              {group.group} · {group.files} 个文件 · {formatBytes(group.bytes)}
            </p>
          ))}
          {storageNotice && <p>{storageNotice}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>应用内更新</CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => checkUpdate.mutate()} disabled={checkUpdate.isPending}>
              检查更新
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => downloadUpdate.mutate()}
              disabled={downloadUpdate.isPending}
            >
              下载
            </Button>
            <Button size="sm" onClick={() => installUpdate.mutate()} disabled={installUpdate.isPending}>
              安装并重启
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 text-[var(--font-size-label)] text-secondary-text">
          <p>
            状态：{String((update.data as { status?: string } | undefined)?.status ?? '—')}
            {(update.data as { percent?: number } | undefined)?.percent
              ? ` · ${(update.data as { percent: number }).percent}%`
              : ''}
          </p>
          {updateNotice && <p>{updateNotice}</p>}
          <p className="text-muted">仅从官方仓库获取发行版；下载完成后由你确认安装。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-[var(--font-size-label)] text-muted">
          <p>
            {info.data?.name ?? '—'} {info.data?.version ?? ''}
          </p>
          <p>
            {info.data?.platform ?? ''} · {info.data?.architecture ?? ''}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
