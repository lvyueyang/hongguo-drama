import { Events } from '@hongguo/contract';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

interface Announcement {
  id?: string;
  title?: string;
  body?: string;
  level?: string;
}

/**
 * 紧急公告横幅。
 *
 * 主进程会主动推（`announcement` 事件），这里只负责显示与「知道了」。
 * 为什么放在主界面而不是设置页：紧急公告的意义就是用户不去设置页也能看到。
 */
export function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null);
  const [error, setError] = useState('');

  useEffect(
    () =>
      window.api.on(Events.announcement, (payload) => {
        const announcement = (payload as { announcement?: Announcement | null } | null)?.announcement;
        if (announcement?.id) setItem(announcement);
      }),
    [],
  );

  if (!item) return null;

  return (
    <Card className="border-accent/40">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{item.title || '公告'}</CardTitle>
        <Button
          size="sm"
          onClick={() => {
            // 先收起再落盘：存储失败也只是下次再提醒一次，不能把横幅卡在界面上。
            const id = item.id;
            setItem(null);
            void api.announcementDismiss('day').catch((cause: Error) => setError(cause.message));
            void id;
          }}
        >
          知道了
        </Button>
      </CardHeader>
      <CardContent className="space-y-1 whitespace-pre-wrap text-[var(--font-size-label)] text-secondary-text">
        {item.body ?? ''}
        {error && <p className="text-[var(--font-size-caption)] text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}

export default AnnouncementBanner;
