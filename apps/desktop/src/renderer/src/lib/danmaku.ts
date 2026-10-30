/**
 * 弹幕投放调度（纯逻辑，便于测试）。
 *
 * 4.5 的 `CommentDanmaku.jsx` 把弹幕直接挂到 DOM 上，靠 CSS 动画飞；这里改成
 * **按时间轴计算**：给定当前播放时间，算出这一刻该显示哪些弹幕、各占哪一条泳道。
 * 好处是可以直接断言，也不依赖动画实现。
 */

export interface DanmakuItem {
  time: number;
  text: string;
  color?: string;
  mode?: string;
}

export interface DanmakuLane {
  /** 泳道序号（0 起） */
  lane: number;
  item: DanmakuItem;
  /** 字块左边缘的进度 0..1（1 = 刚出现，0 = 将离开） */
  offset: number;
}

export interface DanmakuPlanOptions {
  /** 每条弹幕的存活秒数（滚完一屏的时间） */
  lifetime?: number;
  /** 泳道数（跟容器高度/行高有关） */
  lanes?: number;
  /** 同屏最多同时显示多少条，防止刷屏 */
  maxVisible?: number;
}

export const DEFAULT_LIFETIME = 8;
export const DEFAULT_LANES = 6;
export const DEFAULT_MAX_VISIBLE = 40;

/**
 * 选出当前时间可见的弹幕，并分配泳道。
 *
 * 规则：
 * - 只取 `[now - lifetime, now]` 区间内的条目（未来弹幕不提前画）；
 * - 同一时刻超过泳道数的弹幕被丢弃（不叠在一起，也不改变泳道数）；
 * - 泳道按"最近最少使用"轮转，避免同一泳道连续压两条。
 */
export function planDanmaku(
  items: DanmakuItem[],
  now: number,
  options: DanmakuPlanOptions = {},
): DanmakuLane[] {
  const lifetime = options.lifetime ?? DEFAULT_LIFETIME;
  const lanes = Math.max(1, Math.floor(options.lanes ?? DEFAULT_LANES));
  const maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;
  if (!Array.isArray(items) || !Number.isFinite(now) || lifetime <= 0) return [];

  const visible = items
    .filter(
      (item) =>
        item &&
        Number.isFinite(item.time) &&
        typeof item.text === 'string' &&
        item.text.length > 0 &&
        item.time <= now &&
        item.time > now - lifetime,
    )
    .sort((a, b) => a.time - b.time)
    .slice(-maxVisible);

  // 泳道占用记录：每条泳道最近一次投放的时间，优先选最早空闲的那条。
  const lastUsed = new Array<number>(lanes).fill(Number.NEGATIVE_INFINITY);
  const result: DanmakuLane[] = [];
  for (const item of visible) {
    let best = 0;
    for (let lane = 1; lane < lanes; lane++) {
      if (lastUsed[lane]! < lastUsed[best]!) best = lane;
    }
    lastUsed[best] = item.time;
    result.push({
      lane: best,
      item,
      // 0 表示刚出现（靠右），1 表示即将离场（靠左）
      offset: Math.min(1, Math.max(0, (now - item.time) / lifetime)),
    });
  }
  return result;
}

/** 把官方接口给的 mode 归一成两种显示语义（滚动 / 固定）。 */
export function danmakuPlacement(mode: unknown): 'scroll' | 'top' | 'bottom' {
  const text = String(mode ?? '').toLowerCase();
  if (text === 'top' || text === '4' || text === '5') return 'top';
  if (text === 'bottom' || text === '6') return 'bottom';
  return 'scroll';
}
