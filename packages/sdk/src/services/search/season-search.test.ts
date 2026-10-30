/**
 * 有界来源搜索 + 严格续集身份（迁移自 4.5 `scripts/check-series-search.cjs`）。
 *
 * 与 `series-search.test.ts` 的分工：那一份只压「最多补搜几次」的上限，
 * 这一份压**具体补搜了哪些词、顺序如何、缺的是哪一季**——旧检查靠这三件事
 * 防止把来源打爆（递归展开）与把别家剧当续集。
 */
import { describe, expect, it, vi } from 'vitest';
import { findSequels } from '../history/watch-history.ts';
import { findSeriesSequels, searchSeries } from './series-search.ts';

const hit = (series_id: string, series_title: string, extra: Record<string, unknown> = {}) => ({
  series_id,
  series_title,
  ...extra,
});
const ok = (results: unknown[]) => ({ success: true, results });
const ids = (rows: Array<{ series_id: string }>) => rows.map((row) => row.series_id);

const first = hit('1000001', '双子房客');
const second = hit('1000002', '双子房客第二季');
const third = hit('1000003', '双子房客第三季');
const fourth = hit('1000004', '双子房客第四季');

describe('searchSeries：补搜的词与顺序', () => {
  it('短剧名只补「缺的那一季」，汉字与数字季各试一次', async () => {
    const calls: string[] = [];
    const result = await searchSeries('双子房客', (async (kw: string) => {
      calls.push(kw);
      if (kw === '双子房客') return ok([first, second]);
      return ok(kw === '双子房客第三季' ? [third] : [third, fourth]);
    }) as never);
    expect(calls).toEqual(['双子房客', '双子房客第三季', '双子房客第3季']);
    expect(ids(result.results)).toEqual(['1000001', '1000002', '1000003', '1000004']);
  });

  it('主搜已带回同族剧集时不额外补搜（不能递归展开）', async () => {
    const calls: string[] = [];
    await searchSeries('双子房客', (async (kw: string) => {
      calls.push(kw);
      return ok([{ series_id: '1999999', series_title: '另一部剧' }]);
    }) as never);
    expect(calls).toEqual(['双子房客']);
  });

  it('显式季数：整名命中就不再补搜', async () => {
    const calls: string[] = [];
    await searchSeries('双子房客第三季', (async (kw: string) => {
      calls.push(kw);
      return ok([second, third]);
    }) as never);
    expect(calls).toEqual(['双子房客第三季']);
  });

  it('显式季数缺失时回退基名一次，精确季仍排第一', async () => {
    const calls: string[] = [];
    const result = await searchSeries('双子房客第三季', (async (kw: string) => {
      calls.push(kw);
      return ok(kw === '双子房客第三季' ? [second] : [first, third]);
    }) as never);
    expect(calls).toEqual(['双子房客第三季', '双子房客']);
    expect(result.results[0].series_id).toBe('1000003');
  });

  it('非连续季补的是「缺的那一季」，不是当前最大季+1', async () => {
    const calls: string[] = [];
    const result = await searchSeries('双子房客', (async (kw: string) => {
      calls.push(kw);
      return ok(kw === '双子房客' ? [first, third] : [second]);
    }) as never);
    expect(calls).toEqual(['双子房客', '双子房客第二季', '双子房客第2季']);
    expect(ids(result.results)).toContain('1000002');
  });

  it('补搜失败保留主搜结果，并如实标记 partial', async () => {
    const result = await searchSeries('双子房客', (async (kw: string) =>
      kw === '双子房客' ? ok([first, second]) : Promise.reject(new Error('offline'))) as never);
    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(ids(result.results)).toEqual(['1000001', '1000002']);
    expect(result.error).toMatch(/补充搜索/);
  });

  it('总预算用尽时跳过补搜，但主搜结果照旧可用', async () => {
    const calls: string[] = [];
    const result = await searchSeries(
      '双子房客',
      (async (kw: string) => {
        calls.push(kw);
        return ok([first]);
      }) as never,
      [],
      { deadline: Date.now() - 1 },
    );
    expect(calls).toEqual(['双子房客']);
    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.error).toMatch(/时间预算/);
  });

  it('空关键词与超长关键词都不发请求', async () => {
    const search = vi.fn();
    await expect(searchSeries('   ', search as never)).resolves.toMatchObject({ success: false });
    await expect(searchSeries('红'.repeat(201), search as never)).resolves.toMatchObject({
      success: false,
    });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('searchSeries：结果排序与去重', () => {
  it('精确 > 包含 > 无关，同编号只留一条（跨来源各自保留）', async () => {
    const result = await searchSeries('双子房客', (async () => ({
      success: true,
      results: [
        hit('2999999', '无关剧名'),
        hit('1000003', '双子房客第三季'),
        hit('1000001', '双子房客'),
        hit('1000001', '双子房客'),
        hit('hema:7', '双子房客', { source: 'hema' }),
      ],
    })) as never);
    expect(result.results.map((row: any) => [row.series_id, row.series_title])).toEqual([
      ['1000001', '双子房客'],
      ['hema:7', '双子房客'],
      ['1000003', '双子房客第三季'],
      ['2999999', '无关剧名'],
    ]);
  });
});

describe('findSeriesSequels：续集身份必须同源、同基名、季数更高', () => {
  it('别家来源、番外、重复与更低季一律不算续集，结果按季升序', () => {
    const sequelIds = ids(
      findSequels(first, [
        fourth,
        hit('hema:7', '双子房客第三季'),
        third,
        second,
        second,
        hit('1999999', '双子房客番外'),
      ]),
    );
    expect(sequelIds).toEqual(['1000002', '1000003', '1000004']);
  });

  it('已从剧库移出（dismissed）的剧集仍然算续集：界面状态不能影响身份判断', () => {
    const sequelIds = ids(findSequels(first, [{ ...second, dismissed: true }]));
    expect(sequelIds).toEqual(['1000002']);
  });

  it('括号里的年份仍算剧名的一部分', async () => {
    const original = { ...first, series_title: '年轮（2024）' };
    const sequel = { ...second, series_title: '年轮（2024）第二季' };
    expect(ids(findSequels(original, [sequel]))).toEqual(['1000002']);
    const local = await findSeriesSequels(
      original,
      [sequel],
      (async () => {
        throw new Error('localOnly 不得联网');
      }) as never,
      { localOnly: true },
    );
    expect(local.success).toBe(true);
    expect(ids(local.results)).toEqual(['1000002']);
  });

  it('离谱季数视为无法识别，不参与匹配也不发请求', async () => {
    const calls: string[] = [];
    for (const series of [
      { ...first, series_title: '' },
      { ...first, series_title: '第三季' },
      { ...first, series_title: '双子房客第999999999999999999999季' },
      { series_id: 'unknown:1', series_title: '双子房客' },
    ]) {
      const result = await findSeriesSequels(series as never, [], (async (kw: string) => {
        calls.push(kw);
        return ok([]);
      }) as never);
      expect(result.success, JSON.stringify(series)).toBe(false);
      expect(result.error).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });

  it('localOnly 完全不发请求；远端失败时保留本机候选并标记 partial', async () => {
    let calls = 0;
    const search = (async () => {
      calls += 1;
      throw new Error('offline');
    }) as never;
    const local = await findSeriesSequels(first, [fourth, second], search, { localOnly: true });
    expect(calls).toBe(0);
    expect(ids(local.results)).toEqual(['1000002', '1000004']);
    const remote = await findSeriesSequels(first, [fourth, second], search);
    expect(calls).toBeGreaterThan(0);
    expect(remote.success).toBe(true);
    expect((remote as { partial?: boolean }).partial).toBe(true);
    expect(ids(remote.results)).toEqual(['1000002', '1000004']);
    expect(remote.error).toMatch(/offline/);
  });

  it('当前季已是第二季时，补搜从缺的第三季开始（不跳过它）', async () => {
    const calls: string[] = [];
    const result = await findSeriesSequels(second as never, [], (async (kw: string) => {
      calls.push(kw);
      return ok(kw === '双子房客' ? [first] : [third]);
    }) as never);
    expect(calls).toEqual(['双子房客', '双子房客第三季', '双子房客第3季']);
    expect(result.results[0].series_id).toBe('1000003');
  });

  it('本机候选跨季不连续时仍补缺的那一季', async () => {
    const calls: string[] = [];
    const result = await findSeriesSequels(second as never, [fourth], (async (kw: string) => {
      calls.push(kw);
      return ok(kw === '双子房客' ? [fourth] : [third]);
    }) as never);
    expect(calls).toEqual(['双子房客', '双子房客第三季', '双子房客第3季']);
    expect(ids(result.results)).toEqual(['1000003', '1000004']);
  });
});
