import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DanmakuLayer from './DanmakuLayer.tsx';

afterEach(() => cleanup());

const items = [
  { time: 1, text: '早先的弹幕', color: '#ffcc00' },
  { time: 5, text: '刚刚的弹幕' },
  { time: 30, text: '很晚的弹幕' },
];

describe('弹幕覆盖层', () => {
  it('按当前播放时间只画出窗口内的弹幕', () => {
    render(<DanmakuLayer items={items} currentTime={5} />);
    expect(screen.getByText('早先的弹幕')).toBeTruthy();
    expect(screen.getByText('刚刚的弹幕')).toBeTruthy();
    expect(screen.queryByText('很晚的弹幕')).toBeNull();
  });

  it('保留官方给的弹幕颜色', () => {
    render(<DanmakuLayer items={[items[0]!]} currentTime={1} />);
    expect((screen.getByText('早先的弹幕') as HTMLElement).style.color).toBe('rgb(255, 204, 0)');
  });

  it('关闭时不渲染任何弹幕', () => {
    render(<DanmakuLayer items={items} currentTime={5} visible={false} />);
    expect(screen.queryByText('刚刚的弹幕')).toBeNull();
  });

  it('没有弹幕时把原因显示出来，而不是静默空白', () => {
    render(<DanmakuLayer items={[]} currentTime={5} notice="本集暂无弹幕" />);
    expect(screen.getByText('本集暂无弹幕')).toBeTruthy();
  });

  it('固定弹幕（top/bottom）与滚动弹幕分开摆放', () => {
    render(
      <DanmakuLayer
        items={[
          { time: 5, text: '顶部固定', mode: 'top' },
          { time: 5, text: '滚动中' },
        ]}
        currentTime={5}
      />,
    );
    const fixed = screen.getByText('顶部固定') as HTMLElement;
    expect(fixed.style.top).not.toBe('');
    expect(fixed.style.right).toBe('');
  });

  it('整个覆盖层不挡鼠标操作', () => {
    const { container } = render(<DanmakuLayer items={items} currentTime={5} />);
    const layer = container.firstElementChild as HTMLElement;
    expect(layer.className).toContain('pointer-events-none');
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });
});
