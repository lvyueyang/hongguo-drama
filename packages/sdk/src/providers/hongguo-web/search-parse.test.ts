/**
 * 官网搜索接口的字段清洗与错误归类（迁移自 4.5 `src/native/hongguo-search.test.cjs` 的解析部分）。
 *
 * 已有 `search-api.test.ts` 压的是「接口优先 → 结构变了才回退」这条链路（真实 loopback HTTP）。
 * 这里补的是结果字段：封面必须可显示、HTML 实体要还原、集数在 `episode_cnt` 缺失时从
 * 「全88集」这类文案里取、重复条目要去掉、以及**失败结果不能进缓存**——缓存住一次
 * 上游错误会让用户以为「这部剧搜不到」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRequestError,
  clearSearchCache,
  HongguoSearchError,
  parseSearchResponse,
  searchHongguo,
} from './search.ts';

const payload = {
  searchList: [
    {
      doc_type: 23,
      name: '甲剧',
      video_data: {
        series_id: '1234567',
        series_title: '甲剧',
        series_cover: 'https:\\/\\/img.example\\/a.jpg',
        episode_cnt: 20,
        tags: [{ name: '玄幻' }, '穿越'],
      },
    },
    { doc_type: 23, video_data: { series_id: '1234567', series_title: '重复条目' } },
    {
      doc_type: 23,
      video_data: {
        series_id: '7654321',
        series_name: '乙剧',
        episode_right_text: '全88集',
        category_list: ['都市'],
      },
    },
    { doc_type: 24, video_data: {} },
  ],
  totalCount: '2',
  pageNum: '1',
  totalPages: '1',
  hasMore: false,
};

beforeEach(() => {
  clearSearchCache();
});

/** parseSearchResponse 会抛，这里把抛出的错误取回来断言（避免联合类型的属性收窄问题）。 */
function thrown(run: () => unknown): HongguoSearchError {
  try {
    run();
  } catch (error) {
    return error as HongguoSearchError;
  }
  throw new Error('expected the call to throw');
}

describe('parseSearchResponse：结果字段', () => {
  it('转义过的封面、标签与集数都归一成应用内的形状，重复条目只留一条', () => {
    const parsed = parseSearchResponse(payload);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toEqual({
      series_id: '1234567',
      series_title: '甲剧',
      cover: 'https://img.example/a.jpg',
      episode_count: 20,
      tags: ['玄幻', '穿越'],
      description: '',
      url: 'https://hongguoduanju.com/detail?series_id=1234567',
    });
    // 没有 episode_cnt 时从「全88集」里取，tags 支持字符串与对象两种形状
    expect(parsed.results[1].episode_count).toBe(88);
    expect(parsed.results[1].tags).toEqual(['都市']);
    expect(parsed.total).toBe(2);
    expect(parsed.page).toBe(1);
    expect(parsed.hasMore).toBe(false);
  });

  it('video_data 为空时退回条目自身的 keyword 与 name，封面留空而不是给个坏地址', () => {
    const parsed = parseSearchResponse({
      searchList: [
        {
          doc_type: 23,
          name: '谁说纨绔不能当状元',
          keyword: '7673067074104593432',
          video_data: {},
          user_info: {},
          video_list: [],
        },
      ],
    });
    expect(parsed.results[0]).toMatchObject({
      series_id: '7673067074104593432',
      series_title: '谁说纨绔不能当状元',
      cover: '',
    });
  });

  it('非 http(s) 封面一律丢掉，HTML 实体在标题里还原', () => {
    const parsed = parseSearchResponse({
      searchList: [
        {
          video_data: {
            series_id: '1111111',
            series_title: '甲 &amp; 乙',
            series_cover: 'javascript:alert(1)',
          },
        },
        {
          video_data: { series_id: '2222222', series_title: '丙', series_cover: 'http://img.example/c.png' },
        },
      ],
    });
    expect(parsed.results[0].series_title).toBe('甲 & 乙');
    expect(parsed.results[0].cover).toBe('');
    expect(parsed.results[1].cover).toBe('http://img.example/c.png');
  });

  it('空响应与网页内容属于上游异常，结构缺失才允许回退页面', () => {
    for (const value of [null, '', '<html>challenge</html>']) {
      const error = thrown(() => parseSearchResponse(value));
      expect(error).toBeInstanceOf(HongguoSearchError);
      expect(error.kind).toBe('upstream');
      expect(error.fallback).toBeFalsy();
    }
    for (const value of [{}, { searchList: null }]) {
      expect(() => parseSearchResponse(value)).toThrow(/异常数据/);
      expect(() => parseSearchResponse(value)).toThrowError(
        expect.objectContaining({ kind: 'format', fallback: true }),
      );
    }
  });
});

describe('searchHongguo：失败不进缓存、重试与输入校验', () => {
  it('上游错误码配空列表仍是错误，且不会被缓存成「空结果」', async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      return { code: 'upstream_unavailable', message: 'Search is temporarily unavailable.', searchList: [] };
    };
    await expect(searchHongguo('错误码空列表', { request, cache: true, retries: 1 })).rejects.toThrow(
      /暂不可用/,
    );
    expect(calls).toBe(2);
    await expect(searchHongguo('错误码空列表', { request, cache: true, retries: 0 })).rejects.toThrow(
      /暂不可用/,
    );
    expect(calls).toBe(3);
  });

  it('首次失败第二次成功时返回结果，不需要调用方重试', async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return payload;
    };
    const result = await searchHongguo('甲剧', { request, retries: 1, cache: false });
    expect(calls).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it('空关键词与超长关键词在本地拦下，一个请求都不发', async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      return payload;
    };
    await expect(searchHongguo('   ', { request })).rejects.toThrow(/搜索词/);
    await expect(searchHongguo(`${'红'.repeat(201)}`, { request })).rejects.toThrow(/搜索词/);
    expect(calls).toBe(0);
  });

  it('HTTP 403 说明接口形态变了：归为可回退，并且只试一次', async () => {
    const classified = classifyRequestError({ response: { status: 403 } }) as HongguoSearchError;
    expect(classified.kind).toBe('format');
    expect(classified.fallback).toBe(true);
    expect(classified.message).toMatch(/接口已变化/);

    const calls: number[] = [];
    const request = vi.fn(async () => {
      calls.push(1);
      throw classified;
    });
    await expect(searchHongguo('甲剧', { request, retries: 2, cache: false })).rejects.toThrow(/接口已变化/);
    expect(calls).toHaveLength(1);
  });

  it('超时类错误不会被当成「可以换路子」', () => {
    for (const error of [{ code: 'ECONNABORTED' }, { code: 'ETIMEDOUT' }, { response: { status: 408 } }]) {
      const classified = classifyRequestError(error) as HongguoSearchError;
      expect(classified.kind).toBe('timeout');
      expect(classified.fallback).toBeFalsy();
    }
  });
});
