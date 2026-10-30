/**
 * 剧库页的倍速快捷键等价用例（迁自 `scripts/check-playback-speed.cjs` 的倍速部分）。
 *
 * 5.0 的播放控件是原生 `<video controls>`，没有独立的倍速控件与 in-video 提示，
 * 因此这里只验还存活的不变量：步进 0.25、范围收敛在 0.25–3、界面显示的倍速与
 * 实际播放倍速一致、修饰键/输入法/编辑控件会让位。
 * 倍速跨集保留与「媒体改倍速反向同步控件」在 5.0 已无对应实现，见迁移报告。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

const EPISODES = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2 },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    libraryList: vi.fn(async () => ({ ok: true, data: [{ series_id: 'A', series_title: '剧A' }] })),
    seriesEpisodes: vi.fn(async () => ({
      ok: true,
      data: { series_id: 'A', series_title: '剧A', episodes: EPISODES },
    })),
    playPrepare: vi.fn(async ({ vid }: { vid: string }) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${vid}`, sessionId: vid },
    })),
    progressGet: vi.fn(async () => ({ ok: true, data: null })),
    progressSave: vi.fn(async () => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async () => ({ ok: true, data: { items: [] } })),
    playPrefetch: vi.fn(async () => ({ ok: true, data: { target: 'v2', status: 'prefetched' } })),
    getSettings: vi.fn(async () => ({ ok: true, data: {} })),
    on: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Library />
    </QueryClientProvider>,
  );
}

async function playFirstEpisode(): Promise<HTMLVideoElement> {
  renderPage();
  fireEvent.click(await screen.findByText('剧A'));
  fireEvent.doubleClick(
    (await screen.findByText('1', { selector: 'span.font-medium' })).closest('button') as HTMLElement,
  );
  await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
  return document.querySelector('video') as HTMLVideoElement;
}

const press = (
  key: string,
  init: Record<string, unknown> = {},
  target?: Element | Document | Window,
): void => {
  fireEvent.keyDown(target ?? window, {
    key,
    code: `Key${key.toUpperCase()}`,
    ...init,
  });
};

beforeEach(() => {
  installApi();
});

afterEach(() => cleanup());

describe('播放倍速快捷键', () => {
  it('按 0.25 步进调速，界面显示与实际倍速一致', async () => {
    await playFirstEpisode();
    press('d');
    await waitFor(() => expect(screen.getByText(/倍速 1\.25×/)).toBeTruthy());
    press('s');
    await waitFor(() => expect(screen.getByText(/倍速 1×/)).toBeTruthy());
  });

  it('上下限收敛在 0.25 与 3 之间', async () => {
    const video = await playFirstEpisode();
    for (let index = 0; index < 40; index++) press('d');
    await waitFor(() => expect(video.playbackRate).toBe(3));
    expect(screen.getByText(/倍速 3×/)).toBeTruthy();

    for (let index = 0; index < 40; index++) press('s');
    await waitFor(() => expect(video.playbackRate).toBe(0.25));
    expect(screen.getByText(/倍速 0\.25×/)).toBeTruthy();
  });

  it('修饰键、输入法组合与编辑控件吞掉调速快捷键', async () => {
    const video = await playFirstEpisode();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'isComposing']) {
      press('d', { [modifier]: true });
      expect(video.playbackRate, modifier).toBe(1);
    }

    const input = document.createElement('input');
    document.body.appendChild(input);
    press('d', {}, input);
    expect(video.playbackRate).toBe(1);

    // 播放器之外的按钮（例如「全选可播」）保留原生键盘行为
    press('d', {}, screen.getByText('全选可播'));
    expect(video.playbackRate).toBe(1);
  });

  it('没开始播放时按下调速键不生效也不报错', async () => {
    const api = installApi();
    renderPage();
    fireEvent.click(await screen.findByText('剧A'));
    await screen.findByText('共 2 集');
    press('d');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.playPrepare).not.toHaveBeenCalled();
    expect(screen.queryByText(/倍速 1\.25×/)).toBeNull();
  });
});

describe('倍速跨集保留（4.5 check-playback-speed 的不变量）', () => {
  it('换集后新元素的倍速仍是用户选的那一档', async () => {
    installApi();
    const video = await playFirstEpisode();
    // 换集前把倍速调到 1.5×
    press('d');
    press('d');
    await waitFor(() => expect(video.playbackRate).toBe(1.5));
    expect(screen.getByText(/倍速 1\.5×/)).toBeTruthy();

    // 双击第 2 集换集：新 video 元素必须继承倍速，否则界面写着 1.5× 实际 1×
    fireEvent.doubleClick(
      (await screen.findByText('2', { selector: 'span.font-medium' })).closest('button') as HTMLElement,
    );
    await waitFor(() => {
      const next = document.querySelector('video') as HTMLVideoElement;
      expect(next.getAttribute('src')).toContain('/v2');
    });
    const next = document.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedMetadata(next);
    expect(next.playbackRate).toBe(1.5);
    expect(screen.getByText(/倍速 1\.5×/)).toBeTruthy();
  });
});
