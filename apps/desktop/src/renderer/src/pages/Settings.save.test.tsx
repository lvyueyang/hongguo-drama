/**
 * 设置页「只在保存成功后生效」的等价用例（迁自 `scripts/check-player-review-2-5.cjs` 的设置部分）。
 *
 * 4.5 断言的是 `compat_mode` / `auto_delete_watched` 两个开关：草稿不落盘、保存中禁用整个
 * fieldset、失败保留草稿并说明原因。5.0 没有这两个开关（`Settings.tsx` 只暴露下载目录、
 * 代理、存储、更新等），但同一套提交语义必须成立，因此这里用「下载目录」这条真实设置来验。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings.tsx';

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    appInfo: vi.fn(async () => ({ ok: true, data: { name: '红果短剧', version: '5.0.0' } })),
    capabilities: vi.fn(async () => ({ ok: true, data: { accountAffectsPlayback: false } })),
    getSettings: vi.fn(async () => ({ ok: true, data: { root: '/fixture' } })),
    saveSettings: vi.fn(async () => ({ ok: true, data: {} })),
    announcementGet: vi.fn(async () => ({ ok: true, data: {} })),
    storageUsage: vi.fn(async () => ({ ok: true, data: { root: '/fixture', totalFiles: 0, totalBytes: 0 } })),
    updateState: vi.fn(async () => ({ ok: true, data: { status: 'idle' } })),
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
      <Settings />
    </QueryClientProvider>,
  );
}

async function rootInput(value: string): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText('下载目录')) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe(value));
  return input;
}

const saveButton = (): HTMLButtonElement => screen.getAllByText('保存')[0] as HTMLButtonElement;

afterEach(() => cleanup());

describe('设置保存语义', () => {
  it('编辑只是草稿：点保存才提交，成功后给出已保存提示', async () => {
    const api = installApi();
    renderPage();
    const input = await rootInput('/fixture');

    fireEvent.change(input, { target: { value: '/downloads/new' } });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(input.value).toBe('/downloads/new');

    fireEvent.click(saveButton());
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ root: '/downloads/new' }));
    await screen.findByText('已保存');
  });

  it('保存失败：说明原因、保留草稿、可以再试一次', async () => {
    let broken = true;
    const api = installApi({
      saveSettings: vi.fn(async () => {
        if (broken) return { ok: false, error: { code: 'IO', message: '设置写入失败' } };
        return { ok: true, data: {} };
      }),
    });
    renderPage();
    const input = await rootInput('/fixture');
    fireEvent.change(input, { target: { value: '/downloads/new' } });

    fireEvent.click(saveButton());
    await screen.findByText('保存失败：设置写入失败');
    expect(input.value).toBe('/downloads/new');

    broken = false;
    fireEvent.click(saveButton());
    await screen.findByText('已保存');
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('保存请求在手时按钮禁用，避免重复提交', async () => {
    let finish: (() => void) | undefined;
    installApi({
      saveSettings: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ok: true, data: {} });
          }),
      ),
    });
    renderPage();
    const input = await rootInput('/fixture');
    fireEvent.change(input, { target: { value: '/downloads/new' } });

    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    finish?.();
    await screen.findByText('已保存');
  });
});
