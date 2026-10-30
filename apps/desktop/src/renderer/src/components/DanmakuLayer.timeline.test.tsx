// SPDX-License-Identifier: MIT
/**
 * 弹幕覆盖层的时间轴语义（替代 4.5 `scripts/check-danmaku-fullscreen.cjs`）。
 *
 * 4.5 是「DOM + CSS 动画 + RAF」的实现：全屏切换/缓冲/拖动时要额外保证不把动画帧当成
 * seek、不清掉正在飞的弹幕、不在拖动期间把跳过的弹幕补出来。5.0 改成**无状态的按时间计算**
 * （`planDanmaku` 只吃 `currentTime`），那套实现细节整体 obsolete，存活下来的是同一批
 * 用户可见不变量，这里按新模型锁住：
 *   1. 拖动到别处就按新时间重算，拖动前的弹幕立刻消失，被跳过的区间不会补播；
 *   2. 暂停时时间不推进，弹幕也就不动（内部 200ms 计时器只是重算，不是动画）；
 *   3. 换源（换集）后旧弹幕立刻消失，不残留上一集的条目。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DanmakuLayer from './DanmakuLayer.tsx';

const items = [
  { time: 2, text: '两秒的弹幕' },
  { time: 15, text: '十五秒的弹幕' },
  { time: 30, text: '三十秒的弹幕' },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('时间轴', () => {
  it('向前拖动按新时间重算：旧弹幕消失，被跳过的区间不补播', () => {
    const { rerender } = render(<DanmakuLayer items={items} currentTime={2} />);
    expect(screen.getByText('两秒的弹幕')).toBeTruthy();
    expect(screen.queryByText('三十秒的弹幕')).toBeNull();

    rerender(<DanmakuLayer items={items} currentTime={30} />);
    expect(screen.getByText('三十秒的弹幕')).toBeTruthy();
    expect(screen.queryByText('两秒的弹幕')).toBeNull();
    // 15 秒那条在「2 → 30」的跳转里从未被渲染，拖动不会把它放出来
    expect(screen.queryByText('十五秒的弹幕')).toBeNull();
  });

  it('往回拖动同样按新时间显示，不残留拖动前的条目', () => {
    const { rerender } = render(<DanmakuLayer items={items} currentTime={30} />);
    expect(screen.getByText('三十秒的弹幕')).toBeTruthy();

    rerender(<DanmakuLayer items={items} currentTime={2} />);
    expect(screen.getByText('两秒的弹幕')).toBeTruthy();
    expect(screen.queryByText('三十秒的弹幕')).toBeNull();
  });

  it('暂停时弹幕停住：内部重算计时器不会让条目自己前进', () => {
    vi.useFakeTimers();
    render(<DanmakuLayer items={items} currentTime={5} />);
    const before = (screen.getByText('两秒的弹幕') as HTMLElement).style.right;

    vi.advanceTimersByTime(1000);
    // currentTime 没变（视频暂停）→ 同一条弹幕停在同一个位置，也不会凭空出现新的
    expect((screen.getByText('两秒的弹幕') as HTMLElement).style.right).toBe(before);
    expect(screen.queryByText('十五秒的弹幕')).toBeNull();
  });

  it('换源后旧弹幕立刻消失，不残留上一集', () => {
    const { rerender } = render(<DanmakuLayer items={items} currentTime={2} />);
    expect(screen.getByText('两秒的弹幕')).toBeTruthy();

    rerender(<DanmakuLayer items={[{ time: 2, text: '另一集的弹幕' }]} currentTime={2} />);
    expect(screen.getByText('另一集的弹幕')).toBeTruthy();
    expect(screen.queryByText('两秒的弹幕')).toBeNull();
  });
});
