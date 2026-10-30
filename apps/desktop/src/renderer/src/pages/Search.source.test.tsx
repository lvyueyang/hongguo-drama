/**
 * 搜索页的来源选择与结果来源说明。
 *
 * 迁移自 `scripts/check-app-search-ipc.cjs` / `check-hongguo-search-ipc.cjs` 的**界面侧**断言：
 * 选了来源就必须按来源搜（此前 IPC 把 source 丢了，选河马仍然在搜红果官网），
 * 走了兜底线路或补搜到今日上新都要如实告诉用户。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Search from './Search.tsx';

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    browseSources: vi.fn(async () => ({
      ok: true,
      data: [
        { id: 'hongguo', label: '红果' },
        { id: 'hema', label: '河马' },
        { id: 'xifan', label: '西饭' },
      ],
    })),
    suggest: vi.fn(async () => ({ ok: true, data: [] })),
    searchWeb: vi.fn(async () => ({ ok: true, data: { results: [], channel: 'web' } })),
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
      <Search />
    </QueryClientProvider>,
  );
}

async function submit(keyword: string): Promise<void> {
  const input = screen.getByLabelText('搜索剧名') as HTMLInputElement;
  fireEvent.change(input, { target: { value: keyword } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('搜索页的来源选择生效', () => {
  it('默认搜红果，选择河马后按河马来源搜索', async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('搜索来源')).toBeTruthy());

    await submit('测试剧');
    await waitFor(() =>
      expect(api.searchWeb).toHaveBeenCalledWith({ keyword: '测试剧', page: 1, source: 'hongguo' }),
    );

    fireEvent.change(screen.getByLabelText('搜索来源'), { target: { value: 'hema' } });
    await waitFor(() =>
      expect(api.searchWeb).toHaveBeenLastCalledWith({ keyword: '测试剧', page: 1, source: 'hema' }),
    );
  });

  it('走了 App 线路 / 补搜到今日上新时说清楚结果来自哪里', async () => {
    installApi({
      searchWeb: vi.fn(async () => ({
        ok: true,
        data: {
          results: [{ series_id: '1', series_title: '当天新剧' }],
          channel: 'app',
          meta: { newRelease: 2, newReleaseChecked: true },
        },
      })),
    });
    renderPage();
    await submit('当天新剧');
    await waitFor(() => expect(screen.getByText(/来自 App 搜索/)).toBeTruthy());
    expect(screen.getByText(/含 2 部今日上新/)).toBeTruthy();
  });

  it('官网 5xx 后用 App 兜底：既说明原因，也说明改用了哪条线路', async () => {
    installApi({
      searchWeb: vi.fn(async () => ({
        ok: true,
        data: {
          results: [{ series_id: '1', series_title: '接班' }],
          channel: 'app',
          partial: true,
          apiError: '搜索服务暂不可用（HTTP 503）',
        },
      })),
    });
    renderPage();
    await submit('接班');
    await waitFor(() => expect(screen.getByText(/官网暂不可用.*已改用 App/)).toBeTruthy());
  });

  it('没有结果时给出空态，而不是空白页', async () => {
    installApi();
    renderPage();
    await submit('没有这部剧');
    await waitFor(() => expect(screen.getByText('没有匹配的剧集。')).toBeTruthy());
  });
});
