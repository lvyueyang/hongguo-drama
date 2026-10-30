/**
 * 自定义源的增删改（迁移自 4.5 `check-custom-media-integration.cjs` 的来源管理部分）。
 * 不变量：任何一步失败都不留半套配置；更新保留原编号；删除只删指定的那一个。
 */
import { describe, expect, it, vi } from 'vitest';
import { listCustomSources, saveCustomSource } from './custom-store.ts';

const UUID = 'a066a170-46e7-47aa-9c87-6364d8483e87';

function fakeStore(initial: Array<Record<string, unknown>> = [], options: { failSave?: boolean } = {}) {
  const settings: Record<string, any> = { root: '/downloads', custom_sources: [...initial] };
  let failures = options.failSave ? 1 : 0;
  return {
    settings,
    getSettings: () => settings,
    saveSettings: (patch: Record<string, unknown>) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('disk full');
      }
      Object.assign(settings, patch);
    },
  };
}

const draft = { name: '夹具源', url: 'https://fixture.example/api' };

describe('listCustomSources', () => {
  it('如实给出启用状态与编号，缺字段不崩', () => {
    expect(
      listCustomSources({
        custom_sources: [{ id: UUID, name: 'A', url: 'https://a.example', enabled: false }],
      }),
    ).toEqual([{ id: UUID, name: 'A', url: 'https://a.example', enabled: false }]);
    expect(listCustomSources({})).toEqual([]);
  });
});

describe('saveCustomSource', () => {
  it('新增：只给根地址时补默认 CMS 路径、生成编号、出现在清单末尾', async () => {
    const store = fakeStore();
    const result = await saveCustomSource(store, {
      source: { name: '夹具源', url: 'https://fixture.example' },
    });
    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe('https://fixture.example/api.php/provide/vod/');
    expect(result.sources[0]?.id).toMatch(/^[a-f\d-]{36}$/i);
    expect(result.sources[0]?.enabled).toBe(true);
  });

  it('更新：保留原编号（否则已下载任务的 vid 会找不到来源）', async () => {
    const store = fakeStore([{ id: UUID, name: '旧名', url: 'https://fixture.example/api', enabled: true }]);
    const result = await saveCustomSource(store, { source: { ...draft, id: UUID, name: '新名' } });
    expect(result.success).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ id: UUID, name: '新名', enabled: true });
  });

  it('同名接口地址重复添加被拒；停用/启用是同一个来源', async () => {
    const store = fakeStore([{ id: UUID, name: 'A', url: 'https://fixture.example/api', enabled: true }]);
    const duplicated = await saveCustomSource(store, { source: draft });
    expect(duplicated.success).toBe(false);
    expect(duplicated.error).toMatch(/已经添加过/);
    expect(duplicated.sources).toHaveLength(1);

    const disabled = await saveCustomSource(store, {
      source: { ...draft, id: UUID, enabled: false },
    });
    expect(disabled.success).toBe(true);
    expect(disabled.sources[0]?.enabled).toBe(false);
  });

  it('非法名称或非公网地址被拒，且清单不变', async () => {
    const store = fakeStore();
    for (const bad of [
      { name: '', url: 'https://fixture.example/api' },
      { name: '源', url: 'http://127.0.0.1/api.php' },
      { name: '源', url: 'ftp://fixture.example/api' },
      { name: 'x'.repeat(81), url: 'https://fixture.example/api' },
    ]) {
      const result = await saveCustomSource(store, { source: bad });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
    expect(store.settings.custom_sources).toEqual([]);
  });

  it('test=true 时先真连一次接口；连不上就不落盘', async () => {
    const store = fakeStore();
    const testSource = vi.fn(async () => ({ success: false, error: '取目录超时' }));
    const failed = await saveCustomSource(store, { source: draft, test: true }, { testSource });
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('取目录超时');
    expect(store.settings.custom_sources).toEqual([]);

    const ok = await saveCustomSource(
      store,
      { source: draft, test: true },
      { testSource: async () => ({ success: true }) },
    );
    expect(ok.success).toBe(true);
    expect(store.settings.custom_sources).toHaveLength(1);
  });

  it('落盘失败要回滚内存状态（界面不能显示一个重启就没了的来源）', async () => {
    const store = fakeStore([], { failSave: true });
    const result = await saveCustomSource(store, { source: draft });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/保存失败/);
    expect(store.settings.custom_sources).toEqual([]);
  });

  it('删除只删指定的那一个；不存在则如实报错', async () => {
    const other = 'b066a170-46e7-47aa-9c87-6364d8483e87';
    const store = fakeStore([
      { id: UUID, name: 'A', url: 'https://a.example/api.php/provide/vod/', enabled: true },
      { id: other, name: 'B', url: 'https://b.example/api.php/provide/vod/', enabled: true },
    ]);
    const removed = await saveCustomSource(store, { source: { id: UUID, ...draft }, remove: true });
    expect(removed.success).toBe(true);
    expect(removed.sources.map((source) => source.id)).toEqual([other]);

    const again = await saveCustomSource(store, { source: { id: UUID, ...draft }, remove: true });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/不存在/);
  });

  it('编号非法时删除/更新都被拒（不能拿一个随便的字符串当编号）', async () => {
    const store = fakeStore();
    expect((await saveCustomSource(store, { source: { ...draft, id: 'not-a-uuid' } })).success).toBe(false);
    expect((await saveCustomSource(store, { source: { id: 'nope', ...draft }, remove: true })).success).toBe(
      false,
    );
  });
});
