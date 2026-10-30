/**
 * App「近期上新」补搜（迁移自 4.5 `scripts/check-app-search-ipc.cjs` 的上新部分）。
 *
 * 旧检查压的是这条链路的**判断**：官网搜索查不到新剧时要补一次 App 上新、
 * 长旧剧名不能遮住同名的短新剧名、部分分类失败不能被当成「确实没有上新」、
 * 单字词不该白白去补搜。5.0 的编排层（app 优先 + 官网回退 + 上新补搜）尚未迁进 SDK，
 * 这里压的是已经存在的上新模块本身：两类目并行、分页收口、匹配打分、partial 传递。
 * 用真实 loopback HTTP：请求体、分页与响应解析都走生产代码。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearNewReleaseCache,
  listNewReleases,
  matchNewReleases,
  searchNewReleasesDetailed,
} from './new-releases.ts';

let server: http.Server;
let port = 0;
let bodies: Array<Record<string, any>> = [];
let mode: 'ok' | 'one-fails' | 'all-fail' | 'empty' | 'stuck-cursor' = 'ok';

const today = (id: string, title: string) => ({
  series_id: id,
  title,
  cover: 'https://example.com/cover.jpg',
  episode_cnt: 30,
  tag_info: { text: '今日上新' },
  sub_title_list: [{ content: '今日上新' }, { content: '都市' }],
});
const stale = (id: string, title: string) => ({ series_id: id, title, tag_info: { text: '新剧' } });

const rowsFor = (body: Record<string, any>) =>
  body.req_scene === 'ai_series'
    ? [today('8000002', 'AI 新剧'), today('8000003', '接班')]
    : [today('8000001', '接班'), stale('8000002', 'AI 新剧')];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const isAi = body.req_scene === 'ai_series';
      if (mode === 'all-fail' || (mode === 'one-fails' && !isAi)) {
        res.statusCode = 500;
        res.end('upstream down');
        return;
      }
      if (mode === 'empty') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { video_data: [], has_more: false } }));
        return;
      }
      if (mode === 'stuck-cursor') {
        // 上游异常：声称还有下一页但游标不前进，必须就地收口，不能空转。
        res.end(
          JSON.stringify({
            code: 0,
            data: { video_data: rowsFor(body), has_more: true, next_offset: 0, session_id: 's' },
          }),
        );
        return;
      }
      const first = !body.offset;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            video_data: first ? rowsFor(body) : [],
            has_more: first,
            next_offset: first ? 50 : 0,
            session_id: 'session-1',
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearNewReleaseCache();
  bodies = [];
  mode = 'ok';
});

/** 真实 loopback HTTP；非 2xx 按上游失败抛出（与生产 requestJson 的语义一致）。 */
async function request(signed: { body?: Buffer }) {
  const response = await fetch(`http://127.0.0.1:${port}/app/new-releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: signed.body ? new Uint8Array(signed.body) : undefined,
  });
  if (!response.ok) {
    throw Object.assign(new Error('App 上新服务暂不可用'), { code: 'APP_NETWORK' });
  }
  return response.json();
}

describe('listNewReleases：真人 + AI 两类近 7 天', () => {
  it('两类目各自请求，筛选条件钉在线上时间倒序的近 7 天', async () => {
    const result = (await listNewReleases({ request, pages: 2 })) as any;
    const scenes = bodies.map((body) => body.req_scene).sort();
    // 每类两页：首屏 has_more 为真，第二页收口。
    expect(scenes).toEqual(['ai_series', 'ai_series', 'default', 'default']);
    for (const body of bodies) {
      expect(body.select_items.online_time).toEqual(['days_7']);
      expect(body.select_items.sort).toEqual(['online_time']);
      expect(body.limit).toBe(50);
    }
    for (const scene of ['default', 'ai_series']) {
      const offsets = bodies.filter((body) => body.req_scene === scene).map((body) => body.offset ?? 0);
      expect(offsets, scene).toEqual([0, 50]);
    }
    expect(bodies.find((body) => body.req_scene === 'default')?.select_items.genre).toEqual(['short_play']);
    expect(bodies.find((body) => body.req_scene === 'ai_series')?.select_items.genre).toEqual(['ai_series']);
    expect(result.partial).toBe(false);
    expect(result.cached).toBe(false);
  });

  it('同一部剧出现在两类目里只留一条，「今日上新」标记取并集', async () => {
    const result = (await listNewReleases({ request })) as any;
    const ids = result.items.map((item: any) => item.series_id);
    expect(ids.filter((id: string) => id === '8000002')).toHaveLength(1);
    expect(result.items.find((item: any) => item.series_id === '8000002')).toMatchObject({
      series_title: 'AI 新剧',
      released_today: true,
    });
  });

  it('完整结果才进缓存；第二次调用不再联网', async () => {
    await listNewReleases({ request });
    const before = bodies.length;
    const second = (await listNewReleases({ request })) as any;
    expect(bodies.length).toBe(before);
    expect(second.cached).toBe(true);
  });
  it('一类目失败仍可用另一类，并如实标记 partial（且不写缓存）', async () => {
    mode = 'one-fails';
    const result = (await listNewReleases({ request })) as any;
    expect(result.partial).toBe(true);
    expect(result.items.map((item: any) => item.series_id).sort()).toEqual(['8000002', '8000003']);
    const before = bodies.length;
    await listNewReleases({ request });
    expect(bodies.length).toBeGreaterThan(before);
  });

  it('两类都失败时向上抛错，而不是返回「确实没有上新」', async () => {
    mode = 'all-fail';
    await expect(listNewReleases({ request })).rejects.toMatchObject({ code: 'APP_NETWORK' });
  });

  it('响应为空列表时是成功的空结果（不编造条目）', async () => {
    mode = 'empty';
    const result = (await listNewReleases({ request })) as any;
    expect(result.items).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it('上游声称还有下一页但游标不前进时就地收口', async () => {
    mode = 'stuck-cursor';
    await listNewReleases({ request, pages: 4 });
    expect(bodies).toHaveLength(2);
  });

  it('预算已用尽直接超时，不发请求', async () => {
    await expect(listNewReleases({ request, deadline: Date.now() - 1 })).rejects.toMatchObject({
      code: 'APP_TIMEOUT',
    });
    expect(bodies).toEqual([]);
  });
});

describe('matchNewReleases：同名新剧不能被更长的旧剧名遮住', () => {
  const items = [
    { series_id: '1', series_title: '接班人的考题', released_today: false },
    { series_id: '2', series_title: '接班', released_today: true },
    { series_id: '3', series_title: '完全无关', released_today: true },
  ] as never;

  it('精确同名优先，且短新剧名不会被长旧剧名挤掉', () => {
    const matched = matchNewReleases(items, '接班') as any[];
    expect(matched.map((item) => item.series_id)).toEqual(['2', '1']);
  });

  it('标点与空白不影响匹配，反向包含也会被找出来', () => {
    const matched = matchNewReleases(items, ' 接班 人 的考题 ') as any[];
    expect(matched.map((item) => item.series_id)).toEqual(['1', '2']);
  });

  it('单字或空白关键词不匹配（补搜没有意义）', () => {
    expect(matchNewReleases(items, '剧')).toEqual([]);
    expect(matchNewReleases(items, '   ')).toEqual([]);
  });
});

describe('searchNewReleasesDetailed：把上新列表折进搜索结果', () => {
  it('只返回匹配项，并带 partial/cached 标签', async () => {
    const first = (await searchNewReleasesDetailed('接班', { request })) as any;
    expect(first.results.map((item: any) => item.series_id)).toEqual(['8000001', '8000003']);
    expect(first).toMatchObject({ partial: false, cached: false });
    const second = (await searchNewReleasesDetailed('接班', { request })) as any;
    expect(second.cached).toBe(true);
  });

  it('部分分类失败时 partial 为真，上层不能把它当成确认过的空结果', async () => {
    mode = 'one-fails';
    const result = (await searchNewReleasesDetailed('AI 新剧', { request })) as any;
    expect(result.partial).toBe(true);
    expect(result.results.map((item: any) => item.series_id)).toEqual(['8000002']);
  });
});
