import { describe, expect, it } from 'vitest';
import { type DanmakuItem, danmakuPlacement, planDanmaku } from './danmaku.ts';

const item = (time: number, text: string): DanmakuItem => ({ time, text });

describe('弹幕投放', () => {
  it('只画当前时间窗口内的弹幕，未来弹幕不提前出现', () => {
    const items = [item(1, '早'), item(5, '当前'), item(20, '很晚')];
    const plan = planDanmaku(items, 5, { lifetime: 8 });
    expect(plan.map((lane) => lane.item.text)).toEqual(['早', '当前']);
  });

  it('超过存活时间的弹幕消失', () => {
    const plan = planDanmaku([item(1, '早')], 20, { lifetime: 8 });
    expect(plan).toEqual([]);
  });

  it('同屏数量超过上限时保留较新的', () => {
    const items = Array.from({ length: 10 }, (_, index) => item(index, `第${index}条`));
    const plan = planDanmaku(items, 9, { lifetime: 10, maxVisible: 3 });
    expect(plan.map((lane) => lane.item.text)).toEqual(['第7条', '第8条', '第9条']);
  });

  it('泳道按最早空闲轮转，不把同一时刻的弹幕堆在一条上', () => {
    const items = [item(3, 'a'), item(3, 'b'), item(3, 'c')];
    const plan = planDanmaku(items, 3, { lanes: 3 });
    expect(plan.map((lane) => lane.lane)).toEqual([0, 1, 2]);
  });

  it('泳道数与容器行数一致，超出部分丢弃而不是叠放', () => {
    const items = [item(3, 'a'), item(3, 'b'), item(3, 'c'), item(3, 'd')];
    const plan = planDanmaku(items, 3, { lanes: 2, maxVisible: 10 });
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((lane) => lane.lane))).toEqual(new Set([0, 1]));
  });

  it('offset 随进度增长：刚出现接近 0，快离开接近 1', () => {
    const fresh = planDanmaku([item(10, '新')], 10, { lifetime: 8 })[0]!;
    const old = planDanmaku([item(10, '旧')], 17.6, { lifetime: 8 })[0]!;
    expect(fresh.offset).toBeCloseTo(0);
    expect(old.offset).toBeGreaterThan(0.9);
  });

  it('脏数据不会让调度崩：非法时间、空文本、缺字段都被跳过', () => {
    const dirty = [
      { time: Number.NaN, text: 'x' },
      { time: 1, text: '' },
      { time: 1 } as unknown as DanmakuItem,
      { time: 1, text: '正常' },
    ];
    const plan = planDanmaku(dirty, 1, { lifetime: 8 });
    expect(plan.map((lane) => lane.item.text)).toEqual(['正常']);
  });

  it('非数组或非法时间直接返回空，不抛异常', () => {
    expect(planDanmaku(undefined as unknown as DanmakuItem[], 1)).toEqual([]);
    expect(planDanmaku([item(1, 'x')], Number.NaN)).toEqual([]);
  });

  it('显示模式归一到 scroll/top/bottom', () => {
    expect(danmakuPlacement('scroll')).toBe('scroll');
    expect(danmakuPlacement('top')).toBe('top');
    expect(danmakuPlacement('5')).toBe('top');
    expect(danmakuPlacement('bottom')).toBe('bottom');
    expect(danmakuPlacement(undefined)).toBe('scroll');
  });
});
