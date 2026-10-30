import { Events } from '@hongguo/contract';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

interface AccountState {
  signedIn?: boolean;
  account?: { id: string; nickname: string } | null;
  error?: string;
  storageWarning?: string;
}

export default function Account() {
  const client = useQueryClient();
  const [qr, setQr] = useState<{ loginId: string; image: string } | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  const account = useQuery({ queryKey: ['account'], queryFn: () => api.accountStatus() });
  const state = (account.data ?? {}) as AccountState;
  const cloud = useQuery({
    queryKey: ['accountHistory'],
    queryFn: () => api.accountHistory(false),
    enabled: state.signedIn === true,
  });
  const rows = Array.isArray((cloud.data as { results?: unknown })?.results)
    ? (cloud.data as { results: Array<Record<string, unknown>> }).results
    : [];
  const visible = rows.filter(
    (row) => !query.trim() || String(row.series_title ?? '').includes(query.trim()),
  );

  useEffect(
    () =>
      window.api.on(Events.accountUpdated, () => void client.invalidateQueries({ queryKey: ['account'] })),
    [client],
  );

  const start = useMutation({
    mutationFn: () => api.accountStartLogin(),
    onSuccess: (result) => {
      const data = result as { loginId: string; image: string; expiresIn: number };
      setQr({ loginId: data.loginId, image: data.image });
      setStatus(`请用手机红果 App 扫码确认，二维码约 ${data.expiresIn} 秒有效。`);
    },
    onError: (error) => setStatus((error as Error).message),
  });

  const poll = useMutation({
    mutationFn: (loginId: string) => api.accountPollLogin(loginId),
    onSuccess: async (result) => {
      const data = result as { status?: string; account?: AccountState['account']; storageWarning?: string };
      if (data.status === 'signed-in') {
        setQr(null);
        setStatus(data.storageWarning || '登录成功');
        await client.invalidateQueries({ queryKey: ['account'] });
        return;
      }
      if (data.status === 'expired') {
        setQr(null);
        setStatus('二维码已过期，请重新获取。');
        return;
      }
      setStatus('等待手机确认扫码登录…');
      setTimeout(() => qr && poll.mutate(qr.loginId), 1200);
    },
    onError: (error) => setStatus((error as Error).message),
  });

  const logout = useMutation({
    mutationFn: () => api.accountLogout(),
    onSuccess: async () => {
      setStatus('已退出登录');
      await client.invalidateQueries({ queryKey: ['account'] });
    },
  });

  const cancel = useMutation({
    mutationFn: (loginId: string) => api.accountCancelLogin(loginId),
    onSuccess: () => {
      setQr(null);
      setStatus('已取消扫码');
    },
  });

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>红果账号</CardTitle>
          {state.signedIn ? (
            <div className="flex items-center gap-2">
              <span className="text-[var(--font-size-label)] text-secondary-text">
                {state.account?.nickname ?? '已登录'}
              </span>
              <Button onClick={() => logout.mutate()} disabled={logout.isPending}>
                退出账号
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending}>
              获取登录二维码
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {qr ? (
            <div className="flex items-center gap-4">
              <img
                src={qr.image}
                alt="登录二维码"
                className="h-40 w-40 rounded-[var(--radius-control)] bg-surface"
              />
              <Button variant="ghost" onClick={() => cancel.mutate(qr.loginId)}>
                取消扫码
              </Button>
            </div>
          ) : null}
          {status && <p className="text-[var(--font-size-label)] text-secondary-text">{status}</p>}
          <p className="text-[var(--font-size-caption)] text-muted">
            登录态只用于读取云端观看记录；取流仍使用匿名设备身份，不受登录影响。
          </p>
        </CardContent>
      </Card>

      {state.signedIn && (
        <Card>
          <CardHeader>
            <CardTitle>APP 观看记录（最近 50 部）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按剧名筛选"
              aria-label="筛选 APP 观看记录"
            />
            <ul className="divide-y divide-border-subtle">
              {visible.map((row) => (
                <li key={String(row.series_id)} className="flex items-center gap-3 py-2">
                  {typeof row.cover === 'string' && row.cover ? (
                    <img
                      src={row.cover}
                      alt=""
                      className="h-14 w-10 rounded-[var(--radius-control)] object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[var(--font-size-label)]">{String(row.series_title ?? '')}</p>
                    <p className="text-[var(--font-size-caption)] text-muted">
                      看到第 {String(row.vid_index ?? '?')} 集
                    </p>
                  </div>
                </li>
              ))}
              {!visible.length && (
                <li className="py-2 text-[var(--font-size-label)] text-muted">没有可显示的记录。</li>
              )}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
