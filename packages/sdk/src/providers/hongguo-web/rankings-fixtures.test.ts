/**
 * 四个榜单的真实页面夹具（迁移自 4.5 `scripts/check-rankings.cjs`）。
 *
 * 夹具是 2026-10-11 抓下来的官网公开页面（`scripts/fixtures/rankings/`）：
 * 既有流式 SSR 的 loader JSON（提供完整分集元数据），也有语义 HTML 兜底。
 * 这里守：榜单顺序与热度如实、第二页名次是绝对名次、缓存生效、
 * 页面不可解析就是失败（不假装成功空态）、CSS 类名哈希变了也还能解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'scripts/fixtures/rankings', name), 'utf8');

const harness = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  calls: [] as string[],
  fallback: '' as unknown,
}));

vi.mock('axios', () => ({ default: vi.fn() }));

const axios = (await import('axios')).default as unknown as { get: ReturnType<typeof vi.fn> };

/** 榜单缓存是模块级状态：每条用例都要一份干净模块。 */
async function loadCatalog() {
  vi.resetModules();
  return (await import('./catalog.ts')) as { browseList: (options?: any) => Promise<any> };
}

function fixturePage(url: string): string {
  const category = url.split('/rank/')[1]!.replace(/\?.*$/, '');
  const page = Number(new URL(url).searchParams.get('page')) || 1;
  return fixture(page > 1 ? `${category}-page-${page}.html` : `${category}.html`);
}

beforeEach(() => {
  harness.responses = new Map();
  harness.calls = [];
  harness.fallback = '';
  axios.get = vi.fn(async (url: string) => {
    harness.calls.push(url);
    if (harness.responses.has(url)) return { status: 200, headers: {}, data: harness.responses.get(url) };
    const response = harness.fallback || fixturePage(url);
    return { status: 200, headers: {}, data: response };
  });
});

describe('四个榜单来源夹具', () => {
  it('顺序与热度如实，真人榜用流式 JSON 补齐分集', async () => {
    const { browseList } = await loadCatalog();
    const expected: Array<[string, string, string, string | null]> = [
      ['hot-drama', '7691228619774905368', '聚宝仙盆之杂灵根才是真BOSS第十三季', '7173万热度'],
      ['hot-real-drama', '7686713195246930968', '首辅娇娘', '6772万热度'],
      ['hot-comic-drama', '7691228619774905368', '聚宝仙盆之杂灵根才是真BOSS第十三季', '7173万热度'],
      ['hot-ai-drama', '7692043430955863102', '反向拿捏：和闺蜜穿七零带着婆婆一起离', null],
    ];
    for (const [category, id, title, heat] of expected) {
      const data = (await browseList({ category })) as any;
      expect(data.success, `${category}: ${data.error}`).toBe(true);
      expect(data.results).toHaveLength(2);
      expect(data.results[0].series_id).toBe(id);
      expect(data.results[0].series_title).toBe(title);
      expect(data.results[0].rank).toBe(1);
      expect(data.results[0].heat).toMatch(/热度$/);
      if (heat) expect(data.results[0].heat).toBe(heat);
      if (category === 'hot-real-drama')
        expect(data.results[0].episode_count, '流式 JSON 应给出完整分集数').toBeGreaterThan(24);
      expect(data.results[0].url).toBe(`https://hongguoduanju.com/detail?series_id=${id}`);
      expect(data.genres).toEqual([]);
      expect(data.page).toBe(1);
    }
  });

  it('第二页的名次保持绝对名次，且用页码参数请求', async () => {
    const { browseList } = await loadCatalog();
    const second = (await browseList({ category: 'hot-drama', page: 2 })) as any;
    expect(second.page).toBe(2);
    expect(second.results[0].rank).toBe(21);
    expect(second.results[0].series_id).toBe('7693492249157438489');
    expect(harness.calls.at(-1)).toBe('https://hongguoduanju.com/rank/hot-drama?page=2');
  });

  it('榜单页有短缓存；forceRefresh 才重新请求', async () => {
    const { browseList } = await loadCatalog();
    await browseList({ category: 'hot-drama' });
    await browseList({ category: 'hot-drama' });
    expect(harness.calls).toHaveLength(1);
    await browseList({ category: 'hot-drama', forceRefresh: true });
    expect(harness.calls).toHaveLength(2);
  });
});

describe('解析健壮性', () => {
  it('远程脚本不执行；无法解析就是失败并给出 sourceUrl', async () => {
    const { browseList } = await loadCatalog();
    harness.fallback = '<html><script>throw Error("remote scripts must never execute")</script></html>';
    const bad = (await browseList({ category: 'hot-drama' })) as any;
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/榜单/);
    expect(bad.sourceUrl).toBe('https://hongguoduanju.com/rank/hot-drama');
  });

  it('CSS 类名哈希变化后仍按语义解析', async () => {
    const { browseList } = await loadCatalog();
    harness.fallback = fixture('hot-drama.html').replace(/pc-[A-Za-z][\w-]*/g, 'changed-style');
    const renamed = (await browseList({ category: 'hot-drama', forceRefresh: true })) as any;
    expect(renamed.success).toBe(true);
    expect(renamed.results[0].rank).toBe(1);
    expect(renamed.results[0].heat).toBe('7173万热度');
  });

  it('榜单不接受题材参数，也不接受非法来源', async () => {
    const { browseList } = await loadCatalog();
    expect(((await browseList({ category: 'hot-drama', genre: '../../outside' })) as any).success).toBe(
      false,
    );
    expect(((await browseList({ category: 'not-a-ranking' })) as any).success).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });
});
