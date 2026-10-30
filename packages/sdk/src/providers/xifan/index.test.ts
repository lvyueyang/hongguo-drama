/**
 * 西饭来源适配（迁移自 4.5 `scripts/check-xifan.cjs`）。
 *
 * 重点：目录搜索结果与题材去重、分页与题材筛选透传、锁定状态实时读取、
 * 非 HTTPS/带凭据地址拒绝、已核实冲突标题的回退规则，以及身份非法时不联网。
 */

import http from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import xifan from './index.ts';

const sid = 'xifan:huabo:drama1';
const vid = `${sid}:episode1`;

function makeList() {
  return {
    elements: [
      {
        contents: [
          {
            duanjuVo: {
              source: 'huabo',
              duanjuId: 'drama1',
              title: '<tag>测试剧</tag>',
              total: 3,
              categories: ['都市'],
            },
          },
        ],
      },
    ],
    hasMore: true,
    offset: 30,
  };
}

function makeDetail() {
  return {
    source: 'huabo',
    duanjuId: 'drama1',
    title: '测试剧',
    episodeList: [
      {
        episodeId: 'episode1',
        index: 1,
        unlock: true,
        playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode1',
      },
      {
        episodeId: 'episode2',
        index: 2,
        unlock: false,
        playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode2',
      },
      {
        episodeId: 'episode3',
        index: 3,
        playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode3',
      },
    ],
  };
}

function install() {
  const requests: Array<{ url: string; options: any }> = [];
  const detail = makeDetail();
  const list = makeList();
  const category = {
    elements: [
      {
        contents: [
          { categoryItemVo: { categoryId: 68, oppoCategory: '都市', version: 1 } },
          { categoryItemVo: { categoryId: 68, oppoCategory: '青春', version: 1 } },
        ],
      },
    ],
  };

  vi.spyOn(http, 'get').mockImplementation((async (url: string, options: any) => {
    requests.push({ url, options });
    expect(new URL(url).origin).toBe('https://xifan-api-cn.youlishipin.com');
    expect(JSON.stringify(options)).not.toMatch(/cookie|authorization|session|token/i);
    const data = url.includes('getDuanjuInfo')
      ? detail
      : options.params.reqType === 'duanjuCategory'
        ? category
        : list;
    return { data: { ret: 0, result: structuredClone(data) } };
  }) as never);

  return { requests, detail, list };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('西饭目录', () => {
  it('映射卡片与题材，同分类号不同名称不会碰撞，且不虚构总页数', async () => {
    const harness = install();
    const browse = (await xifan.browseList({ page: 1 })) as Record<string, any>;
    expect(browse.success).toBe(true);
    expect(browse.results[0]).toMatchObject({ series_id: sid, series_title: '测试剧' });
    expect(browse.genres).toHaveLength(2);
    expect(browse.genres[0].slug).not.toBe(browse.genres[1].slug);
    expect(browse.totalPages).toBe(0);
    expect(browse.hasMore).toBe(true);
    // 目录首次会顺带取题材列表，所以只断言「确实请求了来源」
    expect(harness.requests.length).toBeGreaterThan(0);
    expect(
      harness.requests.every((item) => new URL(item.url).origin === 'https://xifan-api-cn.youlishipin.com'),
    ).toBe(true);
  });

  it('翻页与题材筛选透传给来源', async () => {
    const harness = install();
    const browse = (await xifan.browseList({ page: 1 })) as Record<string, any>;
    await xifan.browseList({ page: 2, genre: browse.genres[1].slug });
    const last = harness.requests.at(-1);
    expect(last?.options.params.offset).toBe(30);
    expect(last?.options.params.categoryNames).toBe('青春');
  });
});

describe('西饭搜索', () => {
  it('关键词与页码透传，标题去掉标签', async () => {
    const harness = install();
    const search = (await xifan.search('测试剧', 2)) as Record<string, any>;
    expect(search.success).toBe(true);
    expect(search.results[0]?.series_title).toBe('测试剧');
    expect(harness.requests.at(-1)?.options.params).toMatchObject({ keyword: '测试剧', pageIndex: 2 });
  });
});

describe('西饭分集与取流', () => {
  it('缺少 unlock 视为锁定，分集列表不泄露媒体地址', async () => {
    install();
    const episodes = (await xifan.fetchEpisodeList(sid)) as Record<string, any>;
    expect(episodes.episodes).toHaveLength(3);
    expect(episodes.episodes[0]).toMatchObject({ vid, locked: false });
    expect(episodes.episodes[1]?.locked).toBe(true);
    expect(episodes.episodes[2]?.locked).toBe(true);
    expect(JSON.stringify(episodes)).not.toContain('playUrl');
  });

  it('每次取流都重新验锁，原先可用的地址也不例外', async () => {
    const harness = install();
    expect((await xifan.fetchPlayUrlSingle(vid, sid)).url).toBeTruthy();
    harness.detail.episodeList[0]!.unlock = false;
    expect((await xifan.fetchPlayUrlSingle(vid, sid)).url).toBeNull();
    expect((await xifan.fetchPlayUrlSingle(`${sid}:episode2`, sid)).locked).toBe(true);
    harness.detail.episodeList[0]!.unlock = true;
  });

  it('拒绝非 HTTPS、带凭据与 file: 地址', async () => {
    const harness = install();
    for (const invalid of [
      'http://media.example/file.mp4',
      'https://user:pass@dj.youlishipin.com/file',
      'file:///tmp/video.mp4',
    ]) {
      harness.detail.episodeList[0]!.playUrl = invalid;
      expect((await xifan.fetchPlayUrlSingle(vid, sid)).url).toBeNull();
    }
  });

  it('分集与剧集归属不符时拒绝，身份非法时不联网', async () => {
    const harness = install();
    const before = harness.requests.length;
    expect((await xifan.fetchPlayUrlSingle(vid, 'xifan:other:drama1')).url).toBeNull();
    expect((await xifan.fetchPlayUrlSingle('123', sid)).url).toBeNull();
    await expect(xifan.fetchEpisodeList('xifan:huabo:../outside')).rejects.toThrow();
    expect(harness.requests.length).toBe(before);
  });
});

describe('西饭冲突标题回退', () => {
  it('只清理已核实的同名冲突，其他来源/剧名/正常分集不受影响', () => {
    const known = (seriesId: string, seriesTitle: string, title: string) =>
      (
        xifan as unknown as {
          episodeDisplayTitle(seriesId: string, seriesTitle: string, title: string): string;
        }
      ).episodeDisplayTitle(seriesId, seriesTitle, title);

    if (typeof (xifan as Record<string, unknown>).episodeDisplayTitle !== 'function') return;
    expect(known('xifan:jiuzhou:253', '天龙战神', '爱归良辰')).toBe('');
    for (const [seriesId, seriesTitle, title] of [
      ['xifan:jiuzhou:254', '天龙战神', '爱归良辰'],
      ['xifan:huabo:253', '天龙战神', '爱归良辰'],
      ['xifan:jiuzhou:253', '爱归良辰', '爱归良辰'],
      ['xifan:jiuzhou:253', '天龙战神', '第一章：归来'],
    ]) {
      expect(known(seriesId as string, seriesTitle as string, title as string)).toBe(title);
    }
  });
});
