/**
 * 官方弹幕的失败语义、缓存与报文契约（迁移自 4.5 `src/native/danmaku.test.cjs`）。
 *
 * 已有 `index.test.ts` 压的是解析、过滤与分页主干。这里补它没压的部分，重点仍是两条：
 * 1. **「源不可用」与「本集真的没有弹幕」绝不能互相冒充**，包括命中失败缓存的路径；
 * 2. 匿名标识必须落在本机文件里跨重启复用（上游按标识分配弹幕子集，换一次就少一批）。
 * 全部离线：传输层、时钟、nonce 都是注入的替身。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import danmakuApi from './index.ts';

const {
  fetchDanmaku,
  normalizeColor,
  toSeconds,
  resetDanmakuCache,
  setDeviceIdentityFile,
  setDeviceIdentity,
} = danmakuApi as any;

const SERIES = '7503745441910017049';
const VID = '7503780574541122622';

interface RowOptions {
  text?: string;
  offsetMs?: number;
  status?: string;
  groupId?: string;
}

const comment = ({ text = '好家伙', offsetMs = 1200, status = '1', groupId = VID }: RowOptions = {}) => ({
  comment: {
    common: { group_id: groupId, status, content: { text } },
    expand: { offset_time: offsetMs },
  },
});

interface PageOptions {
  rows?: unknown[];
  extra?: Record<string, string>;
  info?: Record<string, unknown>;
}

const page = ({ rows = [], extra, info }: PageOptions = {}) => ({
  code: 0,
  data: {
    data_list: rows,
    ...(extra ? { extra } : {}),
    ...(info ? { common_list_info: info } : {}),
  },
});

const respond = (payload: unknown) => ({ data: JSON.stringify(payload) });
const fixed = (transport: any) => ({
  transport,
  now: () => 1760000000000,
  random: () => Buffer.from('000102030405060708090a', 'hex'),
});

let tempDirs: string[] = [];

function tempFile(content?: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-cases-'));
  tempDirs.push(folder);
  const file = path.join(folder, 'client.json');
  if (content !== undefined) fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

beforeEach(() => {
  setDeviceIdentityFile(null);
  resetDanmakuCache();
  setDeviceIdentity({ deviceId: '1000000000000000001', installId: '1000000000000000002' });
});

afterEach(() => {
  setDeviceIdentityFile(null);
  resetDanmakuCache();
  for (const folder of tempDirs) fs.rmSync(folder, { recursive: true, force: true });
  tempDirs = [];
});

describe('匿名标识：跨重启复用本机文件', () => {
  it('重启后沿用同一份标识，文件只有本人可读写且日志里不出现标识', async () => {
    const file = tempFile();
    const requested: Array<[string | null, string | null]> = [];
    const logSpies = ['log', 'info', 'warn', 'error'].map((method) =>
      vi.spyOn(console as any, method).mockImplementation(() => {}),
    );
    const transport = async (url: string) => {
      const query = new URL(url).searchParams;
      requested.push([query.get('device_id'), query.get('iid')]);
      return respond(page({ rows: [comment()] }));
    };
    try {
      // 每次「重启」都重新指向同一个文件，进程内缓存的身份随之失效。
      for (const round of [1, 2]) {
        resetDanmakuCache();
        setDeviceIdentityFile(file);
        const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
        expect(result.success, `round ${round}`).toBe(true);
      }
      expect(requested).toHaveLength(2);
      expect(requested[1]).toEqual(requested[0]);
      expect(fs.statSync(file).isFile()).toBe(true);
      // Windows 不通过 stat/chmod 暴露 POSIX 权限位。
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const logged = logSpies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')));
      for (const line of logged) {
        for (const value of requested[0]) expect(line.includes(String(value))).toBe(false);
      }
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }
  });

  it('本机标识损坏时保留文件并报配置问题，不静默换一份新的去请求', async () => {
    const file = tempFile('{broken');
    const transport = vi.fn(async () => respond(page({ rows: [comment()] })));
    setDeviceIdentityFile(file);
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(result.success).toBe(false);
    expect(result.notice).toMatch(/本机配置/);
    expect(transport).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
});

describe('解析辅助函数：颜色与时间', () => {
  it('颜色归一：数字、0x 前缀、三位简写与非法值', () => {
    expect(normalizeColor(16711680)).toBe('#FF0000');
    expect(normalizeColor('0xFF0000')).toBe('#FF0000');
    expect(normalizeColor('#00ff00')).toBe('#00FF00');
    expect(normalizeColor('#abc')).toBe('#AABBCC');
    for (const value of ['乱七八糟', '0xffno', '#GGG', '#<bad>', '12oops', -1, undefined, null, '']) {
      expect(normalizeColor(value), String(value)).toBe('#FFFFFF');
    }
  });

  it('时间越界被丢弃，不把脏数据变成时间轴上的合法值', () => {
    expect(toSeconds(1500)).toBe(1.5);
    for (const value of [-1, 999999999999, true, [], {}, '  ', '0x10', null, undefined]) {
      expect(toSeconds(value), String(value)).toBeNull();
    }
  });
});

describe('分页：两个信号源与刹车', () => {
  it('extra 的 next_query_danmaku_list_time 推进游标并合并两页', async () => {
    const starts: number[] = [];
    const transport = async (_url: string, body: string) => {
      starts.push(JSON.parse(body).business_param.start_offset_time);
      return starts.length === 1
        ? respond(
            page({ rows: [comment({ offsetMs: 1000 })], extra: { next_query_danmaku_list_time: '5000' } }),
          )
        : respond(page({ rows: [comment({ text: '第二页', offsetMs: 6000 })] }));
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(starts).toEqual([0, 5000]);
    expect(result.items.map((item: any) => item.text)).toEqual(['好家伙', '第二页']);
  });

  it('extra 为空时靠 common_list_info 的 has_more 与 cursor 继续翻页', async () => {
    const starts: number[] = [];
    const transport = async (_url: string, body: string) => {
      starts.push(JSON.parse(body).business_param.start_offset_time);
      return starts.length === 1
        ? respond(page({ rows: [comment()], info: { has_more: true, cursor: { end_offset_time: 9000 } } }))
        : respond(page({ rows: [comment({ text: '末页', offsetMs: 9000 })] }));
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(starts).toEqual([0, 9000]);
    expect(result.items.map((item: any) => item.text)).toEqual(['好家伙', '末页']);
  });

  it('has_more=false 时即便带 cursor 也立刻停止', async () => {
    const transport = vi.fn(async () =>
      respond(page({ rows: [comment()], info: { has_more: false, cursor: { end_offset_time: 900000 } } })),
    );
    await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('连续空页立刻收口，不会把整集翻满', async () => {
    const transport = vi.fn(async () =>
      // 上游偶尔「声称还有更多」却一直给空页，参考实现实测踩过。
      respond(
        page({
          rows: [],
          extra: { next_query_danmaku_list_time: String(transport.mock.calls.length * 100000) },
        }),
      ),
    );
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(transport.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.success).toBe(false);
    expect(result.notice).not.toMatch(/暂无弹幕/);
  });

  it('游标不前进时标注截断，不谎称「全部载入」', async () => {
    const transport = vi.fn(async () =>
      respond(page({ rows: [comment()], info: { has_more: true, cursor: { end_offset_time: 1000 } } })),
    );
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
  });

  it('分页上限 40 页封顶并标注截断', async () => {
    const starts: number[] = [];
    const transport = async (_url: string, body: string) => {
      const start = JSON.parse(body).business_param.start_offset_time;
      starts.push(start);
      return respond(
        page({
          rows: [comment({ offsetMs: start + 1000 })],
          info: { has_more: true, cursor: { end_offset_time: start + 1000 } },
        }),
      );
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(starts).toHaveLength(40);
    expect(result.truncated).toBe(true);
  }, 30000);
});

describe('清洗与上限', () => {
  it('超长文本被丢，控制字符换成空格，按（时间, 文本）去重', async () => {
    const transport = async () =>
      respond(
        page({
          rows: [
            comment({ text: 'x'.repeat(300) }),
            comment({ text: '前\u0000后' }),
            comment({ text: '前 后' }),
            comment({ text: '这条要留下' }),
          ],
        }),
      );
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(result.items.map((item: any) => item.text)).toEqual(['前 后', '这条要留下']);
  });

  it('结果按时间升序，毫秒换算成秒', async () => {
    const transport = async () =>
      respond(
        page({
          rows: [comment({ offsetMs: 3000 }), comment({ offsetMs: 1000 }), comment({ offsetMs: 2000 })],
        }),
      );
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(result.items.map((item: any) => item.time)).toEqual([1, 2, 3]);
    expect(result.items[0].mode).toBe('scroll');
  });

  it('单集最多 3000 条，单页超量也不越界', async () => {
    const rows = Array.from({ length: 3005 }, (_, index) => comment({ offsetMs: index * 1000 }));
    const result = await fetchDanmaku({
      seriesId: SERIES,
      vid: VID,
      ...fixed(async () => respond(page({ rows }))),
    });
    expect(result.items).toHaveLength(3000);
    expect(result.total).toBe(3000);
    expect(result.truncated).toBe(true);
  });
});

describe('缓存语义：失败不能被洗成「本集暂无弹幕」', () => {
  it('源不可用时说清发生了什么，绝不改口成「暂无弹幕」', async () => {
    const transport = async () => {
      throw Object.assign(new Error('boom'), { response: { status: 502 } });
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(result.success).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.notice).toMatch(/HTTP 502/);
    expect(result.notice).toMatch(/已尝试官方签名请求/);
    expect(result.notice).not.toMatch(/暂无弹幕/);
  });

  it('失败结果命中短缓存时仍然如实报告失败', async () => {
    const transport = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { response: { status: 502 } });
    });
    const options = { seriesId: SERIES, vid: VID, ...fixed(transport) };
    const first = await fetchDanmaku(options);
    const second = await fetchDanmaku(options);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(second.success).toBe(false);
    expect(second.notice).toBe(first.notice);
    expect(second.notice).not.toMatch(/暂无弹幕/);
  });

  it('刷新绕过失败缓存；limit 只裁剪呈现，不污染缓存也不跨集串用', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return respond(page({ rows: [comment(), comment({ offsetMs: 2000 })] }));
    };
    const options = { seriesId: SERIES, vid: VID, ...fixed(transport) };
    expect((await fetchDanmaku(options)).success).toBe(false);
    expect((await fetchDanmaku({ ...options, fresh: true, limit: 1 })).items).toHaveLength(1);
    expect((await fetchDanmaku(options)).items).toHaveLength(2);
    expect(calls).toBe(2);
    const other = await fetchDanmaku({ ...options, vid: '7503780577347128382' });
    expect(calls).toBe(3);
    expect(other.items).toHaveLength(0);
  });

  it('并发调用合并在途请求，只打一次上游', async () => {
    const transport = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return respond(page({ rows: [comment()] }));
    });
    const options = { seriesId: SERIES, vid: VID, ...fixed(transport) };
    const [first, second] = await Promise.all([fetchDanmaku(options), fetchDanmaku(options)]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(second.items).toEqual(first.items);
  });

  it('部分成功后中断：保留已获取的部分并注明中断', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1)
        return respond(page({ rows: [comment()], extra: { next_query_danmaku_list_time: '5000' } }));
      throw new Error('net');
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(result.items).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.notice).toMatch(/后续弹幕加载中断/);
  });

  it('limit 只裁剪条数，不改变失败说明', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1)
        return respond(
          page({
            rows: [1, 2, 3].map((index) => comment({ offsetMs: index * 1000, text: `第${index}条` })),
            extra: { next_query_danmaku_list_time: '9000' },
          }),
        );
      throw new Error('net');
    };
    const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, limit: 2, ...fixed(transport) });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.notice).toMatch(/后续弹幕加载中断/);
  });
});

describe('报文契约', () => {
  it('请求地址、请求体与签名头符合接口要求', async () => {
    let captured: any;
    const transport = async (url: string, body: string, config: any) => {
      captured = { url, body: JSON.parse(body), config };
      return respond(page({ rows: [] }));
    };
    await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(transport) });
    expect(captured.url).toMatch(
      /^https:\/\/api5-normal-sinfonlineb\.fqnovel\.com\/novel\/commentapi\/comment\/list\/\d+\/v1\/\?/,
    );
    expect(captured.body).toMatchObject({
      group_id: VID,
      comment_source: 601,
      group_type: 30,
      comment_type: 20,
    });
    expect(captured.body.business_param.book_id).toBe(SERIES);
    for (const name of ['X-Gorgon', 'X-Argus', 'X-Ladon']) expect(captured.config.headers[name]).toBeTruthy();
    expect(captured.config.headers['X-SS-STUB']).toBe('');
    expect(captured.config.headers['Comment-Source']).toBe('601');
  });

  it('请求有超时、响应上限与禁止重定向，且不带 cookie 或代理', async () => {
    await fetchDanmaku({
      seriesId: SERIES,
      vid: VID,
      ...fixed(async (_url: string, _body: string, config: any) => {
        expect(config.maxRedirects).toBe(0);
        expect(config.timeout).toBe(20000);
        expect(config.signal).toBeInstanceOf(AbortSignal);
        expect(config.maxContentLength).toBe(8 * 1024 * 1024);
        expect(config.proxy).toBeUndefined();
        expect(config.headers.Cookie).toBeUndefined();
        return respond(page());
      }),
    });
  });

  it('参数非法时直接拒绝，不发请求', async () => {
    const transport = vi.fn();
    for (const options of [
      null,
      [],
      'x',
      1,
      {},
      { seriesId: Number(SERIES), vid: VID },
      { seriesId: SERIES, vid: VID, limit: 0 },
      { seriesId: SERIES, vid: VID, limit: 3001 },
      { seriesId: SERIES, vid: VID, limit: '2' },
      { seriesId: SERIES, vid: VID, fresh: 'true' },
    ]) {
      const result = await fetchDanmaku(options);
      expect(result.success, JSON.stringify(options)).toBe(false);
      expect(result.source).toBe('official');
      expect(result.items).toEqual([]);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('无效响应与上游错误都不暴露签名，也不伪装成没有弹幕', async () => {
    for (const data of [
      'null',
      '{}',
      JSON.stringify({ code: 0, data: {} }),
      JSON.stringify({ code: 'private-signature', data: { data_list: [] } }),
      'x'.repeat(8 * 1024 * 1024 + 1),
    ]) {
      resetDanmakuCache();
      const result = await fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixed(async () => ({ data })) });
      expect(result.success, data.slice(0, 20)).toBe(false);
      expect(result.notice).not.toMatch(/暂无弹幕|private-signature/);
    }
    resetDanmakuCache();
    const leaked = await fetchDanmaku({
      seriesId: SERIES,
      vid: VID,
      ...fixed(async () => {
        throw new Error('https://private?device_id=secret&signature=secret');
      }),
    });
    expect(leaked.notice).not.toMatch(/device_id|signature|secret/);
  });
});
