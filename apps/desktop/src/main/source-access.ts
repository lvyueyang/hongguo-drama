/**
 * 来源被停用时的收尾计划（迁移自 4.5 `save-custom-source` 的处理）。
 *
 * 为什么需要专门一段：用户停用一个自定义源，是「不要再从它取任何东西」的意思。
 * 4.5 会取消在飞请求、清掉播放缓存与会话、并把排队中的任务停掉，同时**保留已下载的文件**。
 * 重构后只剩「每次请求前复核来源」，进行中的任务与已经解密好的播放内容都还留着，
 * 等于停用只对新请求生效。
 *
 * 抽成纯函数：真实 Electron 里没法构造「设置保存 + 队列在跑 + 会话在手」的组合，
 * 而这段逻辑恰恰容易漏掉某一类（比如只停任务忘了清会话）。
 */

export interface CustomSourceLike {
  id?: string;
  enabled?: boolean;
}

export interface SourceTaskLike {
  id: string;
  vid: string;
  status?: string;
  seriesId?: string;
}

export interface DisabledSourcePlan {
  /** 本次被停用的来源编号 */
  disabledIds: string[];
  /** 需要停下的任务（不再继续下载/重试）；已完成与已暂停的不动 */
  stoppedTaskIds: string[];
  /** 是否需要清空播放会话（含已解密内容与会话缓存） */
  clearSessions: boolean;
  /** 是否需要清空播放缓存（磁盘上的已解密分集） */
  clearCache: boolean;
  /** 是否需要让来源适配器放弃在飞请求 */
  cancelRequests: boolean;
}

/** `custom:<uuid>:...` → 来源编号；非自定义来源返回 null。 */
export function sourceIdOfVid(vid: unknown): string | null {
  const parts = String(vid ?? '').split(':');
  return parts[0] === 'custom' && parts[1] ? parts[1].toLowerCase() : null;
}

function enabledIds(sources: CustomSourceLike[] | undefined | null): Set<string> {
  const ids = new Set<string>();
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.id ?? '').toLowerCase();
    if (id && source?.enabled !== false) ids.add(id);
  }
  return ids;
}

/** 停用 = 之前启用且存在，之后不存在或 enabled=false。 */
export function disabledSourceIds(
  before: CustomSourceLike[] | undefined | null,
  after: CustomSourceLike[] | undefined | null,
): string[] {
  const enabledBefore = enabledIds(before);
  const enabledAfter = enabledIds(after);
  return [...enabledBefore].filter((id) => !enabledAfter.has(id));
}

export function planDisabledSources(
  before: CustomSourceLike[] | undefined | null,
  after: CustomSourceLike[] | undefined | null,
  tasks: SourceTaskLike[] = [],
): DisabledSourcePlan {
  const disabledIds = disabledSourceIds(before, after);
  if (!disabledIds.length) {
    return {
      disabledIds: [],
      stoppedTaskIds: [],
      clearSessions: false,
      clearCache: false,
      cancelRequests: false,
    };
  }
  const disabled = new Set(disabledIds);
  const stoppedTaskIds: string[] = [];
  for (const task of tasks) {
    const sourceId = sourceIdOfVid(task?.vid);
    if (!sourceId || !disabled.has(sourceId)) continue;
    // 已完成的成品保留（文件不动），已暂停的本来就不在跑。
    if (['completed', 'stopped'].includes(String(task?.status ?? ''))) continue;
    stoppedTaskIds.push(String(task.id));
  }
  return {
    disabledIds,
    stoppedTaskIds,
    // 会话与缓存里可能就有这个源的已解密内容：留着等于停用后还能继续播。
    clearSessions: true,
    clearCache: true,
    cancelRequests: true,
  };
}
