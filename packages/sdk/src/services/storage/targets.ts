/**
 * 下载目录的用量统计与「删除全部」（补齐 4.5 的 storage 能力）。
 *
 * 核心不变量（4.5 的 `check-storage-targets.cjs` 守的就是这条）：
 * **统计到的目标集必须与删除的目标集完全一致**，否则会出现「显示 3 个文件、删 0 个」
 * 或反过来删掉没统计到的东西。因此这里由同一份 `collectStorageTargets()` 产出两者。
 *
 * 安全边界：只接受 root 之内的文件，且只认我们自己会生成的扩展名（.mp4 / .json）。
 * 目录扫描保证「磁盘上真实存在的都算进去」，记录只用来补充剧集归属。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathInside } from '@hongguo/shared';

const OWNED_EXTENSIONS = new Set(['.mp4', '.json']);
const MAX_DEPTH = 3;

export interface StorageTarget {
  path: string;
  bytes: number;
  /** 相对 root 的一级目录名，用于分组展示（剧集目录 / 来源目录） */
  group: string;
}

export interface StorageGroup {
  group: string;
  files: number;
  bytes: number;
  seriesId: string;
  seriesTitle: string;
}

export interface StorageUsage {
  root: string;
  totalFiles: number;
  totalBytes: number;
  groups: StorageGroup[];
  targets: StorageTarget[];
}

export interface CollectInput {
  root: string;
  /** 记录：用于给文件补上剧集归属（磁盘扫描才是目标集的真源） */
  records?: Array<{ path?: string; seriesId?: string; seriesTitle?: string }>;
}

function walk(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !entry.name.startsWith('.')) walk(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!OWNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) continue;
    out.push(full);
  }
}

export function collectStorageTargets({ root, records = [] }: CollectInput): StorageUsage {
  // 关键安全点：空 root 不能用 path.resolve('')——那会解析成当前工作目录并扫描整个仓库。
  const raw = String(root ?? '').trim();
  const empty: StorageUsage = {
    root: raw ? path.resolve(raw) : '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    targets: [],
  };
  if (!raw) return empty;
  const resolvedRoot = path.resolve(raw);
  if (!fs.existsSync(resolvedRoot)) return empty;

  const files: string[] = [];
  walk(resolvedRoot, 0, files);

  const ownerOf = new Map<string, { seriesId: string; seriesTitle: string }>();
  for (const record of records) {
    if (!record?.path) continue;
    const key = path.resolve(String(record.path));
    if (ownerOf.has(key)) continue;
    ownerOf.set(key, {
      seriesId: String(record.seriesId ?? ''),
      seriesTitle: String(record.seriesTitle ?? ''),
    });
  }

  const targets: StorageTarget[] = [];
  const groupMap = new Map<string, StorageGroup>();
  let totalBytes = 0;
  for (const file of files) {
    // 目录扫描理论上不会跑到 root 外，这是纵深防御。
    if (!pathInside(resolvedRoot, file)) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      continue;
    }
    const relative = path.relative(resolvedRoot, file);
    const segments = relative.split(path.sep);
    const group = segments.length > 1 ? segments[0]! : '（根目录）';
    targets.push({ path: file, bytes, group });
    totalBytes += bytes;

    const owner = ownerOf.get(file);
    const current = groupMap.get(group) ?? {
      group,
      files: 0,
      bytes: 0,
      seriesId: owner?.seriesId ?? '',
      seriesTitle: owner?.seriesTitle ?? '',
    };
    current.files += 1;
    current.bytes += bytes;
    if (!current.seriesId && owner?.seriesId) current.seriesId = owner.seriesId;
    if (!current.seriesTitle && owner?.seriesTitle) current.seriesTitle = owner.seriesTitle;
    groupMap.set(group, current);
  }

  return {
    root: resolvedRoot,
    totalFiles: targets.length,
    totalBytes,
    groups: [...groupMap.values()].sort((a, b) => b.bytes - a.bytes),
    targets,
  };
}

export interface DeleteResult {
  deleted: number;
  bytes: number;
  failed: string[];
}

/**
 * 删除给定的目标集。默认只删 `collectStorageTargets()` 产出过的文件；
 * 任何落在 root 之外的路径都会被拒绝（不抛错，记入 failed），避免误删用户其它文件。
 */
export function deleteStorageTargets(
  targets: StorageTarget[],
  options: { root: string; remove?: (file: string) => void } = { root: '' },
): DeleteResult {
  const rawRoot = String(options.root ?? '').trim();
  const resolvedRoot = rawRoot ? path.resolve(rawRoot) : '';
  const remove = options.remove ?? ((file: string) => fs.rmSync(file, { force: true }));
  const result: DeleteResult = { deleted: 0, bytes: 0, failed: [] };
  for (const target of targets) {
    const file = path.resolve(String(target?.path ?? ''));
    if (!file || !resolvedRoot || !pathInside(resolvedRoot, file)) {
      result.failed.push(target?.path ?? '');
      continue;
    }
    try {
      remove(file);
      result.deleted += 1;
      result.bytes += Number(target.bytes) || 0;
    } catch {
      result.failed.push(file);
    }
  }
  return result;
}

/**
 * 单剧删除：只删「属于这部剧」的文件。
 *
 * 归属判定用两条并用，避免既删到别人的文件、又漏掉同目录里的导出文字：
 * - 记录里属于该 seriesId 的文件所在目录；
 * - 目录内的所有自产文件（视频与其同名文字导出）。
 * 其它剧的目录、以及只有任务记录但目录不同的文件都不会被牵连。
 */
