/**
 * 自定义源的增删改（迁移自 4.5 `save-custom-source` 的编排）。
 *
 * SDK 里的 provider 只会「用」来源；「改来源」这件事需要：校验 → （可选）真连一次 →
 * 落盘 → 告诉调用方最终清单。任何一步失败都不能留下半套配置：
 * 用户点「保存」失败后，来源列表必须还是原样（4.5 的检查专门盯过这一点）。
 */
import crypto from 'node:crypto';
import customProvider from '../../providers/custom/index.ts';
import type {
  CustomSourceDraft,
  CustomSourceSaveRequest,
  CustomSourceSaveResult,
  CustomSourceView,
} from './types.ts';

export type { CustomSourceDraft, CustomSourceSaveRequest, CustomSourceSaveResult, CustomSourceView };

interface StoreLike {
  getSettings(): { custom_sources?: CustomSourceView[] } & Record<string, unknown>;
  saveSettings(settings: Partial<Record<string, unknown>>): void;
}

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** 界面上要显示的是「来源清单」而不是内部配置（含停用的），启用状态要如实给出。 */
export function listCustomSources(settings: { custom_sources?: CustomSourceView[] }): CustomSourceView[] {
  return (Array.isArray(settings.custom_sources) ? settings.custom_sources : []).map((source) => ({
    id: String(source.id ?? ''),
    name: String(source.name ?? ''),
    url: String(source.url ?? ''),
    enabled: source.enabled !== false,
  }));
}

/**
 * 保存（新增/更新）或删除一个自定义源。
 *
 * `test: true` 时先真连一次接口，连不上就不落盘——避免用户存进一个打不开的来源，
 * 之后每次搜索都要等它超时。
 */
export async function saveCustomSource(
  store: StoreLike,
  request: CustomSourceSaveRequest,
  options: { testSource?: (draft: CustomSourceDraft) => Promise<{ success: boolean; error?: string }> } = {},
): Promise<CustomSourceSaveResult> {
  const before = listCustomSources(store.getSettings());
  const draft = request?.source;

  if (request?.remove === true) {
    const id = String(draft?.id ?? '').toLowerCase();
    if (!UUID.test(id)) return { success: false, error: '自定义源编号无效', sources: before };
    const next = before.filter((source) => source.id !== id);
    if (next.length === before.length)
      return { success: false, error: '这个自定义源已经不存在', sources: before };
    try {
      store.saveSettings({ custom_sources: next });
    } catch (error) {
      return { success: false, error: `保存失败：${(error as Error).message}`, sources: before };
    }
    return { success: true, sources: listCustomSources(store.getSettings()) };
  }

  let validated: CustomSourceView;
  try {
    validated = customProvider.validateSource(draft) as CustomSourceView;
  } catch (error) {
    return { success: false, error: (error as Error).message, sources: before };
  }

  const updated: CustomSourceView = {
    ...validated,
    // 新增时生成编号；更新时保留原编号（否则下载任务里的 vid 会对不上来源）。
    id: validated.id ?? crypto.randomUUID(),
    enabled: draft?.enabled !== false,
  };
  const exists = before.some((source) => source.id === updated.id);
  if (!exists && before.some((source) => source.url === updated.url)) {
    return { success: false, error: '这个接口地址已经添加过了', sources: before };
  }
  if (before.length >= 20 && !exists) {
    return { success: false, error: '自定义源最多 20 个', sources: before };
  }

  if (request?.test === true) {
    const tester =
      options.testSource ?? ((source: CustomSourceDraft) => customProvider.testCustomSource(source));
    const tested = await tester(updated);
    if (!tested?.success) {
      return { success: false, error: `接口测试失败：${tested?.error ?? '无法读取目录'}`, sources: before };
    }
  }

  const next = exists
    ? before.map((source) => (source.id === updated.id ? updated : source))
    : [...before, updated];
  try {
    store.saveSettings({ custom_sources: next });
  } catch (error) {
    // 落盘失败要把内存改回原样，否则界面上会显示一个「保存了但重启就没了」的来源。
    try {
      store.saveSettings({ custom_sources: before });
    } catch {
      /* 回滚也失败：只能如实汇报 */
    }
    return { success: false, error: `保存失败：${(error as Error).message}`, sources: before };
  }
  return { success: true, sources: listCustomSources(store.getSettings()) };
}

export default { listCustomSources, saveCustomSource };
