/**
 * 更新通知（迁移自 4.5 的「分集更新 / 续作更新」提醒与去重）。
 *
 * 4.5 会为「这部剧更新到第 N 集」「这部剧出了续作」发系统通知，并按总量与续作编号去重
 * ——同一条更新只提醒一次。重构后 `watch_updates_enabled` / `watch_notifications_enabled`
 * 两个开关是死设置：没有任何代码读它们，也没有任何通知。
 *
 * 这里只做「该发哪些通知、要写回什么」的决策（纯函数），宿主负责真正弹通知与落盘。
 */

export interface NotifyRow {
  series_id: string;
  series_title?: string;
  knownTotal?: number;
  acknowledgedTotal?: number;
  unreadEpisodes?: number;
  sequels?: Array<{ series_id?: string; series_title?: string }>;
}

export interface NotifyRecord {
  /** 已经提醒过的总集数（提醒 ≠ 已读：红点仍按 acknowledgedTotal 判断） */
  notifiedTotal?: number;
  /** 已经提醒过的续作编号 */
  notifiedSequelIds?: string[];
  seenSequelIds?: string[];
  [key: string]: unknown;
}

export type NotificationKind = 'episodes' | 'sequel';

export interface PendingNotification {
  /** 去重键（宿主可用它做一次性提示） */
  key: string;
  seriesId: string;
  kind: NotificationKind;
  title: string;
  body: string;
}

export interface NotificationPlan {
  notifications: PendingNotification[];
  /** 需要写回的记录（只含去重字段，合并时不要覆盖别的字段） */
  updates: Record<string, NotifyRecord>;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 决定要发哪些通知。
 *
 * 两条去重口径：
 * - 分集：`knownTotal` 超过上一次**提醒过**的总量才提醒（不是超过已读量——用户没点开也要先知道）；
 * - 续作：只提醒没提醒过的续作编号；「已读」是另一套（seenSequelIds），提醒不影响红点。
 */
export function planUpdateNotifications(
  rows: NotifyRow[] | null | undefined,
  playback: Record<string, NotifyRecord | undefined> | null | undefined,
  options: { enabled?: boolean } = {},
): NotificationPlan {
  if (options.enabled === false) return { notifications: [], updates: {} };
  const list = Array.isArray(rows) ? rows : [];
  const notifications: PendingNotification[] = [];
  const updates: Record<string, NotifyRecord> = {};

  for (const row of list) {
    const seriesId = String(row?.series_id ?? '');
    if (!seriesId) continue;
    const record = playback?.[seriesId] ?? {};
    const title = String(row?.series_title ?? seriesId);
    const knownTotal = numberOrZero(row?.knownTotal);
    const notifiedTotal = numberOrZero(record.notifiedTotal);
    const baseline = notifiedTotal || numberOrZero(row?.acknowledgedTotal) || knownTotal;

    if (knownTotal > baseline) {
      notifications.push({
        key: `episodes:${seriesId}:${knownTotal}`,
        seriesId,
        kind: 'episodes',
        title: `《${title}》更新到第 ${knownTotal} 集`,
        body: `还有 ${Math.max(0, knownTotal - numberOrZero(row?.acknowledgedTotal))} 集未看`,
      });
      updates[seriesId] = { ...updates[seriesId], notifiedTotal: knownTotal };
    }

    const notifiedSequelIds = Array.isArray(record.notifiedSequelIds) ? record.notifiedSequelIds : [];
    const fresh = (Array.isArray(row?.sequels) ? row.sequels : []).filter((sequel) => {
      const id = String(sequel?.series_id ?? '');
      return id && !notifiedSequelIds.includes(id);
    });
    if (fresh.length) {
      const names = fresh
        .slice(0, 3)
        .map((sequel) => `《${String(sequel?.series_title ?? sequel?.series_id ?? '续作')}》`)
        .join('、');
      notifications.push({
        key: `sequel:${seriesId}:${fresh.map((sequel) => sequel?.series_id).join(',')}`,
        seriesId,
        kind: 'sequel',
        title: `《${title}》有续作`,
        body: fresh.length > 3 ? `${names} 等 ${fresh.length} 部` : names,
      });
      updates[seriesId] = {
        ...updates[seriesId],
        notifiedSequelIds: [...notifiedSequelIds, ...fresh.map((sequel) => String(sequel?.series_id))],
      };
    }
  }

  return { notifications, updates };
}

/** 把去重字段合并进当前记录（不覆盖 vid_index/currentTime 这些进度字段）。 */
export function mergeNotificationMarks(
  current: Record<string, NotifyRecord | undefined> | null | undefined,
  updates: Record<string, NotifyRecord> | null | undefined,
): Record<string, NotifyRecord | undefined> {
  const merged = { ...(current ?? {}) };
  for (const [seriesId, update] of Object.entries(updates ?? {})) {
    const record = merged[seriesId];
    if (!record) continue;
    merged[seriesId] = { ...record, ...update };
  }
  return merged;
}
