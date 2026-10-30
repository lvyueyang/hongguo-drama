/**
 * 河马公开目录（迁移自 4.5 `scripts/check-hema-browse.cjs`）。
 * 夹具是仓库里保存的真实页面（`scripts/fixtures/hema-browse/*.html`），不联网。
 *
 * 重点：题材必须命中页面白名单（不请求未知题材）、分页/题材与页面不一致要报错、
 * 不伪造榜单或热度、刷新复用当前响应、异常与非超时错误区分。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import hema from './index.ts';

const fixture = (name: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), 'scripts/fixtures/hema-browse', `${name}.html`), 'utf8');

function install(): {
  calls: string[];
  setOverride(value: string | null): void;
  setFailure(error: unknown): void;
} {
  const calls: string[] = [];
  let override: string | null = null;
  let failure: unknown;

  vi.spyOn(http, 'get').mockImplementation((async (url: string, options: any) => {
    calls.push(url);
    expect(new URL(url).origin).toBe('https://www.kuaikaw.cn');
    expect(options.timeout).toBe(10000);
    expect(options.maxRedirects).toBe(0);
    expect(JSON.stringify(options.headers)).not.toMatch(/cookie|authorization|session|token/i);
    if (failure) throw failure;
    const name = url.endsWith('/0/2') ? 'page2' : url.endsWith('/1129') ? 'genre' : 'browse';
    return { data: override ?? fixture(name) };
  }) as never);
  vi.spyOn(http, 'post').mockImplementation((() => {
    throw new Error('目录不得请求解锁或其他 POST 接口');
  }) as never);

  return {
    calls,
    setOverride: (value) => {
      override = value;
    },
    setFailure: (error) => {
      failure = error;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('河马公开目录', () => {
  it('首屏解析卡片与题材，且不伪造榜单、热度或总页数', async () => {
    const harness = install();
    const first = (await hema.browseList({})) as Record<string, any>;
    expect(first.success).toBe(true);
    expect(harness.calls).toHaveLength(1);
    expect(first.results[0]).toMatchObject({
      series_id: 'hema:41000415116',
      episode_count: 41,
      source: 'hema',
    });
    expect(first.results[0].rank).toBeUndefined();
    expect(first.results[0].heat).toBeUndefined();
    expect(first.total).toBe(0);
    expect(first.totalPages).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.nextPage).toBe(2);
    expect(first.genres.some((item: { slug: string }) => item.slug === '417-464')).toBe(true);
    expect(first.genres.some((item: { slug: string }) => item.slug === '0')).toBe(false);
  });

  it('翻页与题材各自命中对应 URL', async () => {
    const harness = install();
    const first = (await hema.browseList({})) as Record<string, any>;
    const second = (await hema.browseList({ page: 2 })) as Record<string, any>;
    expect(second.success).toBe(true);
    expect(second.page).toBe(2);
    expect(second.results[0]?.series_id).not.toBe(first.results[0]?.series_id);
    expect(harness.calls.at(-1)).toBe('https://www.kuaikaw.cn/browse/0/2');

    const genre = (await hema.browseList({ genre: '1129' })) as Record<string, any>;
    expect(genre.success).toBe(true);
    expect(genre.sourceUrl).toBe('https://www.kuaikaw.cn/browse/1129');
  });

  it('组合题材（417-464）可用', async () => {
    const harness = install();
    harness.setOverride(
      fixture('genre')
        .replace('"typeThreeId": "1129"', '"typeThreeId": "417-464"')
        .replace('href="/browse/1129/2"', 'href="/browse/417-464/2"'),
    );
    expect(((await hema.browseList({ genre: '417-464' })) as Record<string, any>).success).toBe(true);
    expect(harness.calls.at(-1)).toBe('https://www.kuaikaw.cn/browse/417-464');
  });

  it('未知题材与非法页码在请求前被拒', async () => {
    const harness = install();
    const before = harness.calls.length;
    for (const options of [
      { genre: '../unlock' },
      { genre: '999999' },
      { page: 0 },
      { page: 1.5 },
      { page: Number.POSITIVE_INFINITY },
    ]) {
      expect(((await hema.browseList(options)) as Record<string, any>).success).toBe(false);
    }
    expect(harness.calls.length).toBe(before);
  });

  it('没有下一页标记时 hasMore=false；被改成 data-href 的链接不算分页', async () => {
    const harness = install();
    harness.setOverride(fixture('browse').replace(/<a\b[^>]*>下一页<\/a>/, ''));
    const last = (await hema.browseList({})) as Record<string, any>;
    expect(last.success).toBe(true);
    expect(last.hasMore).toBe(false);
    expect(last.nextPage).toBeNull();

    harness.setOverride(fixture('browse').replace('href="/browse/0/2"', 'data-href="/browse/0/2"'));
    expect(((await hema.browseList({})) as Record<string, any>).hasMore).toBe(false);
  });

  it('分页或题材与页面不一致时报错，页面结构异常时给出可读错误', async () => {
    const harness = install();
    harness.setOverride(fixture('browse'));
    expect(((await hema.browseList({ page: 2 })) as Record<string, any>).success).toBe(false);
    expect(((await hema.browseList({ genre: '1129' })) as Record<string, any>).success).toBe(false);

    harness.setOverride('<html><script>throw Error("must not execute")</script></html>');
    expect(String(((await hema.browseList({})) as Record<string, any>).error)).toMatch(/数据异常/);
  });

  it('刷新重新抓取，且超时与其他错误区分', async () => {
    const harness = install();
    const before = harness.calls.length;
    expect(((await hema.browseList({ forceRefresh: true })) as Record<string, any>).success).toBe(true);
    expect(harness.calls.length).toBeGreaterThan(before);

    harness.setFailure(Object.assign(new Error('private network details'), { code: 'ECONNABORTED' }));
    const result = (await hema.browseList({})) as Record<string, any>;
    expect(String(result.error)).toMatch(/超时/);
    expect(String(result.error)).not.toMatch(/private/);
  });
});
