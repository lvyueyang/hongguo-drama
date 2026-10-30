import { Button } from '@hongguo/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';

/**
 * 悬浮小窗的独立布局（`?floating=1`）。
 *
 * 与主界面刻意隔离：没有导航、没有全局快捷键、窗口内不注册任何 IPC 之外的能力。
 * 它只做三件事：取播放地址 → 播放 → 上报进度；关闭即回到主窗口继续。
 */
export interface FloatingPlayerProps {
  vid: string;
  seriesId: string;
  /** 供测试注入；默认用 api */
  load?: (vid: string, seriesId: string) => Promise<{ url?: string; error?: string }>;
  save?: (progress: {
    seriesId: string;
    vid: string;
    vidIndex: number;
    currentTime: number;
    duration: number;
    watched: boolean;
  }) => Promise<unknown>;
}

export default function FloatingPlayer({ vid, seriesId, load, save }: FloatingPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSaved = useRef(0);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const run =
      load ??
      ((targetVid: string, targetSeries: string) =>
        api.playPrepare({ vid: targetVid, seriesId: targetSeries, quality: 'auto' }));
    void run(vid, seriesId)
      .then((result) => {
        if (!alive) return;
        if (!result?.url) {
          const failure = result as { error?: string } | undefined;
          setError(failure?.error ?? '来源未开放该集');
          return;
        }
        setUrl(result.url);
      })
      .catch((failure: Error) => {
        if (alive) setError(failure.message);
      });
    return () => {
      alive = false;
    };
  }, [vid, seriesId, load]);

  // 进度上报：节流 5 秒，和小窗外的播放保持一致，避免每帧写盘。
  const report = (watched: boolean): void => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.currentTime)) return;
    if (!watched && Date.now() - lastSaved.current < 5000) return;
    lastSaved.current = Date.now();
    const write =
      save ??
      ((progress: Parameters<NonNullable<FloatingPlayerProps['save']>>[0]) => api.progressSave(progress));
    void write({
      seriesId,
      vid,
      vidIndex: 1,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      watched,
    });
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[var(--color-surface)]">
      {error ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[var(--font-size-label)] text-secondary-text">
          {error}
        </div>
      ) : (
        /* biome-ignore lint/a11y/useMediaCaption: 短剧片源没有字幕轨 */
        <video
          ref={videoRef}
          src={url || undefined}
          controls
          autoPlay
          className="min-h-0 flex-1 bg-black"
          aria-label="悬浮小窗播放"
          onTimeUpdate={() => report(false)}
          onPause={() => report(true)}
          onEnded={() => report(true)}
        />
      )}
      <div className="flex items-center justify-between px-2 py-1 text-[var(--font-size-caption)] text-muted">
        <span>{url ? '小窗播放中' : '正在准备…'}</span>
        <Button size="sm" variant="ghost" onClick={() => void api.floatClose()}>
          收回主窗口
        </Button>
      </div>
    </div>
  );
}
