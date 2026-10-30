// SPDX-License-Identifier: MIT
/**
 * 观看记录页：列表范围与后台续作刷新。
 *
 * 替代 4.5 `scripts/check-watch-history.cjs` 与 `check-watch-history-display.cjs` 里
 * **5.0 仍有对应 UI** 的部分：范围切换要重新按 scope 取数、切换期间不许把已有列表清空
 * （`placeholderData`）、空态与错误要说清、批量检测走 `history:refresh` 且失败要如实报告。
 * 4.5 的其余渲染层行为（续作红点、行内续作播放、`searchResolve` 兜底、逐行检测、
 * 低季隐藏、已看完计数、逐行移出、旧响应覆盖新列表）在 5.0 没有对应 UI，见迁移报告。
 *
 * 分季与续作的算法不变量在 `packages/sdk/src/services/history/watch-history.legacy-parity.test.ts`，
 * scope 在装配层的透传在 `apps/desktop/src/main/history-ipc.test.ts`。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import History from './History.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
type Scope = 'all' | 'latest' | 'unfinished';

const rows = [
  {
    series_id: 'A',
    series_title: '春日来信',
    vid_index: 3,
    total: 10,
    currentTime: 30,
    duration: 100,
    updatedAt: 2,
  },
  {
    series_id: 'B',
    series_title: '春日来信第二季',
    vid_index: 1,
    total: 4,
    currentTime: 5,
    updatedAt: 1,
  },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    historyList: vi.fn<(request: { scope: Scope }) => Promise<Envelope>>(async () => ({
      ok: true,
      data: rows,
    })),
    historyRefresh: vi.fn(
      async (): Promise<Envelope> => ({
        ok: true,
        data: { checked: 2, failed: 0 },
      }),
    ),
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
      <History />
    </QueryClientProvider>,
  );
}

const scopeButton = (label: string): HTMLElement =>
  screen.getByRole('button', { name: label }) as HTMLElement;

afterEach(() => cleanup());

describe('列表范围', () => {
  it('默认按「全部」取一次；切范围带新 scope 重新取数', async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(api.historyList).toHaveBeenCalledWith({ scope: 'all' }));
    await screen.findByText('春日来信');

    fireEvent.click(scopeButton('未看完'));
    await waitFor(() => expect(api.historyList).toHaveBeenCalledWith({ scope: 'unfinished' }));

    fireEvent.click(scopeButton('每剧最近'));
    await waitFor(() => expect(api.historyList).toHaveBeenCalledWith({ scope: 'latest' }));
    expect(api.historyList).toHaveBeenCalledTimes(3);
  });

  it('新范围的请求还没回来时保留上一份列表，不闪空', async () => {
    let release: (() => void) | undefined;
    const api = installApi({
      historyList: vi.fn((request: { scope: Scope }) => {
        if (request.scope !== 'all') {
          return new Promise<Envelope>((resolve) => {
            release = () => resolve({ ok: true, data: rows.slice(1) });
          });
        }
        return Promise.resolve({ ok: true, data: rows } as Envelope);
      }),
    });
    renderPage();
    await screen.findByText('春日来信');

    fireEvent.click(scopeButton('未看完'));
    // 挂起期间：旧行仍在，空态文案不许出现
    await waitFor(() => expect(scopeButton('未看完')).toBeTruthy());
    expect(screen.getByText('春日来信')).toBeTruthy();
    expect(screen.queryByText('还没有观看记录。')).toBeNull();

    release?.();
    await waitFor(() => expect(screen.queryByText('春日来信')).toBeNull());
    expect(screen.getByText('春日来信第二季')).toBeTruthy();
    expect(api.historyList).toHaveBeenCalledTimes(2);
  });

  it('列表带出集数与已看的秒数', async () => {
    installApi();
    renderPage();
    expect(await screen.findByText('看到第 3 集 · 30s / 100s')).toBeTruthy();
    // 没有时长信息时只说集数，不编造 0s / 0s
    expect(screen.getByText('看到第 1 集')).toBeTruthy();
  });

  it('取数成功但没有记录时给出空态', async () => {
    installApi({ historyList: vi.fn(async () => ({ ok: true, data: [] }) as Envelope) });
    renderPage();
    expect(await screen.findByText('还没有观看记录。')).toBeTruthy();
  });

  it('取数失败要说明原因', async () => {
    installApi({
      historyList: vi.fn(
        async () => ({ ok: false, error: { code: 'IO', message: '记录文件损坏' } }) as Envelope,
      ),
    });
    renderPage();
    expect(await screen.findByText('观看记录加载失败：记录文件损坏')).toBeTruthy();
  });

  // 已知缺陷（只报不改）：History.tsx 的空态判断只看 `!isPending && !rows.length`，
  // 失败时 rows 同样是空，于是「观看记录加载失败」和「还没有观看记录。」同时出现——
  // 正是 4.5 显式禁止的「把失败说成没有记录」。修好后这条会变红，届时删掉本用例。
  it('取数失败时不应该同时说「还没有观看记录。」', async () => {
    installApi({
      historyList: vi.fn(
        async () => ({ ok: false, error: { code: 'IO', message: '记录文件损坏' } }) as Envelope,
      ),
    });
    renderPage();
    await screen.findByText('观看记录加载失败：记录文件损坏');
    expect(screen.queryByText('还没有观看记录。')).toBeNull();
  });
});

describe('后台续作刷新', () => {
  it('部分失败时如实说明，并重新拉一次列表', async () => {
    const api = installApi({
      historyRefresh: vi.fn(async () => ({ ok: true, data: { checked: 3, failed: 1 } }) as Envelope),
    });
    renderPage();
    await screen.findByText('春日来信');

    fireEvent.click(scopeButton('检查续作'));
    expect(await screen.findByText('已检查 3 部，其中 1 部未完成，稍后会再试')).toBeTruthy();
    await waitFor(() => expect(api.historyList).toHaveBeenCalledTimes(2));
    // 全量检查不带 seriesId（契约里是可选参数，空对象即全量）
    expect(api.historyRefresh).toHaveBeenCalledWith({});
  });

  it('全部成功时不提未完成', async () => {
    installApi({
      historyRefresh: vi.fn(async () => ({ ok: true, data: { checked: 2, failed: 0 } }) as Envelope),
    });
    renderPage();
    await screen.findByText('春日来信');
    fireEvent.click(scopeButton('检查续作'));
    expect(await screen.findByText('已检查 2 部')).toBeTruthy();
  });

  it('刷新请求失败时说明原因，且不假装刷新成功去重取列表', async () => {
    const api = installApi({
      historyRefresh: vi.fn(
        async () => ({ ok: false, error: { code: 'NETWORK', message: '搜索超时' } }) as Envelope,
      ),
    });
    renderPage();
    await screen.findByText('春日来信');

    fireEvent.click(scopeButton('检查续作'));
    expect(await screen.findByText('刷新失败：搜索超时')).toBeTruthy();
    expect(api.historyList).toHaveBeenCalledTimes(1);
  });

  it('刷新在飞时按钮禁用，避免重复发起', async () => {
    let release: (() => void) | undefined;
    installApi({
      historyRefresh: vi.fn(
        () =>
          new Promise<Envelope>((resolve) => {
            release = () => resolve({ ok: true, data: { checked: 1, failed: 0 } });
          }),
      ),
    });
    renderPage();
    await screen.findByText('春日来信');

    fireEvent.click(scopeButton('检查续作'));
    const pending = await screen.findByText('检查续作…');
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    release?.();
    expect(await screen.findByText('已检查 1 部')).toBeTruthy();
  });
});
