/**
 * 远程公告的抑制、投机与手动查看（迁移自 4.5 `src/native/app-announcements.test.cjs`）。
 *
 * 已有 `announcements.test.ts` 压的是「新紧急公告只推一次」。这里补它没压的整套规则：
 * 普通公告每进程只取一次、按本地日/版本抑制、紧急公告未读优先且必须显式确认、
 * 5 分钟节流（失败也算一次）、关闭开关后一个请求都不发、开关切换瞬间的在飞响应必须丢弃、
 * 手动查看不受任何自动规则影响但也不改动已读状态。
 * 5.0 目前没有「公告开关」与「确认已读」两条 IPC（见报告遗留），服务层行为仍按 4.5 压住。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../storage/store.ts';
import { createAnnouncementService } from './announcements.ts';

const NORMAL = 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/normal.json';
const EMERGENCY =
  'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/emergency.json';

const notice = (id = 'notice-1', active = true) => ({
  id,
  title: '播放提示',
  body: '平台接口、设备校验或网络可能影响播放。',
  active,
});
const response = (data: unknown) => ({
  status: 200,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  data: JSON.stringify(data),
});

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture(initial: Record<string, any> = {}) {
  let state = structuredClone(initial) as Record<string, any>;
  let clock = new Date(2026, 9, 27, 12).getTime();
  let enabled = true;
  let failSave = false;
  let normalResponse: any = response(notice('normal-1'));
  let emergencyResponse: any = response(notice('emergency-1', false));
  const calls: Array<{ url: string; config: any }> = [];
  const store = {
    getAnnouncementState: () => structuredClone(state),
    saveAnnouncementState: (patch: Record<string, unknown>) => {
      if (failSave) throw new Error('EACCES /private/user-data');
      state = { ...state, ...structuredClone(patch) };
    },
  };
  const make = (version = '3.9.0', extra: Record<string, unknown> = {}) =>
    createAnnouncementService({
      store,
      version,
      now: () => clock,
      isEnabled: () => enabled,
      request: async (url: string, config: any) => {
        calls.push({ url, config });
        const result = url === NORMAL ? normalResponse : emergencyResponse;
        if (result instanceof Error) throw result;
        return result;
      },
      ...extra,
    } as never);
  return {
    make,
    calls,
    service: make(),
    get state() {
      return structuredClone(state);
    },
    set now(value: number) {
      clock = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    set failSave(value: boolean) {
      failSave = value;
    },
    set normal(value: any) {
      normalResponse = value;
    },
    set emergency(value: any) {
      emergencyResponse = value;
    },
  };
}

const urls = (calls: Array<{ url: string }>) => calls.map((call) => call.url);

describe('普通公告：每进程一次，紧急轮询不初始化它', () => {
  it('只轮询紧急时从不请求普通公告', async () => {
    const f = fixture();
    expect(await f.service.checkAnnouncements({ urgentOnly: true })).toEqual({ announcement: null });
    expect(urls(f.calls)).toEqual([EMERGENCY]);
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement).toMatchObject({
      id: 'normal-1',
      urgent: false,
    });
    await f.service.checkAnnouncements({ urgentOnly: false });
    f.advance(300000);
    await f.service.checkAnnouncements({ urgentOnly: true });
    expect(f.calls.filter((call) => call.url === NORMAL)).toHaveLength(1);
    expect(f.calls.filter((call) => call.url === EMERGENCY)).toHaveLength(2);
  });

  it('普通请求失败不在进程内重试，但紧急失败不遮蔽普通公告', async () => {
    const f = fixture();
    f.normal = new Error('offline');
    f.emergency = new Error('offline');
    expect(await f.service.checkAnnouncements({ urgentOnly: false })).toEqual({ announcement: null });
    f.advance(300000);
    await f.service.checkAnnouncements({ urgentOnly: false });
    expect(f.calls.filter((call) => call.url === NORMAL)).toHaveLength(1);

    const next = fixture();
    next.emergency = new Error('offline');
    expect((await next.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('normal-1');
  });

  it('并发轮询共享两个请求', async () => {
    const f = fixture();
    const pending = deferred();
    f.emergency = pending.promise;
    const results = Promise.all([
      f.service.checkAnnouncements({ urgentOnly: false }),
      f.service.checkAnnouncements({ urgentOnly: false }),
      f.service.checkAnnouncements({ urgentOnly: true }),
    ]);
    await Promise.resolve();
    expect(f.calls).toHaveLength(2);
    pending.resolve(response(notice('emergency-1')));
    for (const result of await results) expect(result.announcement.id).toBe('emergency-1');
  });
});

describe('抑制：按本地日与版本', () => {
  it('按日免提醒当天不请求普通公告，跨本地日与升级后恢复', async () => {
    const f = fixture();
    expect(f.service.dismissAnnouncement({ mode: 'day' })).toEqual({ success: true });
    expect((await f.make().checkAnnouncements({ urgentOnly: false })).announcement).toBeNull();
    expect(f.calls.some((call) => call.url === NORMAL)).toBe(false);
    f.now = new Date(2026, 9, 28, 0, 0, 1).getTime();
    expect((await f.make().checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('normal-1');
    f.now = new Date(2026, 9, 27, 13).getTime();
    expect((await f.make('4.0.0').checkAnnouncements({ urgentOnly: false })).announcement.id).toBe(
      'normal-1',
    );
  });

  it('按版本免提醒跨天仍生效，升级后恢复，且不动已读紧急公告', async () => {
    const f = fixture({ seenUrgentIds: ['old-emergency'] });
    expect(f.service.dismissAnnouncement({ mode: 'version' })).toEqual({ success: true });
    f.now = new Date(2026, 10, 1).getTime();
    expect((await f.make().checkAnnouncements({ urgentOnly: false })).announcement).toBeNull();
    expect(f.calls.some((call) => call.url === NORMAL)).toBe(false);
    expect((await f.make('4.0.0').checkAnnouncements({ urgentOnly: false })).announcement.id).toBe(
      'normal-1',
    );
    expect(f.state.seenUrgentIds).toEqual(['old-emergency']);
  });

  it('免提醒方式非法时拒绝且不落盘', () => {
    const f = fixture();
    for (const payload of [null, {}, { mode: 'forever' }, { mode: 'WEEK' }]) {
      expect(f.service.dismissAnnouncement(payload).success, JSON.stringify(payload)).toBe(false);
    }
    expect(f.state).toEqual({});
  });
});

describe('紧急公告：未读优先，读取不等于已读', () => {
  it('未读紧急公告压过普通公告，且轮询本身不标记已读', async () => {
    const f = fixture();
    f.emergency = response(notice('emergency-1'));
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.urgent).toBe(true);
    expect(f.state).toEqual({});
  });

  it('只接受真正投递过的紧急公告确认，确认后不再出现，换新 id 继续投递', async () => {
    const f = fixture();
    f.emergency = response(notice('emergency-1'));
    await f.service.checkAnnouncements({ urgentOnly: false });
    f.service.dismissAnnouncement({ mode: 'version' });
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id).toBe('emergency-1');
    expect(f.service.acknowledgeAnnouncement({ id: 'not-delivered' }).success).toBe(false);
    expect(f.service.acknowledgeAnnouncement({ id: 'normal-1' }).success).toBe(false);
    expect(f.service.acknowledgeAnnouncement({ id: 'emergency-1' })).toEqual({ success: true });
    f.advance(86400000);
    expect((await f.make('4.0.0').checkAnnouncements({ urgentOnly: true })).announcement).toBeNull();
    f.emergency = response(notice('emergency-2'));
    expect((await f.make().checkAnnouncements({ urgentOnly: true })).announcement.id).toBe('emergency-2');
  });

  it('紧急确认后普通公告仍然可用，且不重复请求普通公告', async () => {
    const f = fixture();
    f.emergency = response(notice('emergency-1'));
    await f.service.checkAnnouncements({ urgentOnly: false });
    f.service.acknowledgeAnnouncement({ id: 'emergency-1' });
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('normal-1');
    expect(f.calls.filter((call) => call.url === NORMAL)).toHaveLength(1);
  });

  it('5 分钟节流对失败同样生效（失败也算一次尝试）', async () => {
    const f = fixture();
    f.emergency = new Error('offline');
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement).toBeNull();
    const afterFailure = f.calls.length;
    f.advance(299999);
    await f.service.checkAnnouncements({ urgentOnly: true });
    expect(f.calls).toHaveLength(afterFailure);
    f.advance(1);
    await f.service.checkAnnouncements({ urgentOnly: true });
    expect(f.calls).toHaveLength(afterFailure + 1);
  });
});

describe('响应校验与请求配置', () => {
  it('只接受严格四字段、长度受控的纯 JSON；其余一律当作没有公告', async () => {
    const invalid = [
      response(null),
      response([]),
      response({ ...notice(), active: 'true' }),
      response({ ...notice(), id: '' }),
      response({ ...notice(), id: 'a'.repeat(129) }),
      response({ ...notice(), title: 'x'.repeat(121) }),
      response({ ...notice(), body: 'x'.repeat(4001) }),
      response({ ...notice(), title: '   ' }),
      response({ ...notice(), title: 'a\nb' }),
      response({ ...notice(), body: 'bad\u0000text' }),
      response({ ...notice(), body: '<script>alert(1)</script>' }),
      response({ ...notice(), urgent: true }),
      response({ ...notice(), url: 'https://other.example' }),
      response(notice('inactive', false)),
      { ...response(notice()), status: 302 },
      { ...response(notice()), headers: { 'content-type': 'text/html' } },
      { ...response(notice()), data: '<html>not JSON</html>' },
      { ...response(notice()), data: '{' },
      { ...response(notice()), data: ' '.repeat(32769) },
    ];
    for (const payload of invalid) {
      const f = fixture();
      f.normal = payload;
      f.emergency = payload;
      expect(
        await f.service.checkAnnouncements({ urgentOnly: false }),
        JSON.stringify(payload).slice(0, 40),
      ).toEqual({ announcement: null });
    }
  });

  it('请求是固定匿名 HTTPS：短超时、禁止重定向、响应上限、只要 JSON', async () => {
    const f = fixture();
    await f.service.checkAnnouncements({ urgentOnly: false });
    expect(f.calls).toHaveLength(2);
    for (const { url, config } of f.calls) {
      expect([NORMAL, EMERGENCY]).toContain(url);
      expect(config.timeout).toBeGreaterThan(0);
      expect(config.timeout).toBeLessThanOrEqual(6000);
      expect(config.maxRedirects).toBe(0);
      expect(config.maxContentLength).toBeLessThanOrEqual(32768);
      expect(config.responseType).toBe('text');
      expect(config.validateStatus(200)).toBe(true);
      expect(config.validateStatus(302)).toBe(false);
      expect(config.validateStatus(500)).toBe(false);
      expect(config.headers.Accept).toBe('application/json');
      expect(config.params).toBeUndefined();
      expect(config.auth).toBeUndefined();
      expect(config.data).toBeUndefined();
      expect(config.headers.Authorization).toBeUndefined();
    }
  });
});

describe('开关：关掉就是一个请求都不发', () => {
  it('环境不允许（预览/代理兜底）时自动与手动都不发请求', async () => {
    const f = fixture();
    f.enabled = false;
    expect(await f.service.checkAnnouncements({ urgentOnly: false })).toEqual({ announcement: null });
    expect(await f.service.checkAnnouncements({ urgentOnly: true })).toEqual({ announcement: null });
    const manual = (await f.service.getCurrentAnnouncement()) as any;
    expect(manual.announcement).toBeNull();
    expect(manual.error).toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });

  it('偏好默认开；落盘为关时跨版本保持关，且只按开启的通道请求', async () => {
    const f = fixture();
    expect(f.service.getAnnouncementPreferences()).toEqual({ normalEnabled: true, emergencyEnabled: true });
    expect(f.service.setAnnouncementPreferences({ normalEnabled: false, emergencyEnabled: false })).toEqual({
      success: true,
      preferences: { normalEnabled: false, emergencyEnabled: false },
    });
    const upgraded = f.make('4.0.0');
    expect(upgraded.getAnnouncementPreferences()).toEqual({ normalEnabled: false, emergencyEnabled: false });
    expect((await upgraded.checkAnnouncements({ urgentOnly: false })).announcement).toBeNull();
    expect(f.calls).toHaveLength(0);

    const onlyNormal = fixture({ preferences: { normalEnabled: true, emergencyEnabled: false } });
    onlyNormal.emergency = response(notice('emergency-1'));
    expect((await onlyNormal.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe(
      'normal-1',
    );
    expect(urls(onlyNormal.calls)).toEqual([NORMAL]);
  });

  it('关闭普通公告时不初始化「一次性」请求，重新打开才有第一次请求', async () => {
    const f = fixture({ preferences: { normalEnabled: false, emergencyEnabled: false } });
    await f.service.checkAnnouncements({ urgentOnly: false });
    f.service.setAnnouncementPreferences({ normalEnabled: true });
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('normal-1');
    f.service.setAnnouncementPreferences({ normalEnabled: false });
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement).toBeNull();
    f.service.setAnnouncementPreferences({ normalEnabled: true });
    f.normal = response(notice('must-not-refetch'));
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('normal-1');
    expect(f.calls).toHaveLength(1);
  });

  it('关掉再打开的瞬间，在飞响应必须丢弃（不能因为开关回弹就把迟到数据当有效）', async () => {
    for (const channel of ['normalEnabled', 'emergencyEnabled'] as const) {
      const f = fixture();
      const pending = deferred();
      if (channel === 'normalEnabled') f.normal = pending.promise;
      else f.emergency = pending.promise;
      const check = f.service.checkAnnouncements({ urgentOnly: channel === 'emergencyEnabled' });
      await Promise.resolve();
      f.service.setAnnouncementPreferences({ [channel]: false });
      f.service.setAnnouncementPreferences({ [channel]: true });
      pending.resolve(response(notice('late')));
      expect((await check).announcement).toBeNull();
      expect(f.service.acknowledgeAnnouncement({ id: 'late' }).success).toBe(false);
    }
  });

  it('开关保存失败时保留原偏好并报安全错误；非法开关被拒', () => {
    const f = fixture({
      seenUrgentIds: ['keep'],
      preferences: { normalEnabled: true, emergencyEnabled: false },
    });
    const original = f.state;
    f.failSave = true;
    expect(f.service.setAnnouncementPreferences({ normalEnabled: false }).success).toBe(false);
    expect(f.state).toEqual(original);
    expect(f.service.getAnnouncementPreferences()).toEqual(original.preferences);
    f.failSave = false;
    for (const payload of [null, [], { normalEnabled: 'false' }, { other: false }]) {
      expect(f.service.setAnnouncementPreferences(payload).success, JSON.stringify(payload)).toBe(false);
    }
    expect(f.service.acknowledgeAnnouncement(null).success).toBe(false);
  });
});

describe('确认已读与免提醒的落盘失败', () => {
  it('保存失败时报告安全错误、当次运行内不再显示，下次保存能落盘全部已读', async () => {
    const f = fixture({ unrelated: 'keep' });
    f.emergency = response(notice('emergency-1'));
    await f.service.checkAnnouncements({ urgentOnly: true });
    f.failSave = true;
    const result = f.service.acknowledgeAnnouncement({ id: 'emergency-1' }) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/\/private\//);
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement).toBeNull();
    expect(f.state).toEqual({ unrelated: 'keep' });
    f.failSave = false;
    expect(f.service.acknowledgeAnnouncement({ id: 'emergency-1' }).success).toBe(true);
    expect(f.state.seenUrgentIds).toEqual(['emergency-1']);
    expect((await f.make('4.0.0').checkAnnouncements({ urgentOnly: true })).announcement).toBeNull();
  });

  it('免提醒写盘失败时不改数据', () => {
    const f = fixture({ seenUrgentIds: ['keep'] });
    const original = f.state;
    f.failSave = true;
    const result = f.service.dismissAnnouncement({ mode: 'day' }) as any;
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/\/private\//);
    expect(f.state).toEqual(original);
  });
});

describe('手动查看：只读，不参与任何自动规则', () => {
  it('无视开关与抑制拿到当前公告，且不改偏好与已读状态', async () => {
    for (const mode of ['day', 'version'] as const) {
      const f = fixture({
        preferences: { normalEnabled: false, emergencyEnabled: false },
        seenUrgentIds: ['manual-urgent'],
      });
      f.service.dismissAnnouncement({ mode });
      const before = f.state;
      f.emergency = response(notice('manual-urgent'));
      expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-urgent');
      expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-urgent');
      expect(f.state).toEqual(before);
      f.emergency = response(notice('inactive', false));
      expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('normal-1');
      expect(f.state).toEqual(before);
    }
  });

  it('手动看到的紧急公告可以确认，也不影响再次手动查看', async () => {
    const f = fixture();
    f.emergency = response(notice('manual-urgent'));
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-urgent');
    expect(f.state).toEqual({});
    expect(f.service.acknowledgeAnnouncement({ id: 'manual-urgent' })).toEqual({ success: true });
    expect(f.state.seenUrgentIds).toEqual(['manual-urgent']);
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement).toBeNull();
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-urgent');
    expect(f.state.seenUrgentIds).toEqual(['manual-urgent']);
  });

  it('手动查看既不消耗也不替换自动的那次普通请求', async () => {
    const f = fixture({ preferences: { normalEnabled: true, emergencyEnabled: false } });
    f.normal = response(notice('manual-before'));
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-before');
    f.normal = response(notice('automatic'));
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('automatic');
    f.normal = response(notice('manual-after'));
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('manual-after');
    expect((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id).toBe('automatic');
    expect(f.calls.filter((call) => call.url === NORMAL)).toHaveLength(3);
  });

  it('手动查看不重置自动紧急轮询的节流窗口', async () => {
    const f = fixture();
    f.emergency = response(notice('urgent-1'));
    await f.service.getCurrentAnnouncement();
    await f.service.checkAnnouncements({ urgentOnly: true });
    expect(f.calls.filter((call) => call.url === EMERGENCY)).toHaveLength(2);
    f.advance(299999);
    f.emergency = response(notice('urgent-2'));
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('urgent-2');
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id).toBe('urgent-1');
    expect(f.calls.filter((call) => call.url === EMERGENCY)).toHaveLength(3);
    f.advance(1);
    expect((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id).toBe('urgent-2');
  });

  it('并发手动查看共享请求，下一次手动查看取新数据', async () => {
    const f = fixture();
    const pending = deferred();
    f.normal = pending.promise;
    f.emergency = pending.promise;
    const first = f.service.getCurrentAnnouncement();
    const second = f.service.getCurrentAnnouncement();
    expect(urls(f.calls).sort()).toEqual([NORMAL, EMERGENCY].sort());
    pending.resolve(response(notice('urgent-shared')));
    for (const result of await Promise.all([first, second]))
      expect(result.announcement.id).toBe('urgent-shared');
    f.emergency = response(notice('urgent-fresh'));
    expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('urgent-fresh');
    expect(f.calls).toHaveLength(4);
  });

  it('手动查看遇到空/失败/非法响应时给出可读错误，允许重试', async () => {
    for (const payload of [
      response(notice('inactive', false)),
      new Error('offline /private/secret'),
      { ...response(null), data: '{' },
      response({ ...notice(), extra: true }),
      response({ ...notice(), body: '<script>bad</script>' }),
      { ...response(notice()), data: ' '.repeat(32769) },
    ]) {
      const f = fixture();
      f.normal = payload;
      f.emergency = payload;
      const result = (await f.service.getCurrentAnnouncement()) as any;
      expect(result.announcement).toBeNull();
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toMatch(/\/private\//);
      expect(f.state).toEqual({});
      f.normal = response(notice('recovered'));
      expect((await f.service.getCurrentAnnouncement()).announcement.id).toBe('recovered');
    }
  });

  it('请求中途环境变为不可用（预览/代理）时丢弃迟到响应，也不记已读', async () => {
    const f = fixture();
    f.enabled = true;
    const pending = deferred();
    f.emergency = pending.promise;
    const check = f.service.getCurrentAnnouncement();
    f.enabled = false;
    pending.resolve(response(notice('blocked-urgent')));
    const late = (await check) as any;
    expect(late.announcement).toBeNull();
    expect(late.error).toBeTruthy();
    expect(f.service.acknowledgeAnnouncement({ id: 'blocked-urgent' }).success).toBe(false);
    expect(f.state).toEqual({});
  });
});

describe('仓库内公告文件', () => {
  it('普通与紧急公告都能过服务解析器，紧急公告默认不激活', async () => {
    const root = path.resolve(__dirname, '../../../../../announcements');
    for (const channel of ['normal', 'emergency']) {
      const raw = fs.readFileSync(path.join(root, `${channel}.json`), 'utf8');
      const data = JSON.parse(raw);
      expect(typeof data.active).toBe('boolean');
      if (channel === 'emergency') expect(data.active).toBe(false);
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(32768);
      const f = fixture({
        preferences: { normalEnabled: channel === 'normal', emergencyEnabled: channel === 'emergency' },
      });
      const options = { urgentOnly: channel === 'emergency' };
      const expected = {
        id: data.id,
        title: data.title.trim(),
        body: data.body.trim(),
        urgent: options.urgentOnly,
      };
      if (channel === 'normal') f.normal = { ...response(null), data: raw };
      else f.emergency = { ...response(null), data: raw };
      expect((await f.service.checkAnnouncements(options)).announcement).toEqual(
        data.active ? expected : null,
      );
      if (!data.active) {
        const activated = response({ ...data, active: true });
        if (channel === 'normal') f.normal = activated;
        else f.emergency = activated;
        expect((await f.make().checkAnnouncements(options)).announcement).toEqual(expected);
      }
    }
  });
});

describe('健壮性：推送与入参', () => {
  it('推送回调抛错不影响轮询结果', async () => {
    const f = fixture();
    f.emergency = response(notice('emergency-1'));
    const withHook = f.make('3.9.0', {
      onAnnouncement: () => {
        throw new Error('渲染层已销毁');
      },
    });
    expect((await withHook.checkAnnouncements({ urgentOnly: true })).announcement.id).toBe('emergency-1');
  });

  it('轮询参数非法时按没有公告处理，不抛异常', async () => {
    const f = fixture();
    for (const options of [null, [], { urgentOnly: 'yes' }]) {
      expect(await f.service.checkAnnouncements(options as never)).toEqual({ announcement: null });
    }
  });
});

const storeDirs: string[] = [];
afterEach(() => {
  for (const dir of storeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function storeFile(content?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-announcement-store-'));
  storeDirs.push(dir);
  const file = path.join(dir, 'data.json');
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('公告状态的落盘：与设置互不覆盖，失败保留原文件', () => {
  it('公告补丁不牵动设置/任务/播放进度，过期的设置对象回存也压不掉公告', () => {
    const original = {
      settings: { root: '/keep', app_updates_enabled: false },
      tasks: [{ id: 'download' }],
      playback: { series: { time: 12 } },
    };
    const file = storeFile(original);
    const store = createStore();
    store.init(file);
    const staleSettings = { ...store.getSettings() };
    store.saveAnnouncementState({
      seenUrgentIds: ['keep'],
      preferences: { normalEnabled: false, emergencyEnabled: true },
    });
    store.saveSettings(staleSettings);
    store.saveAnnouncementState({ normalSuppression: { mode: 'day', version: '3.9.0', day: '2026-10-27' } });
    expect(store.getAnnouncementState()).toMatchObject({
      seenUrgentIds: ['keep'],
      preferences: { normalEnabled: false, emergencyEnabled: true },
      normalSuppression: { mode: 'day' },
    });
    expect(store.getTasks()).toEqual(original.tasks);
    expect(store.getPlayback()).toEqual(original.playback);
    expect(store.getSettings()).toEqual(original.settings);
  });

  it('读出来的是副本，改它不会污染缓存', () => {
    const file = storeFile({ announcement: { seenUrgentIds: ['keep'] } });
    const store = createStore();
    store.init(file);
    const read = store.getAnnouncementState();
    (read.seenUrgentIds as string[]).push('must-not-mutate-cache');
    expect(store.getAnnouncementState().seenUrgentIds).toEqual(['keep']);
  });

  it('写失败时原文件字节不变，内存回滚到上次成功落盘的内容', () => {
    const file = storeFile({ announcement: { seenUrgentIds: ['keep'] } });
    const store = createStore();
    store.init(file);
    const before = fs.readFileSync(file, 'utf8');
    fs.mkdirSync(`${file}.tmp`);
    expect(() => store.saveAnnouncementState({ seenUrgentIds: ['lost'] })).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(store.getAnnouncementState().seenUrgentIds).toEqual(['keep']);
    fs.rmdirSync(`${file}.tmp`);
    store.saveAnnouncementState({ seenUrgentIds: ['kept-later'] });
    expect(store.getAnnouncementState().seenUrgentIds).toEqual(['kept-later']);
  });

  it('数据文件损坏时拒绝写入并保留原文件（不会用空数据覆盖）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-announcement-broken-'));
    storeDirs.push(dir);
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, '{broken original data');
    const store = createStore();
    store.init(file);
    expect(() => store.saveAnnouncementState({ seenUrgentIds: ['lost'] })).toThrowError(
      expect.objectContaining({ code: 'STORE_READ_FAILED' }),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken original data');
  });
});
