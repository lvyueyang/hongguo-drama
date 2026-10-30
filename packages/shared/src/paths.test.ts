import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { episodeFilePath, pathInside, renderName, sanitizeFolderName, seriesDownloadDir } from './paths.ts';

describe('sanitizeFolderName（目录名安全）', () => {
  it('去掉路径分隔符，阻断目录穿越', () => {
    expect(sanitizeFolderName('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeFolderName('a/b\\c')).toBe('abc');
    expect(sanitizeFolderName('..\\..\\windows')).toBe('....windows');
    expect(sanitizeFolderName('剧名/../逃逸')).toBe('剧名..逃逸');
  });

  it('去掉 Windows 非法字符与控制字符', () => {
    expect(sanitizeFolderName('a<>:"|?*b')).toBe('ab');
    expect(sanitizeFolderName('a\u0000\u001fb')).toBe('ab');
  });

  it('避开 Windows 保留名', () => {
    expect(sanitizeFolderName('con')).toBe('_con');
    expect(sanitizeFolderName('NUL.txt')).toBe('_NUL.txt');
    expect(sanitizeFolderName('com1')).toBe('_com1');
    expect(sanitizeFolderName('console')).toBe('console');
  });

  it('按码位截断，不劈开 emoji，且去掉结尾的点与空格', () => {
    const emoji = '🎬'.repeat(100);
    expect(Array.from(sanitizeFolderName(emoji)).length).toBe(80);
    expect(sanitizeFolderName('剧名. . ')).toBe('剧名');
  });
});

describe('pathInside（越界判断）', () => {
  const root = '/tmp/hongguo-root';

  it('root 自身与其子路径算在内', () => {
    expect(pathInside(root, root)).toBe(true);
    expect(pathInside(root, path.join(root, 'a/b.mp4'))).toBe(true);
  });

  it('挡住 .. 穿越与绝对路径替换', () => {
    expect(pathInside(root, path.join(root, '../evil.mp4'))).toBe(false);
    expect(pathInside(root, '/etc/passwd')).toBe(false);
    expect(pathInside(root, path.join(root, 'a/../../evil'))).toBe(false);
  });

  it('同前缀但不同目录不算在内', () => {
    expect(pathInside(root, '/tmp/hongguo-root-evil/a.mp4')).toBe(false);
  });

  it('空值一律拒绝', () => {
    expect(pathInside('', '/tmp/a')).toBe(false);
    expect(pathInside('/tmp', '')).toBe(false);
  });
});

describe('seriesDownloadDir（剧集目录）', () => {
  it('按来源分目录，并把剧名与 id 哈希拼成唯一目录名', () => {
    const red = seriesDownloadDir('/downloads', '7654321098765432109', '一村人养一个神第一季');
    expect(red.startsWith(path.join('/downloads', '红果短剧'))).toBe(true);
    expect(red).toContain('一村人养一个神第一季-');
    expect(seriesDownloadDir('/downloads', 'hema:123', '河马剧').includes('河马短剧')).toBe(true);
    expect(seriesDownloadDir('/downloads', 'xifan:a:b', '西饭剧').includes('西饭短剧')).toBe(true);
  });

  it('同名不同剧不共用目录', () => {
    const a = seriesDownloadDir('/downloads', '111111111111', '同名剧');
    const b = seriesDownloadDir('/downloads', '222222222222', '同名剧');
    expect(a).not.toBe(b);
  });

  it('剧名带穿越内容时仍落在 root 之内', () => {
    const dir = seriesDownloadDir('/downloads', '111111111111', '../../evil');
    expect(pathInside('/downloads', dir)).toBe(true);
  });

  it('剧名为空或全是非法字符时回落到占位名', () => {
    expect(seriesDownloadDir('/downloads', '111111111111', '')).toContain('未命名短剧');
    expect(seriesDownloadDir('/downloads', '111111111111', '<>:"|?*')).toContain('未命名短剧');
  });
});

describe('renderName（命名模板）', () => {
  it('支持中文占位符与变量名', () => {
    expect(renderName('剧名 集数', '某剧', 7)).toBe('某剧 007');
    expect(renderName('series_title-vid_index', '某剧', 12)).toBe('某剧-012');
    expect(renderName('剧名 集数 标题', '某剧', 3, '大结局')).toBe('某剧 003 大结局');
  });

  it('模板为空返回 null，交给调用方回退', () => {
    expect(renderName('', '某剧', 1)).toBeNull();
    expect(renderName(null, '某剧', 1)).toBeNull();
  });

  it('模板里的未知变量保持原样，不做猜测替换', () => {
    expect(renderName('剧名 other_var', '某剧', 1)).toBe('某剧 other_var');
  });

  it('渲染结果里的非法字符被替换，且压缩空白', () => {
    expect(renderName('剧名 集数', 'a/b', 1)).toBe('a_b 001');
    expect(renderName('剧名   集数', '某剧', 1)).toBe('某剧 001');
  });
});

describe('episodeFilePath（组合路径并复核越界）', () => {
  it('正常文件名落在剧集目录内', () => {
    const file = episodeFilePath('/downloads', '111111111111', '某剧', 1, '第01集.mp4');
    expect(pathInside(seriesDownloadDir('/downloads', '111111111111', '某剧'), file)).toBe(true);
    expect(file.endsWith('.mp4')).toBe(true);
  });

  it('文件名试图穿越时直接抛错，不落盘', () => {
    expect(() => episodeFilePath('/downloads', '111111111111', '某剧', 1, '../../evil.mp4')).toThrow(/越界/);
    // path.join 不会因为第二个参数是绝对路径就跳目录，它仍落在剧集目录内；这里断言它没有逃逸
    const absolute = episodeFilePath('/downloads', '111111111111', '某剧', 1, '/etc/passwd');
    expect(pathInside(seriesDownloadDir('/downloads', '111111111111', '某剧'), absolute)).toBe(true);
  });
});
