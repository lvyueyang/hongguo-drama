import { Button } from '@hongguo/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';

/**
 * 悬浮小窗的独立布局（`?floating=1`）。
 *
 * 与主界面刻意隔离：没有导航、没有全局快捷键、窗口内不注册任何 IPC 之外的能力。
 * 它做四件事：取播放地址 → 续播到上次位置 → 播放 → 上报进度；播完自动接下一集。
 *
 * 为什么自己查分集表：进度记录要写真实集号（`vidIndex`），写死 1 会让观看记录、
 * 续播位置全部错位；顺带也要它才能知道「下一集是谁」。
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
  /** 供测试注入；默认 api.seriesEpisodes */
  loadEpisodes?: (seriesId: string) => Promise<Array<{ vid: string; vid_index: number; locked?: boolean }>>;
  /** 供测试注入；默认 api.progressGet */
  readProgress?: (seriesId: string) => Promise<{ vid?: string; currentTime?: number } | null>;
}

export default function FloatingPlayer({
  vid,
  seriesId,
  load,
  save,
  loadEpisodes,
  readProgress,
}: FloatingPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSaved = useRef(0);
  const resumeRef = useRef<number | null>(null);
  const [currentVid, setCurrentVid] = useState(vid);
  const [episodes, setEpisodes] = useState<Array<{ vid: string; vid_index: number; locked?: boolean }>>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setCurrentVid(vid), [vid]);

  const index = episodes.findIndex((episode) => episode.vid === currentVid);
  const episode = index >= 0 ? episodes[index] : undefined;
  // 分集表还没到时先按 1 记（至少不会写成一个越界值），拿到后立刻用真实集号。
  const vidIndex = episode?.vid_index ?? (index >= 0 ? index + 1 : 1);

  // 分集表：只为拿到真实集号与下一集；查不到不影响播放。
  useEffect(() => {
    if (!seriesId) return;
    let alive = true;
    const fetchList =
      loadEpisodes ??
      (async (id: string) => {
        const detail = (await api.seriesEpisodes(id)) as {
          episodes?: Array<{ vid: string; vid_index: number; locked?: boolean }>;
        };
        return detail?.episodes ?? [];
      });
    void Promise.resolve()
      .then(() => fetchList(seriesId))
      .then((list) => {
        if (alive && Array.isArray(list)) setEpisodes(list);
      })
      .catch(() => {
        /* 分集表拿不到就退化成「集号 1、不连播」 */
      });
    return () => {
      alive = false;
    };
  }, [seriesId, loadEpisodes]);

  useEffect(() => {
    let alive = true;
    setError('');
    setUrl('');
    const run =
      load ??
      ((targetVid: string, targetSeries: string) =>
        api.playPrepare({ vid: targetVid, seriesId: targetSeries, quality: 'auto' }));
    void run(currentVid, seriesId)
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
    // 续播：只有进度属于同一集才用；位置在 loadedmetadata 里落地。
    const read = readProgress ?? (async (id: string) => (await api.progressGet(id)) as never);
    void Promise.resolve()
      .then(() => read(seriesId))
      .then((saved) => {
        if (!alive || !saved) return;
        resumeRef.current =
          saved.vid === currentVid && Number(saved.currentTime) > 3 ? Number(saved.currentTime) : null;
      })
      .catch(() => {
        /* 读不到进度就从头播 */
      });
    return () => {
      alive = false;
    };
  }, [currentVid, seriesId, load, readProgress]);

  const writeProgress = useCallback(
    (video: HTMLVideoElement, watched: boolean, immediate = false, ended = false): void => {
      if (!Number.isFinite(video.currentTime)) return;
      if (!watched && !immediate && Date.now() - lastSaved.current < 5000) return;
      lastSaved.current = Date.now();
      const write =
        save ??
        ((progress: Parameters<NonNullable<FloatingPlayerProps['save']>>[0]) => api.progressSave(progress));
      void write({
        seriesId,
        vid: currentVid,
        vidIndex,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        watched,
        ...(ended ? { ended: true } : {}),
      } as never);
    },
    [currentVid, save, seriesId, vidIndex],
  );

  const report = (watched: boolean): void => {
    const video = videoRef.current;
    if (video) writeProgress(video, watched);
  };

  /** 播完：先把这一集写成 watched，再顺延到下一集（锁定的不自动播）。 */
  const handleEnded = (): void => {
    const video = videoRef.current;
    if (video) writeProgress(video, true, true, true);
    const next = index >= 0 ? episodes[index + 1] : undefined;
    if (!next || next.locked) return;
    setCurrentVid(next.vid);
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
          onLoadedMetadata={(event) => {
            const pending = resumeRef.current;
            if (pending === null) return;
            resumeRef.current = null;
            event.currentTarget.currentTime = pending;
          }}
          onTimeUpdate={() => report(false)}
          onPause={() => report(true)}
          onEnded={handleEnded}
        />
      )}
      <div className="flex items-center justify-between px-2 py-1 text-[var(--font-size-caption)] text-muted">
        <span>{url ? `小窗播放中 · 第 ${vidIndex} 集` : '正在准备…'}</span>
        <Button size="sm" variant="ghost" onClick={() => void api.floatClose()}>
          收回主窗口
        </Button>
      </div>
    </div>
  );
}
