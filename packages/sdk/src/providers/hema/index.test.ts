/**
 * 河马来源适配（迁移自 4.5 `scripts/check-hema.cjs`）。
 *
 * 夹具是 2026-10-07 抓到的公开字段（签名地址换成惰性示例，其余分集 id 为合成值），
 * 保持「74 集 / 5 免费 / 69 收费」的真实形状。
 *
 * 这里守的是几条会直接影响用户与账号安全的规则：
 * - 免费/收费状态**每次实时读取**，缓存不得绕过变更后的收费标记；
 * - 分集列表里不得出现任何可直接下载的签名地址；
 * - 取流只接受 HTTPS，且**绝不回退到 encryptUrl**；
 * - 身份编号非法时在联网之前就失败。
 */

import http from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import hema from './index.ts';

const sid = 'hema:41000115014';
const vid = `${sid}:591821028`;

function makeDetail() {
  return {
    bookInfoVo: {
      bookId: '41000115014',
      bookName: '出手',
      totalChapterNum: '74',
      coverWap: 'https://images.example/cover.jpg',
    },
    chapterList: Array.from({ length: 74 }, (_, index) => ({
      chapterId: String(591821028 + index),
      chapterName: `第${index + 1}集`,
      chapterIndex: index + 1,
      isCharge: index < 5 ? '0' : '1',
      ...(index < 5
        ? {
            chapterVideoVo: {
              mp4720p: 'https://media.example/720.mp4',
              mp4: 'https://media.example/video.mp4',
              encryptUrl: 'https://media.example/forbidden',
            },
          }
        : {}),
    })),
  };
}

function makeList() {
  return {
    retCode: 0,
    data: {
      isMore: 1,
      totalSize: 241,
      bookList: [
        {
          bookId: '41000115014',
          bookName: '<em>出手</em>',
          totalChapterNum: '74',
          coverWap: 'https://images.example/cover.jpg',
          bookTypeThree: [{ id: 1, name: '都市' }],
        },
      ],
    },
  };
}

interface Harness {
  requests: Array<{ method: string; url: string; body: any; options: any }>;
  detail: ReturnType<typeof makeDetail>;
  list: ReturnType<typeof makeList>;
  setFailure(error: unknown): void;
  setMalformedHtml(value: boolean): void;
  setHangUp(value: boolean): void;
}

