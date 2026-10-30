import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomSourceManager } from './CustomSourceManager.tsx';

const SOURCE_ID = 'a066a170-46e7-47aa-9c87-6364d8483e87';
const sources = [
  { id: SOURCE_ID, name: '夹具源', url: 'https://fixture.example/api.php/provide/vod/', enabled: true },
  {
    id: 'b066a170-46e7-47aa-9c87-6364d8483e87',
    name: '停用源',
    url: 'https://b.example/api',
    enabled: false,
  },
];

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    // 契约信封：unwrap 只认 { ok, data }
    getSettings: vi.fn(async () => ({ ok: true, data: { custom_sources: sources } })),
    customSourceSave: vi.fn(async (request: { source: { id?: string }; remove?: boolean }) => ({
      ok: true,
      data: { success: true, sources, remove: request.remove },
    })),
    ...overrides,
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CustomSourceManager />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('自定义源管理（4.5 有、重构后缺的入口）', () => {
  it('列出全部来源（含停用的），启停状态一目了然', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('夹具源')).toBeTruthy());
    expect(screen.getByText('停用源')).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
  });

  it('新增：先测试连通再保存，成功后清空输入', async () => {
    const api = installApi();
    renderCard();
    await waitFor(() => expect(screen.getByText('夹具源')).toBeTruthy());
    // 受控输入要过 fireEvent.change，直接改 .value 不会触发 React 的 onChange
    fireEvent.change(screen.getByLabelText('来源名称'), { target: { value: '新源' } });
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://c.example/api' } });

    screen.getByText('测试并保存').click();
    await waitFor(() =>
      expect(api.customSourceSave).toHaveBeenCalledWith({
        source: { name: '新源', url: 'https://c.example/api' },
        remove: false,
        test: true,
      }),
    );
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
  });

  it('失败时显示原因且不清空输入（用户不用重打一遍）', async () => {
    const api = installApi({
      customSourceSave: vi.fn(async () => ({
        ok: true,
        data: { success: false, error: '接口测试失败：取目录超时', sources },
      })),
    });
    renderCard();
    await waitFor(() => expect(screen.getByText('夹具源')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('来源名称'), { target: { value: '新源' } });
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://c.example/api' } });

    screen.getByText('测试并保存').click();
    await waitFor(() => expect(screen.getByText(/取目录超时/)).toBeTruthy());
    expect((screen.getByLabelText('来源名称') as HTMLInputElement).value).toBe('新源');
    expect(api.customSourceSave).toHaveBeenCalledTimes(1);
  });

  it('停用/启用、删除都带编号，删除前要确认', async () => {
    const api = installApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCard();
    await waitFor(() => expect(screen.getByText('夹具源')).toBeTruthy());

    screen.getAllByText('停用')[0]?.click();
    await waitFor(() =>
      expect(api.customSourceSave).toHaveBeenCalledWith({
        source: {
          id: SOURCE_ID,
          name: '夹具源',
          url: 'https://fixture.example/api.php/provide/vod/',
          enabled: false,
        },
        remove: false,
        test: false,
      }),
    );

    screen.getAllByText('删除')[0]?.click();
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.customSourceSave).toHaveBeenCalledWith({
        source: { id: SOURCE_ID, name: '夹具源', url: 'https://fixture.example/api.php/provide/vod/' },
        remove: true,
        test: false,
      }),
    );
  });

  it('取消确认时不发删除请求', async () => {
    const api = installApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCard();
    await waitFor(() => expect(screen.getByText('夹具源')).toBeTruthy());
    screen.getAllByText('删除')[0]?.click();
    await waitFor(() => expect(screen.getAllByText('删除')[0]).toBeTruthy());
    expect(api.customSourceSave).not.toHaveBeenCalled();
  });

  it('没有来源时给出提示', async () => {
    installApi({ getSettings: vi.fn(async () => ({ ok: true, data: { custom_sources: [] } })) });
    renderCard();
    await waitFor(() => expect(screen.getByText(/还没有添加自定义源/)).toBeTruthy());
  });
});
