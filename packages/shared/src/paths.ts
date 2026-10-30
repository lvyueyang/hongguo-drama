/**
 * 路径与文件名的安全规则（迁移自 4.5 `main.js` 的 sanizeFolderName / pathInside / renderName）。
 *
 * 这些规则是安全边界，不是格式化偏好：
 * - 剧名来自上游，可能含 `..`、斜杠、控制字符，直接拼路径会写到目录外；
 * - 合法子路径判断必须防住 `..` 穿越、绝对路径替换与 Windows 大小写；
 * - 保留名（con/prn/aux…）在 Windows 上会创建失败。
 */
import path from 'node:path';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 这里要过滤的就是路径里的控制字符
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 目录名：去掉非法字符与首尾空白/点，按码位截断（不劈开 emoji），避开 Windows 保留名。 */
export function sanitizeFolderName(name: unknown): string {
  let cleaned = String(name ?? '')
    .replace(ILLEGAL, '')
    .replace(/^ +/, '');
  const chars = Array.from(cleaned);
  if (chars.length > 80) cleaned = chars.slice(0, 80).join('');
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`.replace(/[. ]+$/g, '');
  return cleaned;
}

/** target 是否位于 root 之内（含等于 root）。防 `..` 穿越与绝对路径替换。 */
export function pathInside(root: string, target: string): boolean {
  if (!root || !target) return false;
  let base = path.resolve(String(root));
  let file = path.resolve(String(target));
  // Windows 大小写不敏感：比较前统一小写。
  if (process.platform === 'win32') {
    base = base.toLowerCase();
    file = file.toLowerCase();
  }
  const relative = path.relative(base, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 剧集目录：`<root>/<来源目录>/<剧名>-<id 哈希 12 位>`。
 * 加哈希是为了同名不同剧不互相覆盖；来源目录让用户在文件管理器里一眼分清来源。
 */
export function seriesDownloadDir(root: string, seriesId: string, seriesTitle: string): string {
  const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const suffix = idHash(seriesId);
  const sourceDir = String(seriesId).startsWith('hema:')
    ? '河马短剧'
    : String(seriesId).startsWith('xifan:')
      ? '西饭短剧'
      : String(seriesId).startsWith('custom:')
        ? '自定义源'
        : '红果短剧';
  return path.join(String(root), sourceDir, `${title}-${suffix}`);
}

/** 稳定短哈希：只用于目录去重，不做安全用途。 */
function idHash(seriesId: string): string {
  // FNV-1a 48 位，够区分同一根目录下的同名剧。
  let hash = 0x811c9dc5n;
  for (const byte of Buffer.from(String(seriesId), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffn;
  }
  return hash.toString(16).padStart(12, '0');
}

/**
 * 文件名模板：支持中文占位符（剧名/集数/标题）与变量名（series_title/vid_index/ep_title）。
 * 返回不含扩展名的名称；模板为空或渲染结果为空时返回 null，由调用方决定回退策略。
 */
export function renderName(
  format: string | null | undefined,
  seriesTitle: string,
  vidIndex: number,
  epTitle = '',
): string | null {
  const template = String(format ?? '').trim();
  if (!template) return null;
  const vars: Record<string, string> = {
    series_title: String(seriesTitle ?? '').trim(),
    vid_index: String(vidIndex).padStart(3, '0'),
    ep_title: String(epTitle ?? '').trim(),
  };
  const zhMap: Record<string, string> = { 剧名: 'series_title', 集数: 'vid_index', 标题: 'ep_title' };
  let name = template
    .replace(/剧名|集数|标题/g, (word) => zhMap[word] ?? word)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (token) => (vars[token] !== undefined ? vars[token] : token));
  name = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  return name || null;
}

/** 组合最终文件路径，并挡住「渲染结果逃出剧集目录」的情况。 */
export function episodeFilePath(
  root: string,
  seriesId: string,
  seriesTitle: string,
  vidIndex: number,
  fileName: string,
): string {
  const dir = seriesDownloadDir(root, seriesId, seriesTitle);
  const file = path.join(dir, fileName.endsWith('.mp4') ? fileName : `${fileName}.mp4`);
  if (!pathInside(dir, file)) throw new Error('下载路径越界，已拒绝写入');
  return file;
}
