import { useEffect, useState } from 'react';
import { type DanmakuItem, danmakuPlacement, planDanmaku } from '../lib/danmaku.ts';

/**
 * 弹幕覆盖层。
 *
 * 由父组件传入当前播放时间（`video.currentTime`），这里只负责"这一刻画什么"。
 * 不做动画、不写 DOM 时间轴——泳道与偏移都由 `planDanmaku` 算好，
 * 因此同一时间点渲染结果稳定，也便于断言。
 */
export interface DanmakuLayerProps {
  items: DanmakuItem[];
  currentTime: number;
  visible?: boolean;
  /** 关掉时说明原因（例如"本集暂无弹幕"），不许把拿不到说成没有 */
  notice?: string;
  lanes?: number;
}

const LANE_HEIGHT = 24;

export default function DanmakuLayer({
  items,
  currentTime,
  visible = true,
  notice = '',
  lanes = 6,
}: DanmakuLayerProps) {
  // 时间轴推进不需要 60fps：每 200ms 重算一次足够顺滑，也避免占满主线程。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const handle = window.setInterval(() => setTick((value) => value + 1), 200);
    return () => window.clearInterval(handle);
  }, [visible]);
  void tick;

  if (!visible) return null;
  if (!items.length) {
    return notice ? (
      <div className="pointer-events-none absolute inset-x-0 top-2 text-center text-[var(--font-size-caption)] text-muted">
        {notice}
      </div>
    ) : null;
  }

  const plan = planDanmaku(items, currentTime, { lanes });
  const fixed = plan.filter((entry) => danmakuPlacement(entry.item.mode) !== 'scroll');
  const scrolling = plan.filter((entry) => danmakuPlacement(entry.item.mode) === 'scroll');

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {scrolling.map((entry) => (
        <span
          key={`${entry.item.time}-${entry.item.text}-${entry.lane}`}
          className="absolute whitespace-nowrap font-medium text-[var(--font-size-label)] drop-shadow"
          style={{
            top: `${entry.lane * LANE_HEIGHT + 4}px`,
            right: `${entry.offset * 100}%`,
            color: entry.item.color || '#ffffff',
          }}
        >
          {entry.item.text}
        </span>
      ))}
      {fixed.map((entry) => {
        const placement = danmakuPlacement(entry.item.mode);
        return (
          <span
            key={`fixed-${entry.item.time}-${entry.item.text}`}
            className="absolute inset-x-0 text-center font-medium text-[var(--font-size-label)] drop-shadow"
            style={{
              top: placement === 'top' ? `${entry.lane * LANE_HEIGHT + 4}px` : undefined,
              bottom: placement === 'bottom' ? `${entry.lane * LANE_HEIGHT + 4}px` : undefined,
              color: entry.item.color || '#ffffff',
            }}
          >
            {entry.item.text}
          </span>
        );
      })}
    </div>
  );
}
