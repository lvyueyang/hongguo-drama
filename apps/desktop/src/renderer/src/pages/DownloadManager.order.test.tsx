// SPDX-License-Identifier: MIT
/**
 * 下载列表的分集顺序（迁自 4.5 `scripts/check-merge-optimization.cjs` 的排序断言）。
 *
 * 4.5 的下载管理器自己按「状态 → 结束时间 → 集号」排序，于是要专门验证「同一剧的分集在
 * 完成事件后仍按自然顺序」。5.0 不在渲染层排序，顺序等于主进程队列的顺序
 * （`apps/desktop/src/main/queue.ts` 按入队顺序保存），所以存活的不变量更简单：
 * 页面**不许自己重排**，不同状态并存时也保持队列给的分集顺序。
 */
import { Events } from '@hongguo/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DownloadManager from './DownloadManager.tsx';

type Listener = (payload: unknown) => void;
type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const listeners: Record<string, Listener> = {};

function task(vid: string, status: string, index: number) {
  return {
    id: `A-${vid}`,
    vid,
    seriesId: 'A',
    seriesTitle: '测试剧',
    savePath: `/tmp/测试剧-第${vid}集.mp4`,
    status,
    progress: status === 'completed' ? 100 : 40,
    receivedBytes: 512,
    totalBytes: 1024,
    error: '',
    // 4.5 的排序键：完成顺序与集号顺序相反，好暴露「按状态重排」
    endTime: 1000 - index * 100,
  };
}

function installApi(tasks: () => unknown[], overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(listeners)) delete listeners[key];
  const api = {
    downloadList: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: tasks() })),
    downloadPause: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    downloadResume: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    downloadRemove: vi.fn(async (): Promise<Envelope> => ({ ok: true, data: {} })),
    on: vi.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
      return () => {
        delete listeners[event];
      };
    }),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DownloadManager />
    </QueryClientProvider>,
  );
}

/** 页面上每个任务卡片的标题（顺序即渲染顺序）。 */
async function renderedOrder(): Promise<string[]> {
  const titles = await screen.findAllByText(/· 第 \d+ 集/);
  return titles.map((node) => node.textContent ?? '');
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('下载列表顺序', () => {
  it('不同状态并存时按队列给的分集顺序，不按状态或完成时间重排', async () => {
    installApi(() => [
      task('3', 'completed', 0),
      task('1', 'downloading', 1),
      task('2', 'failed', 2),
      task('4', 'pending', 3),
    ]);
    renderPage();
    expect(await renderedOrder()).toEqual([
      '测试剧 · 第 3 集',
      '测试剧 · 第 1 集',
      '测试剧 · 第 2 集',
      '测试剧 · 第 4 集',
    ]);
  });

  it('进度事件刷新列表后顺序仍然稳定', async () => {
    let rows = [task('1', 'downloading', 0), task('2', 'pending', 1), task('3', 'pending', 2)];
    installApi(() => rows);
    renderPage();
    expect(await renderedOrder()).toEqual(['测试剧 · 第 1 集', '测试剧 · 第 2 集', '测试剧 · 第 3 集']);

    // 第 1 集完成、第 2 集开始下载：状态变化不能让 2 跑到 1 前面
    rows = [task('1', 'completed', 0), task('2', 'downloading', 1), task('3', 'pending', 2)];
    listeners[Events.downloadProgress]?.({ taskId: 'A-1', percent: 100 });
    await waitFor(async () =>
      expect(await renderedOrder()).toEqual(['测试剧 · 第 1 集', '测试剧 · 第 2 集', '测试剧 · 第 3 集']),
    );
    expect(screen.getByText('已完成')).toBeTruthy();
  });
});
