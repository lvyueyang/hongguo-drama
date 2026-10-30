/**
 * 来源清单与开关（迁移自 4.5 `scripts/check-media-sources.cjs`）。
 * 关键契约：红果永远在列表里且不能关闭；关闭的内置源与未启用的自定义源都不出现在清单里。
 */
import { describe, expect, it } from 'vitest';
import { getMediaSources, setBuiltinSourceEnabled } from './media-sources.ts';

const source = (id: string, name: string, enabled: boolean) => ({
  id,
  name,
  url: 'https://example.com/api.php/provide/vod/',
  enabled,
});

describe('getMediaSources', () => {
  it('默认返回三个内置源，红果排第一', () => {
    const ids = getMediaSources({} as never).map((item) => item.id);
    expect(ids).toEqual(['hongguo', 'xifan', 'hema']);
  });

  it('关闭的内置源不出现在清单里', () => {
    const ids = getMediaSources({ builtin_sources: { xifan: false } } as never).map((item) => item.id);
    expect(ids).toEqual(['hongguo', 'hema']);
  });

  it('即便设置里写了红果关闭，红果仍在清单里', () => {
    const ids = getMediaSources({ builtin_sources: { hongguo: false } } as never).map((item) => item.id);
    expect(ids).toContain('hongguo');
  });

  it('只列出启用中的自定义源，并加 custom: 前缀', () => {
    const sources = getMediaSources({
      custom_sources: [source('a'.repeat(36), '启用的源', true), source('b'.repeat(36), '停用的源', false)],
    } as never);
    const custom = sources.filter((item) => item.custom === true);
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: `custom:${'a'.repeat(36)}`, label: '启用的源' });
  });
});

describe('setBuiltinSourceEnabled', () => {
  it('红果不能被关闭', () => {
    expect(() => setBuiltinSourceEnabled({} as never, 'hongguo', false)).toThrow(/固定开启/);
  });

  it('未知来源或非法开关值被拒绝', () => {
    expect(() => setBuiltinSourceEnabled({} as never, 'unknown', true)).toThrow(/无效/);
    expect(() => setBuiltinSourceEnabled({} as never, 'xifan', 'yes' as never)).toThrow(/无效/);
  });

  it('开关写入 builtin_sources，且不破坏其他设置', () => {
    const next = setBuiltinSourceEnabled(
      { root: '/downloads', builtin_sources: { hema: true } } as never,
      'xifan',
      false,
    );
    expect(next).toMatchObject({ root: '/downloads', builtin_sources: { hema: true, xifan: false } });
  });
});

describe('getMediaSources 是纯函数', () => {
  it('不修改传入的设置对象', () => {
    const settings = {
      root: '/downloads',
      builtin_sources: { xifan: false },
      custom_sources: [source('a'.repeat(36), '源A', true)],
    };
    const snapshot = JSON.parse(JSON.stringify(settings));
    getMediaSources(settings as never);
    expect(settings).toEqual(snapshot);
  });
});
