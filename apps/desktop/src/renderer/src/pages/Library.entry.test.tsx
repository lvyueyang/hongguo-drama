/**
 * 剧库页的「等待用户意图」语义与下载/导出入口。
 *
 * 替代 4.5 `scripts/check-player-library.cjs` 中仍存活的部分：打开剧库与进入剧集详情**不许**
 * 取流或挂媒体（只有显式播放才取）、锁定分集不进下载队列、下载/导出按钮的参数。
 * 4.5 的 `播放本集` / `下载本集` / `下载后5集` / `合并导出全集` / `切换剧集` 面板在 5.0 改由
 * 分集网格 + 下载管理器承担（下载范围与自动删除见 `DownloadManager.test.tsx`），这里只锁 5.0 侧。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from './Library.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type PlayRequest = { vid: string; seriesId: string; quality: string };
type EnqueueRequest = { seriesId: string; seriesTitle: string; vids: string[]; quality: string };
type ExportRequest = {
  seriesId: string;
  seriesTitle: string;
  kinds: { danmaku: boolean; comments: boolean; reviews: boolean };
};

const episodes = [
  { vid: 'v1', vid_index: 1 },
  { vid: 'v2', vid_index: 2, locked: true },
  { vid: 'v3', vid_index: 3 },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    libraryList: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: [{ series_id: 'A', series_title: '测试剧' }],
      }),
    ),
    seriesEpisodes: vi.fn<(seriesId: string) => Promise<Envelope>>(async () => ({
      ok: true,
      data: { series_id: 'A', series_title: '测试剧', total: 3, episodes },
    })),
    playPrepare: vi.fn<(request: PlayRequest) => Promise<Envelope>>(async (request) => ({
      ok: true,
      data: { url: `hongguo-stream://play/${request.vid}`, sessionId: request.vid },
    })),
    progressGet: vi.fn<(request: { seriesId: string }) => Promise<Envelope>>(async () => ({
      ok: true,
      data: null,
    })),
    progressSave: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    danmakuList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { items: [], notice: '' } })),
    playPrefetch: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: { status: 'prefetched' } })),
    downloadEnqueue: vi.fn<(request: EnqueueRequest) => Promise<Envelope>>(async () => ({
      ok: true,
      data: [{ id: 't1' }, { id: 't2' }],
    })),
    exportText: vi.fn<(request: ExportRequest) => Promise<Envelope>>(async () => ({
      ok: true,
      data: {
        files: ['/tmp/剧A-弹幕.json'],
        danmaku: { items: 3, fail: 0 },
        comments: { items: 1, fail: 0 },
        reviews: { items: 0, fail: 1 },
      },
    })),
    libraryRemove: vi.fn<(seriesId: string) => Promise<Envelope>>(async () => ({
      ok: true,
      data: { removed: true },
    })),
    on: vi.fn(() => () => {}),
    ...overrides,
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

async function openSeries() {
  fireEvent.click(await screen.findByText('测试剧'));
  await waitFor(() => expect(screen.getByText('共 3 集')).toBeTruthy());
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('只等用户意图，不主动播放', () => {
  it('打开剧库、进详情都不取流、不挂媒体', async () => {
    const api = installApi();
    renderLibrary();
    await waitFor(() => expect(api.libraryList).toHaveBeenCalledTimes(1));
    await openSeries();

    await waitFor(() => expect(api.seriesEpisodes).toHaveBeenCalledWith('A'));
    expect(api.playPrepare).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('source')).toBeNull();
  });

  it('双击可播分集才取流，参数是这一集的 vid 与所属剧', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    await act(async () => {
      fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[0] as HTMLElement);
    });
    await waitFor(() => expect(api.playPrepare).toHaveBeenCalledTimes(1));
    // 第一次播放不带 force（缓存可复用）
    expect(api.playPrepare.mock.calls[0][0]).toEqual({
      vid: 'v1',
      seriesId: 'A',
      quality: 'auto',
      force: false,
    });
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('hongguo-stream://play/v1'),
    );
  });

  it('锁定分集双击不播', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    const locked = screen.getByTitle('该集未开放');
    expect(locked.textContent).toContain('锁定');
    fireEvent.doubleClick(locked);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.playPrepare).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
  });

  it('取流失败时给出原因，不留下半截播放器', async () => {
    const api = installApi({
      playPrepare: vi.fn(
        async (): Promise<Envelope> => ({
          ok: false,
          error: { code: 'SOURCE_UNAVAILABLE', message: '该来源暂时不可用' },
        }),
      ),
    });
    renderLibrary();
    await openSeries();

    await act(async () => {
      fireEvent.doubleClick(screen.getAllByTitle('单击选中下载，双击播放')[0] as HTMLElement);
    });
    await waitFor(() => expect(screen.getByText('播放失败：该来源暂时不可用')).toBeTruthy());
    expect(document.querySelector('video')).toBeNull();
    expect(api.playPrefetch).not.toHaveBeenCalled();
  });
});

describe('下载与导出入口', () => {
  it('「全选可播」只选未锁定分集，提交时带上 vid 与剧名', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    fireEvent.click(screen.getByRole('button', { name: '全选可播' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /下载所选（2）/ })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /下载所选（2）/ }));
    });
    await waitFor(() => expect(api.downloadEnqueue).toHaveBeenCalledTimes(1));
    expect(api.downloadEnqueue.mock.calls[0][0]).toEqual({
      seriesId: 'A',
      seriesTitle: '测试剧',
      vids: ['v1', 'v3'],
      quality: 'auto',
    });
    await waitFor(() => expect(screen.getByText('已加入下载队列 2 集')).toBeTruthy());
    // 提交后清空选择，避免重复入队。
    expect(screen.getByRole('button', { name: /下载所选（0）/ }).hasAttribute('disabled')).toBe(true);
  });

  it('没选分集时提交按钮禁用，点了也不发请求', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    const submit = screen.getByRole('button', { name: /下载所选（0）/ });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.downloadEnqueue).not.toHaveBeenCalled();
  });

  it('单击分集只切换选中，不播放', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    const [first] = screen.getAllByTitle('单击选中下载，双击播放');
    fireEvent.click(first as HTMLElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /下载所选（1）/ })).toBeTruthy());
    expect(api.playPrepare).not.toHaveBeenCalled();

    fireEvent.click(first as HTMLElement);
    await waitFor(() => expect(screen.getByRole('button', { name: /下载所选（0）/ })).toBeTruthy());
  });

  it('导出文字带上三种类型，提示里说明条数、文件数与失败项', async () => {
    const api = installApi();
    renderLibrary();
    await openSeries();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导出文字' }));
    });
    await waitFor(() => expect(api.exportText).toHaveBeenCalledTimes(1));
    expect(api.exportText.mock.calls[0][0]).toEqual({
      seriesId: 'A',
      seriesTitle: '测试剧',
      kinds: { danmaku: true, comments: true, reviews: true },
    });
    await waitFor(() => expect(screen.getByText('已导出 4 条文字，1 个文件，1 项失败')).toBeTruthy());
  });
});

describe('剧库列表', () => {
  it('移出剧库带上剧 id 并刷新列表', async () => {
    let list = [
      { series_id: 'A', series_title: '测试剧' },
      { series_id: 'B', series_title: '另一部' },
    ];
    const api = installApi({
      libraryList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: list })),
      libraryRemove: vi.fn(async (): Promise<Envelope> => {
        list = list.filter((item) => item.series_id !== 'A');
        return { ok: true, data: { removed: true } };
      }),
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('另一部')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '移出剧库' })[0] as HTMLElement);
    });
    await waitFor(() => expect(api.libraryRemove).toHaveBeenCalledWith('A'));
    await waitFor(() => expect(screen.queryByText('测试剧')).toBeNull());
    expect(screen.getByText('另一部')).toBeTruthy();
    expect(api.playPrepare).not.toHaveBeenCalled();
  });

  it('空剧库给出下一步提示', async () => {
    installApi({ libraryList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: [] })) });
    renderLibrary();
    await waitFor(() =>
      expect(screen.getByText(/剧库是空的。先在「搜索与下载」里搜索并打开一部剧/)).toBeTruthy(),
    );
  });

  it('剧库读取失败时显示原因', async () => {
    installApi({
      libraryList: vi.fn(
        async (): Promise<Envelope> => ({
          ok: false,
          error: { code: 'STORAGE_UNAVAILABLE', message: '存储目录不可写' },
        }),
      ),
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('剧库读取失败：存储目录不可写')).toBeTruthy());
  });
});
