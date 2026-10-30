/**
 * 弹幕获取（迁移自 4.5 `scripts/check-danmaku-*.cjs` 的服务层断言）。
 *
 * 全程离线：用注入的 transport 替代真实接口，覆盖分页、去重、脏数据过滤、
 * 缓存与失败文案——这些是「视频看着没问题但弹幕悄悄少了」最容易出问题的地方。
 */
import { describe, expect, it, vi } from 'vitest';
import danmakuApi from './index.ts';

// fetchDanmaku 只在默认导出对象上（与 4.5 的 module.exports 形状一致）
const { fetchDanmaku } = danmakuApi;

const SERIES = '7654321098765432109';
const VID = '7654321098765432110';

interface RowOptions {
  text?: string;
  offsetMs?: number;
  status?: string;
  groupId?: string;
  color?: number;
}

const row = ({ text = '弹幕', offsetMs = 1200, status = '1', groupId = VID, color }: RowOptions = {}) => ({
  comment: {
    common: { group_id: groupId, status, content: { text, ...(color === undefined ? {} : { color }) } },
    expand: { offset_time: offsetMs },
  },
});

function pageResponse(rows: unknown[], nextMs: number | null, hasMore: boolean | null = null) {
  return {
    data: JSON.stringify({
      code: 0,
      data: {
        data_list: rows,
        extra: nextMs === null ? {} : { next_query_danmaku_list_time: String(nextMs) },
        common_list_info: hasMore === null ? {} : { has_more: hasMore },
      },
    }),
  };
}

const transportOf = (pages: Array<ReturnType<typeof pageResponse>>) => {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    return pages[Math.min(calls.length - 1, pages.length - 1)];
  });
  return { transport, calls };
};

describe('fetchDanmaku：入口校验', () => {
  it('非红果 id 直接拒绝，不发请求', async () => {
    const { transport } = transportOf([pageResponse([], null)]);
    const result = await fetchDanmaku({ seriesId: 'xifan:a:b', vid: VID, transport });
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/仅红果来源/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('参数非法（limit 越界）也拒绝', async () => {
    const { transport } = transportOf([pageResponse([], null)]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, limit: 0, transport });
    expect(result.error).toMatch(/参数无效/);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('fetchDanmaku：解析与过滤', () => {
  it('毫秒偏移转秒，并保留颜色与模式', async () => {
    const { transport } = transportOf([
      pageResponse([row({ text: '笑死', offsetMs: 2500, color: 16 })], null),
    ]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ time: 2.5, text: '笑死' });
    expect(result.error).toBe('');
  });

  it('过滤别集弹幕、非正常状态、空文本与重复条目', async () => {
    const { transport } = transportOf([
      pageResponse(
        [
          row({ text: '正常' }),
          row({ text: '别的集', groupId: '7000000000000000000' }),
          row({ text: '待审核', status: '2' }),
          row({ text: '' }),
          row({ text: '正常' }),
        ],
        null,
      ),
    ]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(result.items.map((item) => item.text)).toEqual(['正常']);
  });

  it('时间戳非法的条目被丢弃', async () => {
    const { transport } = transportOf([
      pageResponse([row({ text: '坏时间', offsetMs: Number.POSITIVE_INFINITY })], null),
    ]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(result.items).toHaveLength(0);
  });
});

describe('fetchDanmaku：分页', () => {
  it('按 next_query_danmaku_list_time 翻页并合并', async () => {
    const { transport, calls } = transportOf([
      pageResponse([row({ text: '第一页', offsetMs: 1000 })], 60_000),
      pageResponse([row({ text: '第二页', offsetMs: 61_000 })], null),
    ]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(calls.length).toBe(2);
    expect(result.items.map((item) => item.text)).toEqual(['第一页', '第二页']);
  });

  it('has_more=false 时不再翻页（即便带了 cursor）', async () => {
    const { transport, calls } = transportOf([
      pageResponse([row({ text: '唯一页' })], 60_000, false),
      pageResponse([row({ text: '不该出现' })], null),
    ]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(calls.length).toBe(1);
    expect(result.items.map((item) => item.text)).toEqual(['唯一页']);
  });

  it('limit 生效并标记截断', async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({ text: `第${index}条`, offsetMs: 1000 * (index + 1) }),
    );
    const { transport } = transportOf([pageResponse(rows, null)]);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, limit: 3, transport });
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});

describe('fetchDanmaku：缓存与失败', () => {
  it('成功结果在 TTL 内复用，不重复请求', async () => {
    const { transport, calls } = transportOf([pageResponse([row({ text: '缓存命中' })], null)]);
    const options = { seriesId: SERIES, vid: VID, transport };
    await fetchDanmaku({ ...options, fresh: true });
    const second = await fetchDanmaku(options);
    expect(calls.length).toBe(1);
    expect(second.items.map((item) => item.text)).toEqual(['缓存命中']);
  });

  it('首页失败时给出可判断的文案，且不透传上游原文', async () => {
    const transport = vi.fn(async () => {
      throw Object.assign(new Error('https://signed.example/x?sign=secret'), { code: 'ERR_BAD_RESPONSE' });
    });
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(result.items).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/signed\.example|sign=secret/);
  });

  it('后续页失败时保留已拿到的部分', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([row({ text: '第一页' })], 60_000))
      .mockRejectedValueOnce(new Error('网络中断'));
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, fresh: true, transport });
    expect(result.items.map((item) => item.text)).toEqual(['第一页']);
    expect(result.error).toMatch(/保留已获取的部分/);
  });
});
