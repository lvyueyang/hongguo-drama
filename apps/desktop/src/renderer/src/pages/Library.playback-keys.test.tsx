/**
 * 剧库播放器的键盘快捷键。
 *
 * 替代 4.5 `scripts/check-player-shortcuts.cjs`：那条检查用 vm 跑 Player.jsx，验证按键传播
 * （空格只切一次、方向键只动 5 秒/只换一集、输入框与菜单里的按键让位、修饰键不劫持）。
 * 纯归一化与让位规则已由 `lib/shortcuts.test.ts` 覆盖，本文件验的是**挂到剧库页之后**的真实行为。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS, SHORTCUT_STORAGE_KEY } from '../lib/shortcuts.ts';
import Library from './Library.tsx';

type Envelope = { ok: true; data: unknown };
type PlayRequest = { vid: string; seriesId: string; quality: string };

const episodes = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
  { vid: 'v3', vid_index: 3, locked: true },
];

function installApi() {
  const api = {
    libraryList: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: [{ series_id: 'A', series_title: '测试剧' }],
      }),
    ),
    seriesEpisodes: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: { series_id: 'A', series_title: '测试剧', total: 3, episodes },
      }),
    ),
    playPrepare: vi.fn<(request: PlayRequest) => Promise<Envelope>>(async (request) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${request.vid}`, sessionId: request.vid },
    })),
    progressGet: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: null })),
    progressSave: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { items: [], notice: '' } })),
    playPrefetch: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { status: 'prefetched' } })),
    on: vi.fn(() => () => {}),
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Library />
    </QueryClientProvider>,
  );
}

async function playFirstEpisode(): Promise<HTMLVideoElement> {
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 3 集')).toBeTruthy());
  const first = screen.getAllByTitle('单击选中下载，双击播放')[0] as HTMLElement;
  await act(async () => {
    fireEvent.doubleClick(first);
  });
  return waitFor(() => {
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    return video as HTMLVideoElement;
  });
}

/** jsdom 没有真实播放：把 paused/currentTime 做成可控属性，play/pause 换成计数替身。 */
function controllableMedia(video: HTMLVideoElement, duration = 100) {
  const state = { paused: true, currentTime: 0, duration };
  Object.defineProperty(video, 'paused', { configurable: true, get: () => state.paused });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value;
    },
  });
  Object.defineProperty(video, 'duration', { configurable: true, get: () => state.duration });
  const play = vi.fn(async () => {
    state.paused = false;
  });
  const pause = vi.fn(() => {
    state.paused = true;
  });
  Object.defineProperty(video, 'play', { configurable: true, value: play });
  Object.defineProperty(video, 'pause', { configurable: true, value: pause });
  return { state, play, pause };
}

/** 记下 window 上的按键并回传事件对象，便于断言 preventDefault。 */
function press(init: Record<string, unknown>, target: Element | Window = window) {
  const event = createEvent.keyDown(target, init);
  fireEvent(target, event);
  return event;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('播放控制键', () => {
  it('空格切换一次播放/暂停，按住不放不会反复切换', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    const media = controllableMedia(video);

    const on = press({ key: ' ', code: 'Space' });
    expect(on.defaultPrevented).toBe(true);
    await waitFor(() => expect(media.play).toHaveBeenCalledTimes(1));
    expect(media.state.paused).toBe(false);

    // 系统重复按键（event.repeat）不参与：play 动作没有 repeat 白名单。
    press({ key: ' ', code: 'Space', repeat: true });
    press({ key: ' ', code: 'Space', repeat: true });
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(media.pause).not.toHaveBeenCalled();

    press({ key: ' ', code: 'Space' });
    await waitFor(() => expect(media.pause).toHaveBeenCalledTimes(1));
  });

  it('左右键精确进退 5 秒并阻止页面滚动，边界与未知时长都不跑飞', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    const media = controllableMedia(video);

    media.state.currentTime = 40;
    expect(press({ key: 'ArrowRight', code: 'ArrowRight' }).defaultPrevented).toBe(true);
    expect(media.state.currentTime).toBe(45);
    expect(press({ key: 'ArrowLeft', code: 'ArrowLeft' }).defaultPrevented).toBe(true);
    expect(media.state.currentTime).toBe(40);

    // 时长未知（NaN）时快进不能把进度算成 0。
    media.state.duration = Number.NaN;
    press({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(media.state.currentTime).toBe(45);
    media.state.currentTime = 2;
    press({ key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(media.state.currentTime).toBe(0);

    media.state.duration = 100;
    media.state.currentTime = 98;
    press({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(media.state.currentTime).toBe(100);
  });

  it('上下键换集并阻止滚动，按住不连跳，锁定集不动', async () => {
    const api = installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    controllableMedia(video);

    expect(press({ key: 'ArrowDown', code: 'ArrowDown' }).defaultPrevented).toBe(true);
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    expect(api.playPrepare.mock.calls[1][0]).toMatchObject({ vid: 'v2', seriesId: 'A' });

    // 从第 2 集按「下一集」：第 3 集锁定，不能播。
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v2'),
    );
    press({ key: 'ArrowDown', code: 'ArrowDown' });
    press({ key: 'ArrowDown', code: 'ArrowDown', repeat: true });
    expect(api.playPrepare).toHaveBeenCalledTimes(2);

    expect(press({ key: 'ArrowUp', code: 'ArrowUp' }).defaultPrevented).toBe(true);
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(3));
    expect(api.playPrepare.mock.calls[2][0]).toMatchObject({ vid: 'v1' });

    // 第 1 集再按「上一集」：没有上一集。
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v1'),
    );
    press({ key: 'ArrowUp', code: 'ArrowUp' });
    expect(api.playPrepare).toHaveBeenCalledTimes(3);
  });

  it('A 切连播、S/D 调速并写回视频速率，倍速提示跟着变', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    controllableMedia(video);
    expect(screen.getByText(/连播开/)).toBeTruthy();

    press({ key: 'a', code: 'KeyA' });
    await waitFor(() => expect(screen.getByText(/连播关/)).toBeTruthy());
    press({ key: 'a', code: 'KeyA' });
    await waitFor(() => expect(screen.getByText(/连播开/)).toBeTruthy());

    expect(video.playbackRate).toBe(1);
    press({ key: 'd', code: 'KeyD' });
    await waitFor(() => expect(video.playbackRate).toBe(1.25));
    press({ key: 's', code: 'KeyS' });
    await waitFor(() => expect(video.playbackRate).toBe(1));

    // 上限 3 倍、下限 0.25 倍：越界的按键不再改变速率。
    video.playbackRate = 3;
    press({ key: 'd', code: 'KeyD' });
    expect(video.playbackRate).toBe(3);
    video.playbackRate = 0.25;
    press({ key: 's', code: 'KeyS' });
    expect(video.playbackRate).toBe(0.25);
  });

  it('F 键进全屏、再按退出', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    controllableMedia(video);
    const stage = video.parentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    let current: Element | null = null;
    const requested = vi.fn(async () => {
      current = stage;
    });
    const exited = vi.fn(async () => {
      current = null;
    });
    Object.defineProperty(stage, 'requestFullscreen', { configurable: true, value: requested });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exited });
    try {
      press({ key: 'f', code: 'KeyF' });
      await waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
      press({ key: 'f', code: 'KeyF' });
      await waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
    } finally {
      Reflect.deleteProperty(stage, 'requestFullscreen');
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
    }
  });
});

