import { Badge, Button, Card, CardContent, CardTitle, Skeleton } from '@hongguo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import DanmakuLayer from '../components/DanmakuLayer.tsx';
import VideoEnhancement, { useEnhancementSettings } from '../components/VideoEnhancement.tsx';
import { api } from '../lib/api.ts';
import { prefetchNextEpisode } from '../lib/prefetch.ts';
import { ignoresPlaybackShortcut, readShortcuts, SHORTCUT_ACTIONS, shortcutKey } from '../lib/shortcuts.ts';

interface Episode {
  vid: string;
  vid_index: number;
  title?: string;
  locked?: boolean;
}

interface SeriesEntry {
  series_id: string;
  series_title?: string;
  cover?: string;
  episodes?: Episode[];
  total?: number;
}

export default function Library() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [floating, setFloating] = useState(false);
  const [playing, setPlaying] = useState<{
    url: string;
    label: string;
    vid: string;
    vidIndex: number;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const enhancement = useEnhancementSettings();
  const [enhanceStatus, setEnhanceStatus] = useState('');
  const lastTimePush = useRef(0);
  const [autoNext, setAutoNext] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoNextRef = useRef(true);
  const listRef = useRef<Episode[]>([]);
  const playingRef = useRef<string>('');
  const lastSavedAt = useRef(0);
  const restoredFor = useRef('');

  const library = useQuery({ queryKey: ['library'], queryFn: () => api.libraryList() });
  const entries = Array.isArray(library.data) ? (library.data as SeriesEntry[]) : [];
  const current = entries.find((entry) => entry.series_id === selected);

  const episodes = useQuery({
    queryKey: ['episodes', selected],
    queryFn: () => api.seriesEpisodes(selected),
    enabled: Boolean(selected),
  });
  const detail = (episodes.data ?? current) as SeriesEntry | undefined;
  const list = detail?.episodes ?? [];

  const play = useMutation({
    mutationFn: (episode: Episode) =>
      api.playPrepare({ vid: episode.vid, seriesId: selected, quality: 'auto' }),
    onSuccess: async (result, episode) => {
      setPlaying({
        url: result.url,
        label: `第 ${episode.vid_index} 集`,
        vid: episode.vid,
        vidIndex: episode.vid_index,
      });
      void client.invalidateQueries({ queryKey: ['history'] });
      // 续播：只有进度属于同一集时才有意义，跨集不套用时间。
      const saved = await api.progressGet(selected);
      if (!saved || saved.vid !== episode.vid) return;
      restoredFor.current = episode.vid;
      const video = videoRef.current;
      if (video && saved.currentTime > 3) {
        video.currentTime = saved.currentTime;
        setNotice(`从上次的 ${Math.floor(saved.currentTime)} 秒继续`);
      }
    },
    onError: (error) => setNotice(`播放失败：${(error as Error).message}`),
  });

  const [danmaku, setDanmaku] = useState<{ items: unknown[]; notice: string } | null>(null);
  const [danmakuOn, setDanmakuOn] = useState(true);

  // 弹幕：换集才拉一次；拿不到时把原因显示出来，不假装「本集没有弹幕」。
  useEffect(() => {
    if (!playing) {
      setDanmaku(null);
      return;
    }
    let alive = true;
    void api
      .danmaku(playing.vid, selected)
      .then((result) => {
        if (alive) setDanmaku({ items: result.items ?? [], notice: result.notice ?? '' });
      })
      .catch((error: Error) => {
        if (alive) setDanmaku({ items: [], notice: `弹幕加载失败：${error.message}` });
      });
    return () => {
      alive = false;
    };
  }, [playing, selected]);

  // 预取下一集：失败静默，不影响当前播放；离开当前集即取消。
  useEffect(() => {
    if (!playing || !list.length) return;
    let canceled = false;
    void prefetchNextEpisode({
      seriesId: selected,
      currentVid: playing.vid,
      episodes: list.map((episode) => ({ vid: episode.vid, locked: episode.locked })),
    });
    // 预取在主进程执行；离开这一集时不再需要结果，用标记位忽略即可。
    return () => {
      canceled = true;
    };
  }, [playing, list, selected]);

  const toggleFloat = async (): Promise<void> => {
    if (floating) {
      await api.floatClose();
      setFloating(false);
      return;
    }
    if (!playing) return;
    const settings = (await api.getSettings()) as { picture_in_picture_mode?: string };
    // native：交给系统画中画，视频继续在应用内播放；custom：开应用自己的悬浮窗口。
    if (settings?.picture_in_picture_mode !== 'custom') {
      const video = videoRef.current as
        | (HTMLVideoElement & {
            requestPictureInPicture?: () => Promise<unknown>;
          })
        | null;
      if (video?.requestPictureInPicture && !document.pictureInPictureElement) {
        try {
          await video.requestPictureInPicture();
          setFloating(true);
          return;
        } catch {
          setNotice('系统不支持画中画，已改用悬浮小窗');
        }
      }
    }
    await api.floatOpen(playing.vid, selected);
    setFloating(true);
  };

  const playRef = useRef<((episode: Episode) => void) | null>(null);
  playRef.current = (episode: Episode) => play.mutate(episode);

  const enqueue = useMutation({
    mutationFn: () =>
      api.downloadEnqueue({
        seriesId: selected,
        seriesTitle: detail?.series_title ?? '',
        vids: [...picked],
        quality: 'auto',
      }),
    onSuccess: (result) => {
      const count = Array.isArray(result) ? result.length : 0;
      setNotice(`已加入下载队列 ${count} 集`);
      setPicked(new Set());
      void client.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (error) => setNotice(`加入队列失败：${(error as Error).message}`),
  });

  /** 每 5 秒最多落盘一次；拖动回看不会把进度写小（主进程侧取 max）。 */
  const saveProgress = useCallback(
    (video: HTMLVideoElement, watched = false) => {
      if (!playing || !Number.isFinite(video.currentTime)) return;
      const now = Date.now();
      if (!watched && now - lastSavedAt.current < 5000) return;
      lastSavedAt.current = now;
      void api
        .progressSave({
          seriesId: selected,
          vid: playing.vid,
          vidIndex: playing.vidIndex,
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          watched,
        })
        .catch(() => {
          /* 进度保存失败不影响播放 */
        });
    },
    [playing, selected],
  );

  const exportText = useMutation({
    mutationFn: (kinds: { danmaku: boolean; comments: boolean; reviews: boolean }) =>
      api.exportText({ seriesId: selected, seriesTitle: detail?.series_title ?? '', kinds }),
    onSuccess: (result) => {
      const total = result.danmaku.items + result.comments.items + result.reviews.items;
      const failed = result.danmaku.fail + result.comments.fail + result.reviews.fail;
      setNotice(
        result.files.length
          ? `已导出 ${total} 条文字，${result.files.length} 个文件${failed ? `，${failed} 项失败` : ''}`
          : '没有可导出的文字数据',
      );
    },
    onError: (error) => setNotice(`导出失败：${(error as Error).message}`),
  });

  listRef.current = list;
  playingRef.current = playing?.vid ?? '';
  autoNextRef.current = autoNext;

  /** 键盘快捷键：绑定优先，未命中的按键保留浏览器默认行为。 */
  useEffect(() => {
    const bindings = readShortcuts();
    const actionOf = new Map(SHORTCUT_ACTIONS.map((action) => [bindings[action.id], action]));

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!playRef.current) return;
      const video = videoRef.current;
      if (!video) return;
      if (ignoresPlaybackShortcut(event.target, shortcutKey(event))) return;
      const key = shortcutKey(event);
      if (!key) return;
      const action = actionOf.get(key);
      if (!action) return;
      if (event.repeat && action.repeat !== true) return;
      event.preventDefault();
      switch (action.id) {
        case 'play':
          if (video.paused) void video.play();
          else video.pause();
          break;
        case 'backward':
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case 'forward':
          video.currentTime = Math.min(video.duration || Number.POSITIVE_INFINITY, video.currentTime + 5);
          break;
        case 'previous':
        case 'next': {
          const index = listRef.current.findIndex((episode) => episode.vid === playingRef.current);
          const target = listRef.current[action.id === 'next' ? index + 1 : index - 1];
          if (target && !target.locked) playRef.current(target);
          break;
        }
        case 'autoNext':
          setAutoNext((value) => !value);
          break;
        case 'slower':
        case 'faster': {
          const next = Math.min(
            3,
            Math.max(0.25, Number((video.playbackRate + (action.id === 'faster' ? 0.25 : -0.25)).toFixed(2))),
          );
          video.playbackRate = next;
          setSpeed(next);
          break;
        }
        case 'fullscreen':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void video.parentElement?.requestFullscreen?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const remove = useMutation({
    mutationFn: (seriesId: string) => api.libraryRemove(seriesId),
    onSuccess: () => {
      setSelected('');
      void client.invalidateQueries({ queryKey: ['library'] });
    },
  });

  if (selected) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setSelected('')}>
              返回剧库
            </Button>
            <h2 className="text-[15px] font-semibold">{detail?.series_title ?? selected}</h2>
            {list.length ? <Badge>共 {list.length} 集</Badge> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => setPicked(new Set(list.filter((ep) => !ep.locked).map((ep) => ep.vid)))}>
              全选可播
            </Button>
            <Button
              variant="primary"
              disabled={!picked.size || enqueue.isPending}
              onClick={() => enqueue.mutate()}
            >
              下载所选（{picked.size}）
            </Button>
            <Button
              disabled={exportText.isPending}
              onClick={() => exportText.mutate({ danmaku: true, comments: true, reviews: true })}
              title="把弹幕、单集评论与剧评导出成 JSON，放在视频同目录"
            >
              导出文字
            </Button>
          </div>
        </header>

        {notice && <p className="text-[var(--font-size-label)] text-secondary-text">{notice}</p>}

        {playing && (
          <Card className="overflow-hidden">
            <div className="relative">
              <VideoEnhancement
                video={videoRef.current}
                settings={enhancement.settings}
                onStatus={setEnhanceStatus}
              />
              <DanmakuLayer
                items={(danmaku?.items ?? []) as never[]}
                currentTime={currentTime}
                visible={danmakuOn}
                notice={danmaku?.notice ?? ''}
              />
              {/* biome-ignore lint/a11y/useMediaCaption: 短剧片源没有字幕轨，页面也无可提供的字幕来源 */}
              <video
                key={playing.url}
                ref={videoRef}
                src={playing.url}
                controls
                autoPlay
                className="max-h-[52vh] w-full bg-black"
                aria-label={`正在播放 ${playing.label}`}
                onTimeUpdate={(event) => {
                  saveProgress(event.currentTarget);
                  // 弹幕只需要每 250ms 一个时间点，避免每次 timeupdate 都重渲染。
                  if (Date.now() - lastTimePush.current < 250) return;
                  lastTimePush.current = Date.now();
                  setCurrentTime(event.currentTarget.currentTime);
                }}
                onPause={(event) => saveProgress(event.currentTarget, true)}
                onEnded={(event) => {
                  saveProgress(event.currentTarget, true);
                  if (!autoNextRef.current) return;
                  const index = listRef.current.findIndex((episode) => episode.vid === playingRef.current);
                  const next = listRef.current[index + 1];
                  if (next && !next.locked) playRef.current?.(next);
                }}
              />
            </div>
            <CardContent className="flex items-center justify-between gap-2 pt-2 text-[var(--font-size-caption)] text-muted">
              <span>
                {enhanceStatus ? `${playing.label} · ${enhanceStatus}` : playing.label} · 倍速 {speed}× · 连播
                {autoNext ? '开' : '关'} · 空格暂停、←→ 快进退、↑↓ 换集、A 连播、S/D 调速、F 全屏
              </span>
              <Button size="sm" variant="ghost" onClick={() => setDanmakuOn((value) => !value)}>
                弹幕{danmakuOn ? '关' : '开'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void toggleFloat()}>
                {floating ? '关闭悬浮小窗' : '悬浮小窗'}
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-6 gap-2 overflow-y-auto md:grid-cols-10">
          {list.map((episode) => (
            <button
              key={episode.vid}
              type="button"
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(episode.vid)) next.delete(episode.vid);
                  else next.add(episode.vid);
                  return next;
                })
              }
              onDoubleClick={() => !episode.locked && play.mutate(episode)}
              className={[
                'flex h-10 flex-col items-center justify-center rounded-[var(--radius-control)] border text-[var(--font-size-caption)]',
                episode.locked
                  ? 'border-border-subtle text-muted line-through'
                  : picked.has(episode.vid)
                    ? 'border-accent bg-selection text-primary-text'
                    : 'border-border-subtle bg-surface text-secondary-text hover:bg-selection',
              ].join(' ')}
              title={episode.locked ? '该集未开放' : '单击选中下载，双击播放'}
            >
              <span className="font-medium">{episode.vid_index}</span>
              {episode.locked && <span className="text-[9px]">锁定</span>}
            </button>
          ))}
        </div>
        <p className="text-[var(--font-size-caption)] text-muted">
          单击选中下载，双击播放；锁定分集不会进入下载队列。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <h2 className="text-[15px] font-semibold">我的剧库</h2>
      {library.isError && (
        <p className="text-[var(--font-size-label)] text-danger">
          剧库读取失败：{(library.error as Error).message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 overflow-y-auto md:grid-cols-4 xl:grid-cols-6">
        {library.isPending
          ? Array.from({ length: 6 }, (_, index) => `l${index}`).map((key) => (
              <Skeleton key={key} className="aspect-[3/4] w-full" />
            ))
          : entries.map((entry) => (
              <Card key={entry.series_id} className="overflow-hidden">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelected(entry.series_id)}
                >
                  <div className="aspect-[3/4] w-full bg-selection">
                    {entry.cover ? (
                      <img src={entry.cover} alt="" loading="lazy" className="size-full object-cover" />
                    ) : null}
                  </div>
                  <CardContent className="pt-3">
                    <CardTitle className="line-clamp-2 text-[var(--font-size-label)]">
                      {entry.series_title ?? entry.series_id}
                    </CardTitle>
                  </CardContent>
                </button>
                <div className="px-4 pb-3">
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(entry.series_id)}>
                    移出剧库
                  </Button>
                </div>
              </Card>
            ))}
        {!library.isPending && !entries.length && (
          <p className="text-[var(--font-size-label)] text-muted">
            剧库是空的。先在「搜索与下载」里搜索并打开一部剧，它会被登记到剧库。
          </p>
        )}
      </div>
    </div>
  );
}