function install(): Harness {
  const detail = makeDetail();
  const list = makeList();
  const requests: Harness['requests'] = [];
  let failure: unknown;
  let malformedHtml = false;
  let hangUp = false;

  const dispatch = async (method: string, url: string, body: unknown, options: any) => {
    requests.push({ method, url, body, options });
    expect(new URL(url).origin).toBe('https://www.kuaikaw.cn');
    expect(options.timeout).toBe(10000);
    expect(options.maxRedirects).toBe(0);
    expect(options.headers.pname).toBe('www.kuaikaw.cn');
    expect(options.headers.Origin).toBe('https://www.kuaikaw.cn');
    expect(JSON.stringify(options.headers)).not.toMatch(/cookie|authorization|session|token/i);
    if (hangUp) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (failure) throw failure;
    if (method === 'POST') return { data: structuredClone(list) };
    return {
      data: malformedHtml
        ? '<html>unavailable</html>'
        : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: detail } })}</script>`,
    };
  };

  vi.spyOn(http, 'get').mockImplementation(((url: string, options: any) =>
    dispatch('GET', url, null, options)) as never);
  vi.spyOn(http, 'post').mockImplementation(((url: string, body: unknown, options: any) =>
    dispatch('POST', url, body, options)) as never);

  return {
    requests,
    detail,
    list,
    setFailure: (error) => {
      failure = error;
    },
    setMalformedHtml: (value) => {
      malformedHtml = value;
    },
    setHangUp: (value) => {
      hangUp = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('河马搜索', () => {
  it('映射结果、题材与分页，并按约定发送请求体', async () => {
    const harness = install();
    const result = await hema.search('总裁', 2);
    expect(result.success).toBe(true);
    expect(result.results[0]).toMatchObject({
      series_id: sid,
      series_title: '出手',
      episode_count: 74,
    });
    expect(result.results[0]?.tags?.[0]).toBe('都市');
    expect(result).toMatchObject({ hasMore: true, nextPage: 3, total: 241 });

    const last = harness.requests.at(-1);
    expect(last?.url).toBe('https://www.kuaikaw.cn/seo/video/6007');
    expect(last?.body).toMatchObject({ keyword: '总裁', index: 2, sourceType: 1 });
  });

  it('isMore=0 时没有下一页；retCode 非 0 时判失败', async () => {
    const harness = install();
    harness.list.data.isMore = 0;
    expect((await hema.search('总裁')).hasMore).toBe(false);
    harness.list.retCode = 1;
    expect((await hema.search('总裁')).success).toBe(false);
  });

  it('空白关键词不发请求', async () => {
    const harness = install();
    const before = harness.requests.length;
    expect((await hema.search('   ')).success).toBe(false);
    expect(harness.requests.length).toBe(before);
  });

  it('失败文案不透传上游原文，超时单独提示', async () => {
    const harness = install();
    for (const code of ['ECONNABORTED', 'ERR_BAD_RESPONSE']) {
      harness.setFailure(Object.assign(new Error('private response must not leak'), { code }));
      const result = await hema.search('总裁');
      expect(result.success).toBe(false);
      expect(String(result.error)).not.toMatch(/private/);
      if (code === 'ECONNABORTED') expect(String(result.error)).toMatch(/超时/);
    }
  });
});

describe('河马分集列表', () => {
  it('74 集里 69 集收费，且列表里不含任何可下载地址', async () => {
    install();
    const episodes = await hema.fetchEpisodeList(sid);
    expect(episodes.total).toBe(74);
    expect(episodes.episodes?.filter((episode) => episode.locked)).toHaveLength(69);
    expect(episodes.episodes?.[0]).toMatchObject({ vid, vid_index: 1, series_title: '出手' });
    expect(JSON.stringify(episodes)).not.toContain('media.example');
  });

  it('收费标记只要不是 "0" 就算锁定（缓存不得绕过变更）', async () => {
    const harness = install();
    for (const charge of ['1', undefined, null, false, '', 'false', '00']) {
      harness.detail.chapterList[0]!.isCharge = charge as never;
      expect((await hema.fetchEpisodeList(sid)).episodes?.[0]?.locked).toBe(true);
      const play = await hema.fetchPlayUrlSingle(vid, sid);
      expect(play.url).toBeNull();
      expect(play.locked).toBe(true);
    }
    harness.detail.chapterList[0]!.isCharge = '0';
  });

  it('书籍编号与请求不一致时拒绝解析', async () => {
    const harness = install();
    harness.detail.bookInfoVo.bookId = '999';
    await expect(hema.fetchEpisodeList(sid)).rejects.toThrow();
  });

  it('页面结构异常时拒绝解析', async () => {
    const harness = install();
    harness.setMalformedHtml(true);
    await expect(hema.fetchEpisodeList(sid)).rejects.toThrow();
  });
});

describe('河马取流', () => {
  it('优先 720p，缺失时回退 mp4', async () => {
    const harness = install();
    expect((await hema.fetchPlayUrlSingle(vid, sid)).url).toBe('https://media.example/720.mp4');
    const media = harness.detail.chapterList[0]!.chapterVideoVo as Record<string, unknown>;
    delete media.mp4720p;
    expect((await hema.fetchPlayUrlSingle(vid, sid)).url).toBe('https://media.example/video.mp4');
  });

  it('绝不回退到 encryptUrl，也不接受非 HTTPS 或带凭据的地址', async () => {
    const harness = install();
    const media = harness.detail.chapterList[0]!.chapterVideoVo as Record<string, unknown>;
    delete media.mp4720p;
    for (const invalid of [
      'http://media.example/video.mp4',
      'https://user:pass@media.example/video.mp4',
      'file:///tmp/video.mp4',
      '',
    ]) {
      media.mp4 = invalid;
      expect((await hema.fetchPlayUrlSingle(vid, sid)).url).toBeNull();
    }
  });

  it('收费分集不返回地址', async () => {
    install();
    expect((await hema.fetchPlayUrlSingle(`${sid}:591821033`, sid)).locked).toBe(true);
  });
});

describe('河马身份校验（联网前失败）', () => {
  it('非法分集编号与非法剧集编号都在请求之前被拒', async () => {
    const harness = install();
    const before = harness.requests.length;
    for (const invalid of ['123', 'xifan:41000115014:591821028', `${vid}:extra`, 'hema:../evil:1']) {
      expect((await hema.fetchPlayUrlSingle(invalid, sid)).url).toBeNull();
    }
    for (const invalidSid of ['hema:123', 'xifan:41000115014', 'https://evil.example/']) {
      expect((await hema.fetchPlayUrlSingle(vid, invalidSid)).url).toBeNull();
    }
    await expect(hema.fetchEpisodeList('hema:../evil')).rejects.toThrow();
    expect(harness.requests.length).toBe(before);
  });

  it('分集不属于当前剧时拒绝', async () => {
    install();
    expect((await hema.fetchPlayUrlSingle(`${sid}:999`, sid)).url).toBeNull();
  });
});