describe('让位规则（不能抢走别人的按键）', () => {
  it('输入框、下拉框、可编辑内容与菜单里的按键一律不劫持', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    const media = controllableMedia(video);

    for (const html of [
      '<input id="t" />',
      '<textarea id="t"></textarea>',
      '<select id="t"></select>',
      '<div id="t" contenteditable="true"></div>',
      '<div role="menu"><span id="t"></span></div>',
      '<div role="dialog"><span id="t"></span></div>',
      '<div role="menuitem" id="t"></div>',
    ]) {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      const target = (host.querySelector('#t') ?? host.querySelector('[role]')) as HTMLElement;
      for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 's', 'd', 'f']) {
        const event = press({ key, code: key === ' ' ? 'Space' : key }, target);
        expect(event.defaultPrevented, `${html} ${key}`).toBe(false);
      }
      host.remove();
    }
    expect(media.play).not.toHaveBeenCalled();
    expect(media.pause).not.toHaveBeenCalled();
    expect(media.state.currentTime).toBe(0);
    expect(video.playbackRate).toBe(1);
  });

  it('焦点在播放器之外的按钮上时让位，让按钮保留原生空格激活', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    const media = controllableMedia(video);

    // 5.0 的剧库页没有 4.5 的 `.player-container`，所以分集按钮（以及任何播放器外按钮）聚焦时
    // 空格不再暂停播放，而是交给浏览器激活按钮——这是与 4.5 的行为差异，报告里记为遗留。
    const episodeButton = screen.getAllByTitle('单击选中下载，双击播放')[1] as HTMLElement;
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const event = press({ key, code: key === ' ' ? 'Space' : key }, episodeButton);
      expect(event.defaultPrevented, key).toBe(false);
    }
    expect(media.play).not.toHaveBeenCalled();
    expect(media.pause).not.toHaveBeenCalled();
    expect(media.state.currentTime).toBe(0);
    expect(video.playbackRate).toBe(1);
  });

  it('带修饰键或输入法组合的按键不劫持', async () => {
    installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    const media = controllableMedia(video);

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const event = press({ key: ' ', code: 'Space', [modifier]: true });
      expect(event.defaultPrevented, modifier).toBe(false);
    }
    expect(press({ key: ' ', code: 'Space', shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: ' ', code: 'Space', isComposing: true }).defaultPrevented).toBe(false);
    // 未绑定的键（Esc、F1、字母 x）不该被吃掉。
    for (const key of ['Escape', 'F1', 'x']) expect(press({ key, code: key }).defaultPrevented).toBe(false);
    expect(media.play).not.toHaveBeenCalled();
    expect(media.pause).not.toHaveBeenCalled();
  });

  it('还没开始播放时按键完全没有副作用', async () => {
    const api = installApi();
    renderLibrary();
    fireEvent.click(await screen.findByText('测试剧'));
    await waitFor(() => expect(screen.getByText('共 3 集')).toBeTruthy());

    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'f']) {
      expect(press({ key, code: key === ' ' ? 'Space' : key }).defaultPrevented).toBe(false);
    }
    expect(api.playPrepare).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
  });
});

describe('自定义绑定', () => {
  it('改用 shift+j / shift+k 换集后，默认方向键不再换集', async () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SHORTCUTS, previous: 'shift+j', next: 'shift+k' }),
    );
    const api = installApi();
    renderLibrary();
    const video = await playFirstEpisode();
    controllableMedia(video);

    press({ key: 'ArrowDown', code: 'ArrowDown' });
    expect(api.playPrepare).toHaveBeenCalledTimes(1);

    press({ key: 'k', code: 'KeyK', shiftKey: true });
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(2));
    expect(api.playPrepare.mock.calls[1][0]).toMatchObject({ vid: 'v2' });
  });
});