export function collectSeriesTargets(input: {
  root: string;
  seriesId: string;
  records?: Array<{ path?: string; seriesId?: string; seriesTitle?: string }>;
}): StorageUsage {
  const usage = collectStorageTargets({ root: input.root, records: input.records ?? [] });
  const seriesId = String(input.seriesId ?? '');
  if (!seriesId) return { ...usage, totalFiles: 0, totalBytes: 0, groups: [], targets: [] };

  const dirs = new Set<string>();
  for (const record of input.records ?? []) {
    if (!record?.path) continue;
    if (String(record.seriesId ?? '') !== seriesId) continue;
    dirs.add(path.dirname(path.resolve(String(record.path))));
  }

  const targets = usage.targets.filter((target) => {
    for (const dir of dirs) {
      if (pathInside(dir, target.path)) return true;
    }
    return false;
  });

  const groups = new Map<string, StorageGroup>();
  let totalBytes = 0;
  for (const target of targets) {
    totalBytes += target.bytes;
    const current = groups.get(target.group) ?? {
      group: target.group,
      files: 0,
      bytes: 0,
      seriesId,
      seriesTitle: '',
    };
    current.files += 1;
    current.bytes += target.bytes;
    groups.set(target.group, current);
  }
  return {
    root: usage.root,
    totalFiles: targets.length,
    totalBytes,
    groups: [...groups.values()],
    targets,
  };
}

/** 删除后清理空目录（只清 root 之内、且确实为空的目录）。 */
export function pruneEmptyDirs(root: string, directories: Iterable<string>): number {
  const resolvedRoot = String(root ?? '').trim() ? path.resolve(String(root)) : '';
  if (!resolvedRoot) return 0;
  let removed = 0;
  for (const dir of directories) {
    const target = path.resolve(String(dir));
    if (!pathInside(resolvedRoot, target) || target === resolvedRoot) continue;
    try {
      if (fs.readdirSync(target).length === 0) {
        fs.rmdirSync(target);
        removed += 1;
      }
    } catch {
      /* 目录被占用或已不存在 */
    }
  }
  return removed;
}

/**
 * 单集删除：该集的视频、同名文字导出，以及可能残留的半成品（`.enc.tmp` / `.decoded`）。
 * 与「删除整剧」共用同一套边界检查（只认 root 之内、只认自产扩展名）。
 */
export function collectEpisodeTargets(input: { root: string; savePath: string }): StorageUsage {
  const raw = String(input.root ?? '').trim();
  const resolvedRoot = raw ? path.resolve(raw) : '';
  const empty: StorageUsage = { root: resolvedRoot, totalFiles: 0, totalBytes: 0, groups: [], targets: [] };
  const savePath = String(input.savePath ?? '').trim();
  if (!resolvedRoot || !savePath) return empty;
  const resolvedSave = path.resolve(savePath);
  if (!pathInside(resolvedRoot, resolvedSave)) return empty;

  const stem = resolvedSave.replace(/\.mp4$/i, '');
  const candidates = [
    resolvedSave,
    `${stem}.danmaku.json`,
    `${stem}.comments.json`,
    // 下载器写的是 <final>.enc.tmp / <decoded path>.decoded，两者都要覆盖。
    `${resolvedSave}.enc.tmp`,
    `${resolvedSave}.enc.tmp.decoded`,
    `${stem}.enc.tmp`,
    `${stem}.enc.tmp.decoded`,
    `${resolvedSave}.decoded`,
    `${resolvedSave}.compat.mp4`,
  ];
  const targets: StorageTarget[] = [];
  let totalBytes = 0;
  for (const file of candidates) {
    if (!pathInside(resolvedRoot, file)) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      continue;
    }
    targets.push({ path: file, bytes, group: path.relative(resolvedRoot, file).split(path.sep)[0] ?? '' });
    totalBytes += bytes;
  }
  return {
    root: resolvedRoot,
    totalFiles: targets.length,
    totalBytes,
    groups: [],
    targets,
  };
}

/** 正在下载/排队的任务不能删文件：删掉的是它正在写的那份，下载会失败或留下垃圾。 */
const RUNNING_STATUSES = ['pending', 'downloading'];

export function episodeDeletionProblem(task: { status?: string } | null | undefined): string | null {
  const status = String(task?.status ?? '');
  return RUNNING_STATUSES.includes(status) ? '这一集正在下载，请先暂停或等它完成后再删除' : null;
}

/** 整剧删除同理：只要该剧还有在跑的任务，就先别动它的文件。 */
export function seriesDeletionProblem(
  tasks: Array<{ seriesId?: string; status?: string }> | null | undefined,
  seriesId: string,
): string | null {
  const running = (Array.isArray(tasks) ? tasks : []).filter(
    (task) =>
      String(task?.seriesId ?? '') === String(seriesId) &&
      RUNNING_STATUSES.includes(String(task?.status ?? '')),
  );
  return running.length ? `《${seriesId}》还有 ${running.length} 集在下载，请先暂停或等它完成后再删除` : null;
}

/**
 * 把目标集分成「可以删」与「要保护」两部分。
 *
 * 「删除全部」不该动正在合并的剧集：合并正在读那些源文件，删掉会让它中途失败并留下坏产物。
 * 4.5 的做法是跳过并提示，这里保留同样的语义，只是把判定抽成纯函数。
 */
export function partitionTargets(
  targets: StorageTarget[] | null | undefined,
  protectedPaths: Iterable<string> | null | undefined,
): { remove: StorageTarget[]; kept: StorageTarget[] } {
  const guarded = new Set<string>();
  for (const file of protectedPaths ?? []) {
    if (file) guarded.add(path.resolve(String(file)));
  }
  const remove: StorageTarget[] = [];
  const kept: StorageTarget[] = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (guarded.has(path.resolve(String(target.path)))) kept.push(target);
    else remove.push(target);
  }
  return { remove, kept };
}
