import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '@hongguo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';

interface SourceView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/**
 * 自定义源管理（CMS 接口）。
 *
 * 4.5 有这块界面，重构后只剩 SDK 能力、没有入口——用户只能手改设置文件。
 * 这里只做「增删与启停」：新增时先真连一次接口（`test: true`），
 * 免得存进一个打不开的来源，之后每次搜索都等它超时。
 */
export function CustomSourceManager() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // 清单取设置里的完整列表（含停用的）；browseSources 只返回启用的，停用后就再也看不到了。
  const sources: SourceView[] = Array.isArray(
    (settings.data as { custom_sources?: SourceView[] })?.custom_sources,
  )
    ? ((settings.data as { custom_sources?: SourceView[] }).custom_sources as SourceView[])
    : [];

  async function submit(request: {
    source: { id?: string; name: string; url: string; enabled?: boolean };
    remove?: boolean;
    test?: boolean;
  }): Promise<void> {
    setBusy(true);
    try {
      const result = await api.customSourceSave({
        source: request.source,
        remove: request.remove === true,
        test: request.test === true,
      });
      if (!result.success) {
        setNotice(result.error ?? '保存失败');
        return;
      }
      setNotice(request.remove ? '已删除' : '已保存');
      if (!request.source.id) {
        setName('');
        setUrl('');
      }
      await client.invalidateQueries({ queryKey: ['settings'] });
      await client.invalidateQueries({ queryKey: ['browseSources'] });
    } catch (error) {
      setNotice(`保存失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>自定义源</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[var(--font-size-caption)] text-muted">
          填入 CMS 接口地址（如 <code>https://example.com/api.php/provide/vod/</code>）。只接受公网
          HTTP/HTTPS。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="来源名称"
            placeholder="名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            aria-label="接口地址"
            placeholder="https://example.com/api.php/provide/vod/"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            disabled={busy || !name.trim() || !url.trim()}
            onClick={() => void submit({ source: { name: name.trim(), url: url.trim() }, test: true })}
          >
            测试并保存
          </Button>
        </div>

        {sources.length === 0 && (
          <p className="text-[var(--font-size-label)] text-muted">还没有添加自定义源。</p>
        )}
        {sources.map((source) => (
          <div key={source.id} className="flex flex-wrap items-center gap-2">
            <span className="text-[var(--font-size-label)]">{source.name}</span>
            <Badge tone={source.enabled ? 'success' : 'neutral'}>
              {source.enabled ? '已启用' : '已停用'}
            </Badge>
            <span className="break-all text-[var(--font-size-caption)] text-muted">{source.url}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void submit({
                  source: { id: source.id, name: source.name, url: source.url, enabled: !source.enabled },
                })
              }
            >
              {source.enabled ? '停用' : '启用'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void submit({ source: { id: source.id, name: source.name, url: source.url }, test: true })
              }
            >
              测试连通
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`删除自定义源《${source.name}》？已下载的文件会保留。`)) return;
                void submit({ source: { id: source.id, name: source.name, url: source.url }, remove: true });
              }}
            >
              删除
            </Button>
          </div>
        ))}

        {notice && <p className="text-[var(--font-size-caption)] text-secondary-text">{notice}</p>}
      </CardContent>
    </Card>
  );
}

export default CustomSourceManager;
