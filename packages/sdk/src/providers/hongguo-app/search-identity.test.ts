/**
 * App 搜索的身份与签名（迁移自 4.5 `src/native/hongguo-app-search.test.cjs` 的身份部分）。
 *
 * 已有 `search-paging.test.ts` 压的是游标与分页。这里补的是「签名用的到底是谁的身份」：
 * 必须用**已注册的**匿名设备身份签名（未注册就直接失败，不能编一个临时身份发出去），
 * 每次搜索都复用同一份注册结果，游标里的偏移非法时退回按页码推算的偏移，
 * 并且请求头必须成套带齐签名（缺一个就会被上游拒）。
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  failRegistration: false,
  registrations: 0,
}));

// 只替身「设备注册接口」这一个外部依赖；签名、解析、校验全走生产代码。
vi.mock('./ticket.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ticket.ts')>();
  return {
    ...actual,
    requestJson: async () => {
      state.registrations += 1;
      if (state.failRegistration)
        throw Object.assign(new Error('registration unavailable'), { code: 'ECONNRESET' });
      return {
        code: 0,
        device_id_str: '7000000000000000001',
        install_id_str: '7000000000000000002',
      };
    },
  };
});

/** 设备身份是模块级单例：每个用例拿一份干净模块，避免注册结果串场。 */
async function load() {
  vi.resetModules();
  const search = await import('./search.ts');
  const ticket = await import('./ticket.ts');
  state.failRegistration = false;
  state.registrations = 0;
  return { searchApp: search.searchApp, signedSearchRequest: ticket.signedSearchRequest };
}

const payload = {
  code: 0,
  search_tabs: [
    {
      tab_type: 11,
      has_more: true,
      next_offset: 20,
      search_id: 'sid-1',
      passback: 'pb-1',
      data: [
        {
          search_high_light: { title: { text: '测试短剧' } },
          video_data: [{ series_id: '123', cover: 'https://img.example/a.jpg' }],
        },
      ],
    },
  ],
};

describe('App 搜索：签名身份来自已注册设备', () => {
  it('请求里带的是注册返回的身份，两页共用同一份注册结果', async () => {
    const { searchApp } = await load();
    const urls: string[] = [];
    for (const page of [1, 2]) {
      await searchApp('测试短剧', {
        page,
        cursor: { search_id: 'sid-1', next_offset: (page - 1) * 20 },
        request: async (signed: { url: string }) => {
          urls.push(signed.url);
          return payload;
        },
        deadline: Date.now() + 5_000,
      });
    }
    expect(state.registrations).toBe(1);
    for (const url of urls) {
      const query = new URL(url).searchParams;
      expect(query.get('device_id')).toBe('7000000000000000001');
      expect(query.get('iid')).toBe('7000000000000000002');
      expect(query.get('cdid')).toMatch(/^[0-9a-f-]{36}$/i);
      expect(query.get('query')).toBe('测试短剧');
    }
  });

  it('设备注册失败时不发搜索请求，也不会用临时身份兜底', async () => {
    const { searchApp } = await load();
    state.failRegistration = true;
    const request = vi.fn();
    await expect(searchApp('测试短剧', { request, deadline: Date.now() + 5_000 })).rejects.toMatchObject({
      code: 'DEVICE_REGISTRATION_FAILED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('身份非法时连签名都不生成', async () => {
    const { signedSearchRequest } = await load();
    for (const identity of [
      undefined,
      {},
      { device_id: '0', iid: '0', cdid: '0' },
      { device_id: 9007199254740992, iid: '1', cdid: '0b9c1a2e-1111-2222-3333-444455556666' },
      { device_id: '1', iid: '1', cdid: 'not-a-uuid' },
    ]) {
      expect(() => signedSearchRequest({ keyword: '测试短剧', identity })).toThrowError(
        expect.objectContaining({ code: 'APP_INPUT' }),
      );
    }
  });

  it('签名头成套带齐，且不带请求体', async () => {
    const { searchApp } = await load();
    let captured: any;
    await searchApp('测试短剧', {
      request: async (signed: any, deadline: number) => {
        captured = { signed, deadline };
        return payload;
      },
      deadline: Date.now() + 5_000,
    });
    expect(captured.deadline).toBeGreaterThan(Date.now());
    expect(captured.signed.url).toMatch(/reading\/bookapi\/search\/tab\/v\?/);
    for (const name of ['x-gorgon', 'x-medusa', 'x-ladon', 'x-argus', 'x-helios', 'x-ss-req-ticket']) {
      expect(captured.signed.headers[name], name).toBeTruthy();
    }
    expect(captured.signed.headers['content-type']).toBeUndefined();
    expect(captured.signed.body).toBeUndefined();
  });
});

const identity = {
  device_id: '7000000000000000001',
  iid: '7000000000000000002',
  cdid: '0b9c1a2e-1111-2222-3333-444455556666',
};

describe('App 搜索：偏移与游标', () => {
  it('游标偏移非法时退回按页码推算，绝不把坏偏移发出去', async () => {
    const { searchApp, signedSearchRequest } = await load();
    const offsets: Array<string | null> = [];
    for (const next_offset of [null, undefined, '', '  ', false, true, [], {}, -1, 1.5, '1.5', 1e18]) {
      const signed = signedSearchRequest({
        keyword: '测试短剧',
        page: 3,
        cursor: { search_id: 'sid-1', next_offset },
        identity,
      }) as { url: string };
      offsets.push(new URL(signed.url).searchParams.get('offset'));
      await searchApp('测试短剧', {
        page: 3,
        cursor: { search_id: 'sid-1', next_offset },
        request: async (request: { url: string }) => {
          expect(new URL(request.url).searchParams.get('offset')).toBe('40');
          return payload;
        },
        deadline: Date.now() + 5_000,
      });
    }
    expect(new Set(offsets)).toEqual(new Set(['40']));
  });

  it('只有搜索 id 没有偏移时，后一页仍然推进（不能原地打转）', async () => {
    const { searchApp } = await load();
    for (const page of [2, 3]) {
      const result = await searchApp('测试短剧', {
        page,
        cursor: { search_id: 'sid-1', next_offset: null },
        request: async (signed: { url: string }) => {
          expect(new URL(signed.url).searchParams.get('offset')).toBe(String((Number(page) - 1) * 20));
          return payload;
        },
        deadline: Date.now() + 5_000,
      });
      expect(result.page).toBe(Number(page));
    }
  });

  it('偏移为 0 时如实使用 0，而不是当成「没有偏移」', async () => {
    const { signedSearchRequest } = await load();
    for (const next_offset of [0, '0', 40, '40']) {
      const signed = signedSearchRequest({
        keyword: '测试短剧',
        page: 2,
        cursor: { search_id: 'sid-1', next_offset },
        identity,
      }) as { url: string };
      expect(new URL(signed.url).searchParams.get('offset')).toBe(String(Number(next_offset)));
    }
  });
});
