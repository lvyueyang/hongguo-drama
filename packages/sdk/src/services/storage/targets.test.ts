/**
 * 用量统计与删除全部（迁移自 4.5 `scripts/check-storage-targets.cjs`）。
 * 唯一不变量：**统计到的目标集 = 删除的目标集**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectEpisodeTargets,
  collectSeriesTargets,
  collectStorageTargets,
  deleteStorageTargets,
  pruneEmptyDirs,
} from './targets.ts';

const dirs: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-targets-'));
  dirs.push(dir);
  return dir;
}

function write(file: string, bytes = 220 * 1024): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectStorageTargets', () => {
  it('统计已移除的剧、可见剧与仅有任务记录的剧（三处都算）', () => {
    const root = tempRoot();
    const a = write(path.join(root, '红果短剧', '已移除但有视频-aaa', '已移除但有视频-001.mp4'));
    const b = write(path.join(root, '红果短剧', '可见剧-bbb', '可见剧-001.mp4'));
    const c = write(path.join(root, '自定义源', '仅有下载任务-ccc', '仅有下载任务-001.mp4'));

    const usage = collectStorageTargets({
      root,
      records: [
        { path: a, seriesId: 'dismissed-a', seriesTitle: '已移除但有视频' },
        { path: b, seriesId: 'visible-b', seriesTitle: '可见剧' },
        { path: c, seriesId: 'task-only-c', seriesTitle: '仅有下载任务' },
      ],
    });

    expect(usage.totalFiles).toBe(3);
    expect(usage.totalBytes).toBe(3 * 220 * 1024);
    expect(usage.groups.map((group) => group.group).sort()).toEqual(['红果短剧', '自定义源']);
    expect(usage.groups.reduce((sum, group) => sum + group.files, 0)).toBe(3);
  });

  it('忽略非自产扩展名、半成品与隐藏目录', () => {
    const root = tempRoot();
    write(path.join(root, '红果短剧', '剧-aaa', '第001集.mp4'));
    write(path.join(root, '红果短剧', '剧-aaa', '第002集.mp4.enc.tmp'));
    write(path.join(root, '红果短剧', '剧-aaa', '第003集.mp4.part'));
    write(path.join(root, '红果短剧', '剧-aaa', '说明.txt'));
    write(path.join(root, '.cache', 'x.mp4'));

    const usage = collectStorageTargets({ root });
    expect(usage.totalFiles).toBe(1);
    expect(usage.targets[0]?.path.endsWith('第001集.mp4')).toBe(true);
  });

  it('root 不存在或为空时返回零，不抛错', () => {
    const root = tempRoot();
    expect(collectStorageTargets({ root: path.join(root, 'missing') })).toMatchObject({
      totalFiles: 0,
      totalBytes: 0,
    });
    expect(collectStorageTargets({ root })).toMatchObject({ totalFiles: 0, totalBytes: 0 });
    expect(collectStorageTargets({ root: '' })).toMatchObject({ totalFiles: 0 });
  });

  it('导出的同名文字文件也计入（与视频同目录）', () => {
    const root = tempRoot();
    write(path.join(root, '红果短剧', '剧-aaa', '第001集.mp4'));
    write(path.join(root, '红果短剧', '剧-aaa', '第001集.danmaku.json'), 1024);
    const usage = collectStorageTargets({ root });
    expect(usage.totalFiles).toBe(2);
  });
});

describe('deleteStorageTargets', () => {
  it('删除的目标数与统计完全一致', () => {
    const root = tempRoot();
    const files = [
      write(path.join(root, '红果短剧', '甲-aaa', '甲-001.mp4')),
      write(path.join(root, '红果短剧', '乙-bbb', '乙-001.mp4')),
      write(path.join(root, '自定义源', '丙-ccc', '丙-001.mp4')),
    ];
    const usage = collectStorageTargets({ root });
    const result = deleteStorageTargets(usage.targets, { root });

    expect(result.deleted).toBe(usage.totalFiles);
    expect(result.bytes).toBe(usage.totalBytes);
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
    expect(collectStorageTargets({ root }).totalFiles).toBe(0);
  });

  it('不碰 root 之外的文件', () => {
    const root = tempRoot();
    const outside = write(path.join(tempRoot(), '别人的视频.mp4'));
    write(path.join(root, '红果短剧', '剧-aaa', '第001集.mp4'));

    const usage = collectStorageTargets({ root });
    // 人为塞一条越界目标：必须被拒绝，并且不删文件。
    const result = deleteStorageTargets([...usage.targets, { path: outside, bytes: 1, group: '' }], { root });
    expect(result.deleted).toBe(1);
    expect(result.failed).toContain(outside);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('root 为空时拒绝删除任何东西', () => {
    const root = tempRoot();
    const file = write(path.join(root, '红果短剧', '剧-aaa', '第001集.mp4'));
    const result = deleteStorageTargets([{ path: file, bytes: 1, group: '' }], { root: '' });
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('单个文件删除失败时继续处理其余文件并记录失败项', () => {
    const root = tempRoot();
    const bad = write(path.join(root, '红果短剧', '甲-aaa', '甲-001.mp4'));
    const good = write(path.join(root, '红果短剧', '乙-bbb', '乙-001.mp4'));
    const usage = collectStorageTargets({ root });
    const result = deleteStorageTargets(usage.targets, {
      root,
      remove: (file) => {
        if (file === bad) throw new Error('被占用');
        fs.rmSync(file, { force: true });
      },
    });
    expect(result.deleted).toBe(1);
    expect(result.failed).toContain(bad);
    expect(fs.existsSync(good)).toBe(false);
    expect(fs.existsSync(bad)).toBe(true);
  });
});

describe('collectSeriesTargets（单剧删除）', () => {
  it('只包含该剧目录下的文件，不牵连别的剧', () => {
    const root = tempRoot();
    const own = write(path.join(root, '红果短剧', '甲-aaa', '甲-001.mp4'));
    const ownMeta = write(path.join(root, '红果短剧', '甲-aaa', '甲-001.danmaku.json'), 512);
    const other = write(path.join(root, '红果短剧', '乙-bbb', '乙-001.mp4'));

    const series = collectSeriesTargets({
      root,
      seriesId: 'jia',
      records: [
        { path: own, seriesId: 'jia', seriesTitle: '甲' },
        { path: other, seriesId: 'yi', seriesTitle: '乙' },
      ],
    });

    expect(series.totalFiles).toBe(2);
    expect(series.targets.map((target) => target.path).sort()).toEqual([own, ownMeta].sort());
    expect(series.targets.some((target) => target.path === other)).toBe(false);
  });

  it('没有任何记录时不删任何东西（避免误删）', () => {
    const root = tempRoot();
    write(path.join(root, '红果短剧', '甲-aaa', '甲-001.mp4'));
    const series = collectSeriesTargets({ root, seriesId: 'jia', records: [] });
    expect(series.totalFiles).toBe(0);
  });

  it('删除后可按目录清理空目录，且不动 root 本身', () => {
    const root = tempRoot();
    const dir = path.join(root, '红果短剧', '甲-aaa');
    write(path.join(dir, '甲-001.mp4'));
    const series = collectSeriesTargets({
      root,
      seriesId: 'jia',
      records: [{ path: path.join(dir, '甲-001.mp4'), seriesId: 'jia' }],
    });
    deleteStorageTargets(series.targets, { root });
    const removed = pruneEmptyDirs(root, [dir, path.join(root, '红果短剧'), root]);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('root 之外的同剧记录不会被纳入', () => {
    const root = tempRoot();
    const outside = write(path.join(tempRoot(), '红果短剧', '甲-aaa', '甲-001.mp4'));
    const series = collectSeriesTargets({
      root,
      seriesId: 'jia',
      records: [{ path: outside, seriesId: 'jia' }],
    });
    expect(series.totalFiles).toBe(0);
  });
});

describe('collectEpisodeTargets（单集删除）', () => {
  it('包含视频、文字导出与半成品残留', () => {
    const root = tempRoot();
    const video = write(path.join(root, '红果短剧', '甲-aaa', '第001集.mp4'));
    const danmaku = write(path.join(root, '红果短剧', '甲-aaa', '第001集.danmaku.json'), 100);
    const tmp = write(path.join(root, '红果短剧', '甲-aaa', '第001集.mp4.enc.tmp'), 50);
    write(path.join(root, '红果短剧', '甲-aaa', '第002集.mp4'));

    const episode = collectEpisodeTargets({ root, savePath: video });
    expect(episode.targets.map((target) => target.path).sort()).toEqual([video, danmaku, tmp].sort());
    expect(episode.totalBytes).toBe(50 + 100 + 220 * 1024);
  });

  it('不牵连同目录里的其它分集', () => {
    const root = tempRoot();
    const first = write(path.join(root, '红果短剧', '甲-aaa', '第001集.mp4'));
    const second = write(path.join(root, '红果短剧', '甲-aaa', '第002集.mp4'));
    const episode = collectEpisodeTargets({ root, savePath: first });
    expect(episode.targets.some((target) => target.path === second)).toBe(false);
  });

  it('root 之外的路径一律返回空', () => {
    const root = tempRoot();
    const outside = write(path.join(tempRoot(), '别人的.mp4'));
    expect(collectEpisodeTargets({ root, savePath: outside }).totalFiles).toBe(0);
    expect(collectEpisodeTargets({ root: '', savePath: outside }).totalFiles).toBe(0);
  });
});
