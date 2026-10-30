/**
 * 公告服务（本轮补上「主动推送」这一环）。
 *
 * 为什么要专门测：主进程注册了 `onAnnouncement` 回调，但服务里从来没调用过它，
 * 于是紧急公告永远推不到界面（设置页不主动拉也看不到）。这条用例锁住「推一次、不重复推」。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAnnouncementService } from './announcements.ts';

function fakeStore(state: Record<string, unknown> = {}) {
  const saved: Record<string, unknown>[] = [];
  const current: Record<string, any> = {
    preferences: { normalEnabled: true, emergencyEnabled: true },
    seenUrgentIds: [],
    normalSuppression: null,
    ...state,
  };
  return {
    saved,
    getAnnouncementState: () => current,
    saveAnnouncementState: (patch: Record<string, unknown>) => {
      saved.push(patch);
      Object.assign(current, patch);
    },
  };
}

// 服务端公告格式是固定的四字段（含 active:true），且必须是 application/json
const emergencyBody = JSON.stringify({ id: 'em-1', title: '紧急通知', body: '今晚维护', active: true });

function service(
  options: { store?: ReturnType<typeof fakeStore>; body?: string; onAnnouncement?: any } = {},
) {
  const store = options.store ?? fakeStore();
  const request = vi.fn(async (url: string) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: url.includes('emergency') ? (options.body ?? emergencyBody) : '',
  }));
  const instance = createAnnouncementService({
    store,
    version: '5.0.0',
    request,
    isEnabled: () => true,
    ...(options.onAnnouncement ? { onAnnouncement: options.onAnnouncement } : {}),
  });
  return { instance, store, request };
}

describe('紧急公告推送', () => {
  it('轮询到新的紧急公告时主动推一次', async () => {
    const onAnnouncement = vi.fn();
    const { instance } = service({ onAnnouncement });
    const result = await instance.checkAnnouncements({ urgentOnly: true });
    expect(result.announcement).toMatchObject({ id: 'em-1', title: '紧急通知', urgent: true });
    expect(onAnnouncement).toHaveBeenCalledTimes(1);
    expect(onAnnouncement).toHaveBeenCalledWith({
      announcement: expect.objectContaining({ id: 'em-1', title: '紧急通知' }),
    });
  });

  it('同一条公告反复轮询不会反复弹（用户没确认前每次轮询都会拿到它）', async () => {
    const onAnnouncement = vi.fn();
    const { instance } = service({ onAnnouncement });
    const first = await instance.checkAnnouncements({ urgentOnly: true });
    const second = await instance.checkAnnouncements({ urgentOnly: true });
    // 两次都拿得到（界面还要能拉取），但只推一次
    expect(first.announcement).toMatchObject({ id: 'em-1' });
    expect(second.announcement).toMatchObject({ id: 'em-1' });
    expect(onAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('已读过的公告不再推（seenUrgentIds 里有的）', async () => {
    const onAnnouncement = vi.fn();
    const { instance } = service({
      store: fakeStore({ seenUrgentIds: ['em-1'] }),
      onAnnouncement,
    });
    await instance.checkAnnouncements({ urgentOnly: true });
    expect(onAnnouncement).not.toHaveBeenCalled();
  });

  it('没有订阅者（没传回调）也能正常轮询', async () => {
    const { instance } = service();
    await expect(instance.checkAnnouncements({ urgentOnly: true })).resolves.toBeTruthy();
  });

  it('推送回调抛错不影响轮询结果', async () => {
    const { instance } = service({
      onAnnouncement: () => {
        throw new Error('渲染层已销毁');
      },
    });
    const result = await instance.checkAnnouncements({ urgentOnly: true });
    expect(result.announcement).toMatchObject({ id: 'em-1' });
  });

  it('公告 JSON 非法时不推、不崩', async () => {
    const onAnnouncement = vi.fn();
    const { instance } = service({ body: 'not json', onAnnouncement });
    const result = await instance.checkAnnouncements({ urgentOnly: true });
    expect(result.announcement).toBeNull();
    expect(onAnnouncement).not.toHaveBeenCalled();
  });
});
