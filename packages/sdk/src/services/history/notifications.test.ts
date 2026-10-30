/**
 * 更新通知的决策（迁移自 4.5 的分集/续作提醒去重）。
 * 不变量：同一条更新只提醒一次；提醒不等于已读；开关关掉就一条都不发。
 */
import { describe, expect, it } from 'vitest';
import { mergeNotificationMarks, planUpdateNotifications } from './notifications.ts';

const rows = [
  {
    series_id: 'A',
    series_title: '测试剧',
    knownTotal: 12,
    acknowledgedTotal: 10,
    unreadEpisodes: 2,
    sequels: [{ series_id: 'A2', series_title: '测试剧第二季' }],
  },
  { series_id: 'B', series_title: '没更新的剧', knownTotal: 8, acknowledgedTotal: 8 },
];

describe('planUpdateNotifications', () => {
  it('更新集数与续作各提醒一次，并写回去重标记', () => {
    const plan = planUpdateNotifications(rows, { A: { acknowledgedTotal: 10 } });
    expect(plan.notifications.map((item) => item.kind)).toEqual(['episodes', 'sequel']);
    expect(plan.notifications[0]?.title).toBe('《测试剧》更新到第 12 集');
    expect(plan.notifications[1]?.body).toContain('测试剧第二季');
    expect(plan.updates.A).toMatchObject({ notifiedTotal: 12, notifiedSequelIds: ['A2'] });
  });

  it('已经提醒过的总量与续作不重复提醒', () => {
    const plan = planUpdateNotifications(rows, {
      A: { acknowledgedTotal: 10, notifiedTotal: 12, notifiedSequelIds: ['A2'] },
    });
    expect(plan.notifications).toEqual([]);
    expect(plan.updates).toEqual({});
  });

  it('提醒不等于已读：红点仍按 acknowledgedTotal 计算', () => {
    const plan = planUpdateNotifications(rows, { A: { acknowledgedTotal: 10 } });
    expect(plan.notifications[0]?.body).toContain('2 集未看');
    // 不写 seenSequelIds / acknowledgedTotal
    expect(plan.updates.A?.seenSequelIds).toBeUndefined();
    expect(plan.updates.A && 'acknowledgedTotal' in plan.updates.A).toBe(false);
  });

  it('没有 baseline 时按当前总量当作已提醒（首次不炸一堆通知）', () => {
    const plan = planUpdateNotifications([{ series_id: 'C', knownTotal: 5 }], { C: {} });
    expect(plan.notifications).toEqual([]);
  });

  it('续作超过三部时只列前三部，其余用数量概括', () => {
    const plan = planUpdateNotifications(
      [
        {
          series_id: 'D',
          series_title: '剧D',
          knownTotal: 1,
          acknowledgedTotal: 1,
          sequels: [1, 2, 3, 4].map((index) => ({ series_id: `D${index}`, series_title: `第${index}季` })),
        },
      ],
      { D: { notifiedTotal: 1 } },
    );
    expect(plan.notifications[0]?.body).toMatch(/等 4 部/);
  });

  it('开关关掉时一条都不发，也不写标记', () => {
    expect(planUpdateNotifications(rows, {}, { enabled: false })).toEqual({ notifications: [], updates: {} });
  });

  it('空输入不崩', () => {
    expect(planUpdateNotifications(null, null)).toEqual({ notifications: [], updates: {} });
    expect(planUpdateNotifications([], {})).toEqual({ notifications: [], updates: {} });
  });
});

describe('mergeNotificationMarks', () => {
  it('只覆盖去重字段，进度字段原样保留；刷新期间被移除的记录不复活', () => {
    const merged = mergeNotificationMarks(
      { A: { vid_index: 3, currentTime: 42, notifiedTotal: 5 }, B: { vid_index: 1 } },
      { A: { notifiedTotal: 12 }, C: { notifiedTotal: 3 } },
    );
    expect(merged.A).toMatchObject({ vid_index: 3, currentTime: 42, notifiedTotal: 12 });
    expect(merged.C).toBeUndefined();
    expect(merged.B).toEqual({ vid_index: 1 });
  });
});
