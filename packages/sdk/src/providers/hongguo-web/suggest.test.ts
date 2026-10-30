import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes } from '@hongguo/shared';
import { describe, expect, it, vi } from 'vitest';
import { normalizeSuggestCover, suggestSuggestions, suggestUrl, validateSuggestQuery } from './suggest.ts';

const fixture = (name: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), 'fixtures/hongguo-web', name), 'utf8');

const respondWith = (body: string, status = 200) => vi.fn(async () => ({ status, body }));

describe('搜索联想接口（红果官网 /api/search/suggestion）', () => {
  it('URL 与接口路径与逆向结果一致', () => {
    expect(suggestUrl('一村人')).toBe(
      'https://hongguoduanju.com/api/search/suggestion/?query=%E4%B8%80%E6%9D%91%E4%BA%BA',
    );
  });

  it('本地拒绝空关键词与超过 30 字的关键词，不发起请求', async () => {
    const transport = respondWith(fixture('suggest-basic.json'));
    for (const bad of ['', '   ', 'A'.repeat(31)]) {
      await expect(suggestSuggestions(bad, { transport })).rejects.toMatchObject({
        code: ErrorCodes.INPUT_INVALID,
      });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(validateSuggestQuery(' 修仙 ')).toBe('修仙');
  });

  it('剧名结果直接用 series_id 作为 keyword，并按字符串保留 19 位精度', async () => {
    const items = await suggestSuggestions('修仙', {
      transport: respondWith(fixture('suggest-basic.json')),
    });
    const drama = items.find((item) => item.wordType === 'short_play_name');
    expect(drama?.keyword).toBe('7698612485254810686');
    expect(drama?.series?.seriesId).toBe('7698612485254810686');
    expect(String(drama?.series?.seriesId)).toHaveLength(19);
    expect(drama?.series?.episodeCount).toBe(182);
    expect(drama?.series?.episodeRightText).toBe('全182集');
    expect(drama?.series?.hotText).toBe('5275万热度');
    expect(drama?.series?.categories.map((entry) => entry.name)).toEqual(['玄幻', '重生', '都市']);
    expect(drama?.series?.vids[0]).toBe('7698612493093964824');
    expect(drama?.displayWords).toEqual(['修仙', '被淘汰，重生都市大爽特爽第一季']);
  });

  it('通用词结果的 video_data 为空时不编造剧集信息', async () => {
    const items = await suggestSuggestions('修仙', {
      transport: respondWith(fixture('suggest-basic.json')),
    });
    const common = items.find((item) => item.wordType === 'common_query');
    expect(common?.keyword).toBe('1_38c9d9149ee13c3f1ce49edd79bee196');
    expect(common?.series).toBeNull();
  });

  it('HEIC 封面换成可渲染变体，非法封面丢弃', () => {
    expect(
      normalizeSuggestCover('https://p6-novel-sign.fqnovelpic.com/novel-pic/abc123~tplv-shrink:640:0.heic'),
    ).toBe('https://p3-novel.byteimg.com/novel-pic/abc123~tplv-shrink:640:0.image');
    expect(normalizeSuggestCover('//p3-novel.byteimg.com/a.jpg')).toBe('https://p3-novel.byteimg.com/a.jpg');
    expect(normalizeSuggestCover('javascript:alert(1)')).toBe('');
    expect(normalizeSuggestCover('')).toBe('');
  });

  it('接口返回 invalid_query 时映射为输入错误', async () => {
    await expect(
      suggestSuggestions('修仙', { transport: respondWith(fixture('suggest-invalid-query.json')) }),
    ).rejects.toMatchObject({ code: ErrorCodes.INPUT_INVALID });
  });

  it('空列表返回空数组而不是报错', async () => {
    const items = await suggestSuggestions('没有这个词', {
      transport: respondWith(fixture('suggest-empty.json')),
    });
    expect(items).toEqual([]);
  });

  it('HTTP 失败与非法 JSON 收敛为可用错误码', async () => {
    await expect(suggestSuggestions('修仙', { transport: respondWith('', 502) })).rejects.toMatchObject({
      code: ErrorCodes.SOURCE_UNAVAILABLE,
    });
    await expect(
      suggestSuggestions('修仙', { transport: respondWith('<html>not json</html>') }),
    ).rejects.toMatchObject({ code: ErrorCodes.UPSTREAM_SCHEMA });
  });

  it('limit 只裁剪返回条数，不改变接口固定 10 条的语义', async () => {
    const items = await suggestSuggestions('修仙', {
      transport: respondWith(fixture('suggest-basic.json')),
      limit: 2,
    });
    expect(items).toHaveLength(2);
  });

  it('超时收敛为 TIMEOUT', async () => {
    const transport = vi.fn(
      async (_url: string, init: { signal?: AbortSignal }) =>
        await new Promise<{ status: number; body: string }>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    await expect(suggestSuggestions('修仙', { transport, timeoutMs: 20 })).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
    });
  });
});
