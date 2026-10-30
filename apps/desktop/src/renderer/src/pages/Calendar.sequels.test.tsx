// SPDX-License-Identifier: MIT
/**
 * 日历页的续集查找：只按用户点击查、结果只挂在自己那一行、失败与空结果分开说。
 *
 * 替代 4.5 `scripts/check-sequel-finder-ui.cjs` 里**5.0 仍有对应 UI** 的部分。5.0 没有
 * 「从查找结果直接起播」、没有本地优先再联网、没有查询看门狗/重试按钮、没有逐行收起，
 * 那半边判 obsolete：播放与失败处理改由剧库页 + `series:sequels` 通道承担
 * （装配层见 `apps/desktop/src/main/history-ipc.test.ts`，搜索编排见 SDK `search` 模块）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Calendar from './Calendar.tsx';

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const library = [
  { series_id: 'A', series_title: '春日来信', total: 12 },
  { series_id: 'B', series_title: '春日来信第二季', total: 8 },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    libraryList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: library })),
    seriesSequels: vi.fn<(seriesId: string) => Promise<Envelope>>(async () => ({
      ok: true,
      data: { results: [{ series_id: 'C', series_title: '春日来信第三季', season: 3 }] },
    })),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Calendar />
    </QueryClientProvider>,
  );
}

/** 第 index 张卡片上的「查找续集」按钮（按页面顺序，与剧库顺序一致）。 */
async function findButton(index: number): Promise<HTMLElement> {
  const buttons = await screen.findAllByRole('button', { name: '查找续集' });
  return buttons[index] as HTMLElement;
}

afterEach(() => cleanup());

describe('续集查找', () => {
  it('进页面不自动查；每部收藏都自己带一个入口', async () => {
    const api = installApi();
    renderPage();
    expect(await screen.findByText('春日来信')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '查找续集' })).toHaveLength(2);
    expect(api.seriesSequels).not.toHaveBeenCalled();
  });

  it('点谁查谁：拿到的季显示在那一行，别的行不受影响', async () => {
    const api = installApi();
    renderPage();
    fireEvent.click(await findButton(0));

    await waitFor(() => expect(api.seriesSequels).toHaveBeenCalledWith('A'));
    expect(await screen.findByText('春日来信第三季 · 第 3 季')).toBeTruthy();
    expect(await screen.findByText('找到 1 部相关季')).toBeTruthy();
    expect(api.seriesSequels).toHaveBeenCalledTimes(1);
  });

  it('换一部再查时旧结果不再显示（结果按剧归属，不串行）', async () => {
    const api = installApi({
      seriesSequels: vi.fn(async (seriesId: string) =>
        seriesId === 'A'
          ? ({
              ok: true,
              data: { results: [{ series_id: 'C', series_title: 'A 的续集', season: 3 }] },
            } as Envelope)
          : ({
              ok: true,
              data: { results: [{ series_id: 'D', series_title: 'B 的续集', season: 2 }] },
            } as Envelope),
      ),
    });
    renderPage();
    fireEvent.click(await findButton(0));
    expect(await screen.findByText('A 的续集 · 第 3 季')).toBeTruthy();

    fireEvent.click(await findButton(1));
    await waitFor(() => expect(api.seriesSequels).toHaveBeenLastCalledWith('B'));
    expect(await screen.findByText('B 的续集 · 第 2 季')).toBeTruthy();
    expect(screen.queryByText('A 的续集 · 第 3 季')).toBeNull();
  });

  it('失败说原因、不谎称「没有找到」，并且可以再点一次重试', async () => {
    let broken = true;
    const api = installApi({
      seriesSequels: vi.fn(async () => {
        if (broken) return { ok: false, error: { code: 'NETWORK', message: '网络断开' } } as Envelope;
        return {
          ok: true,
          data: { results: [{ series_id: 'C', series_title: '春日来信第三季', season: 3 }] },
        } as Envelope;
      }),
    });
    renderPage();
    fireEvent.click(await findButton(0));

    expect(await screen.findByText('查找续集失败：网络断开')).toBeTruthy();
    expect(screen.queryByText('没有找到新的季')).toBeNull();
    expect(screen.queryByText('没有发现新的季。')).toBeNull();

    broken = false;
    fireEvent.click(await findButton(0));
    expect(await screen.findByText('春日来信第三季 · 第 3 季')).toBeTruthy();
    expect(api.seriesSequels).toHaveBeenCalledTimes(2);
  });

  it('查得到 0 条时说「没有找到新的季」，与失败区分开', async () => {
    installApi({
      seriesSequels: vi.fn(async () => ({ ok: true, data: { results: [] } }) as Envelope),
    });
    renderPage();
    fireEvent.click(await findButton(0));
    expect(await screen.findByText('没有找到新的季')).toBeTruthy();
    expect(screen.getByText('没有发现新的季。')).toBeTruthy();
    expect(screen.queryByText(/查找续集失败/)).toBeNull();
  });

  it('剧库为空时给出空态，且不发续集请求', async () => {
    const api = installApi({ libraryList: vi.fn(async () => ({ ok: true, data: [] }) as Envelope) });
    renderPage();
    expect(await screen.findByText('剧库为空，先收藏几部剧再来查看上新。')).toBeTruthy();
    expect(api.seriesSequels).not.toHaveBeenCalled();
  });
});
