/**
 * 文字导出（迁移自 4.5 `src/native/text-export.test.cjs`）。
 *
 * 这块最怕的是「静默丢数据」：部分结果被写成一个看起来完整的文件、写盘失败把原文件覆盖掉、
 * 同一目标被两批请求同时写、锁集评论失败留下一堆空文件。用例按这几个风险点组织：
 * 落盘位置与文档形状、partial/失败的原文件保护、原子写与目标锁、并发上限、无效路径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSeriesText } from './text-export.ts';

const SID = '7503745441910017049';
const VID = '7503780574541122622';

const tally = (ok = 0, fail = 0, skipped = 0, partial = 0, items = ok, empty = 0, unavailable = 0) => ({
  ok,
  fail,
  skipped,
  partial,
  items,
  empty,
  unavailable,
});

const danmaku = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  source: 'official',
  series_id: SID,
  episode_id: VID,
  items: [{ time: 1.5, text: '冲', color: '#FFFFFF', mode: 'scroll' }],
  total: 1,
  truncated: false,
  partial: false,
  error: '',
  notice: '',
  ...overrides,
});

const read = (target: string) => JSON.parse(fs.readFileSync(target, 'utf8'));

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-text-export-'));
  dirs.push(dir);
  const savePath = path.join(dir, '旧目录', '自定前缀_冲突修复.MP4');
  const target = savePath.replace(/\.mp4$/i, '.danmaku.json');
  // 替身对象按用例替换单个抓取器，类型放宽以免每处赋值都要重写签名。
  const fetchers: any = {
    danmaku: { fetchDanmaku: vi.fn(async () => danmaku()) },
    fetchEpisodeComments: vi.fn(async () => ({
      success: true,
      series_id: SID,
      episode_id: VID,
      items: [{ id: 'a', content: '好看' }],
      total: 10,
      source_limited: true,
      notice: '部分评论',
    })),
    fetchPublicDetails: vi.fn(async () => ({
      success: true,
      series_id: SID,
      reviews: { total: 20, items: [{ author: 'u', content: '剧评', created_at: 123, likes: 2, rating: 5 }] },
    })),
  };
  const options: any = {
    seriesId: SID,
    seriesTitle: '测试剧',
    episodes: [{ vid: VID, vid_index: 1, savePath }],
    kinds: { danmaku: true, comments: true, reviews: true },
    reviewsPath: path.join(dir, '整剧.reviews.json'),
    fetchers,
    now: () => 123456789,
  };
  return { dir, target, fetchers, options };
}

describe('文档形状与落盘位置', () => {
  it('三类 JSON 跟随视频实际路径与 reviewsPath，保留来源与受限统计', async () => {
    const { dir, target, options, fetchers } = setup();
    const result = await exportSeriesText(options);
    expect(result.danmaku).toEqual(tally(1));
    expect(result.comments).toEqual(tally(1, 0, 0, 1));
    expect(result.reviews).toEqual(tally(1, 0, 0, 1));
    expect(read(target)).toEqual({
      kind: 'danmaku',
      series_id: SID,
      episode_id: VID,
      episode_index: 1,
      series_title: '测试剧',
      source: 'official',
      fetched_at: 123456789,
      truncated: false,
      partial: false,
      notice: '',
      items: danmaku().items,
    });
    const comments = read(target.replace('.danmaku.json', '.comments.json'));
    expect(comments).toMatchObject({
      kind: 'comments',
      series_id: SID,
      episode_id: VID,
      episode_index: 1,
      total: 10,
      source_limited: true,
      partial: true,
      notice: '部分评论',
      items: [{ id: 'a', content: '好看' }],
    });
    const reviews = read(options.reviewsPath);
    expect(reviews).toMatchObject({ kind: 'reviews', series_id: SID, total: 20, partial: true });
    expect(reviews.items[0]).toMatchObject({ author: 'u', content: '剧评', likes: 2, rating: 5 });
    expect(fetchers.fetchEpisodeComments.mock.calls[0][0]).toEqual({
      seriesId: SID,
      episodeId: VID,
      cursor: null,
      limit: 30,
    });
    expect(fetchers.fetchPublicDetails.mock.calls[0]).toEqual([SID, '', { reviewsLimit: 1000 }]);
    expect(result.files).toHaveLength(3);
    expect(result.files).toContain(options.reviewsPath);
    expect(fs.readdirSync(dir).sort()).toEqual(['旧目录', '整剧.reviews.json'].sort());
  });

  it('空弹幕明确统计为零条且仍是成功，JSON 使用可读缩进', async () => {
    const { target, options, fetchers } = setup();
    fetchers.danmaku.fetchDanmaku = vi.fn(async () =>
      danmaku({ items: [], total: 0, notice: '本集暂无弹幕' }),
    );
    const result = await exportSeriesText({ ...options, kinds: { danmaku: true } });
    expect(result.danmaku).toEqual(tally(1, 0, 0, 0, 0, 1));
    expect(fs.readFileSync(target, 'utf8')).toMatch(/^\{\n {2}"kind": "danmaku"/);
  });

  it('截断或来源受限的结果都标 partial，真实零条成功仍生成 JSON', async () => {
    const { target, options, fetchers } = setup();
    fetchers.danmaku.fetchDanmaku = vi.fn(async () => danmaku({ truncated: true, notice: '条数受限' }));
    fetchers.fetchEpisodeComments = vi.fn(async () => ({
      success: true,
      items: [],
      total: 0,
      source_limited: false,
    }));
    fetchers.fetchPublicDetails = vi.fn(async () => ({ success: true, reviews: { total: 0, items: [] } }));
    const result = await exportSeriesText(options);
    expect(result.danmaku).toEqual(tally(1, 0, 0, 1));
    expect(read(target).partial).toBe(true);
    expect(result.comments).toEqual(tally(1, 0, 0, 0, 0, 1));
    expect(result.reviews).toEqual(tally(1, 0, 0, 0, 0, 1));
    expect(read(options.reviewsPath).items).toEqual([]);
  });
});

describe('未选类型与非红果编号：不请求、不落盘', () => {
  it('没选任何类型时什么都不做', async () => {
    const { dir, options, fetchers } = setup();
    const result = await exportSeriesText({ ...options, kinds: {} });
    expect(result).toEqual({ danmaku: tally(), comments: tally(), reviews: tally(), files: [] });
    expect(fetchers.danmaku.fetchDanmaku).not.toHaveBeenCalled();
    expect(fetchers.fetchEpisodeComments).not.toHaveBeenCalled();
    expect(fetchers.fetchPublicDetails).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('非红果编号按集数计 skipped，不发起任何请求', async () => {
    const { dir, options, fetchers } = setup();
    for (const seriesId of ['xifan:1', 'hema:1', 'custom:1', '123', '../123456']) {
      const result = await exportSeriesText({ ...options, seriesId, kinds: { comments: true } });
      expect(result, seriesId).toEqual({
        danmaku: tally(),
        comments: tally(0, 0, 1),
        reviews: tally(),
        files: [],
      });
    }
    expect(fetchers.fetchEpisodeComments).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('已有文件的复用与重试', () => {
  it('完整文件跳过且不重复请求；兼容没有 partial 字段的旧文件', async () => {
    const { target, options, fetchers } = setup();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ kind: 'danmaku', items: [{ text: '旧数据' }] });
    fs.writeFileSync(target, original);
    fetchers.danmaku.fetchDanmaku = vi.fn(async () => {
      throw new Error('不应重取');
    });
    const result = await exportSeriesText({ ...options, kinds: { danmaku: true } });
    expect(result.danmaku).toEqual(tally(0, 0, 1, 0, 1));
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(result.files).toEqual([]);
  });

  it('首次翻页中断标 partial 并计 ok；重试用 fresh 绕过缓存并原子替换', async () => {
    const { target, options, fetchers } = setup();
    options.kinds = { danmaku: true };
    let calls = 0;
    fetchers.danmaku.fetchDanmaku = vi.fn(async (args: any) => {
      calls += 1;
      expect(args.fresh).toBe(calls > 1);
      return calls === 1
        ? danmaku({ success: false, partial: true, notice: '后续弹幕加载中断' })
        : danmaku({
            items: [...danmaku().items, { time: 2, text: '新数据', color: '#FFFFFF', mode: 'scroll' }],
          });
    });
    expect((await exportSeriesText(options)).danmaku).toEqual(tally(1, 0, 0, 1));
    expect(read(target).partial).toBe(true);
    expect((await exportSeriesText(options)).danmaku).toEqual(tally(1, 0, 0, 0, 2));
    expect(read(target).partial).toBe(false);
    expect(read(target).items).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it('partial 旧文件重试失败（返回失败/部分失败/抛异常）时原文件字节不变', async () => {
    const { target, options, fetchers } = setup();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ partial: true, items: [{ text: '保留' }] });
    fs.writeFileSync(target, original);
    options.kinds = { danmaku: true };
    for (const failure of [
      async () => ({ success: false }),
      async () => danmaku({ success: false, partial: true }),
      async () => {
        throw new Error('offline');
      },
    ]) {
      fetchers.danmaku.fetchDanmaku = vi.fn(async (args: any) => {
        expect(args.fresh).toBe(true);
        return failure();
      });
      const result = await exportSeriesText(options);
      expect(result.danmaku).toEqual(tally(0, 1));
      expect(result.files).toEqual([]);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
    }
  });

  it('锁集评论单独统计未开放，不建空文件也不覆盖已有部分评论', async () => {
    const { target, options, fetchers } = setup();
    const comments = target.replace('.danmaku.json', '.comments.json');
    options.kinds = { comments: true };
    fetchers.fetchEpisodeComments = vi.fn(async () => ({
      success: false,
      source_limited: true,
      code: 'EPISODE_COMMENTS_UNAVAILABLE',
      error: '官网未开放本集评论',
    }));
    expect((await exportSeriesText(options)).comments).toEqual(tally(0, 0, 0, 0, 0, 0, 1));
    expect(fs.existsSync(comments)).toBe(false);

    fs.mkdirSync(path.dirname(comments), { recursive: true });
    const old = JSON.stringify({ partial: true, items: [{ content: '保留' }] });
    fs.writeFileSync(comments, old);
    expect((await exportSeriesText(options)).comments).toEqual(tally(0, 0, 0, 0, 0, 0, 1));
    expect(fs.readFileSync(comments, 'utf8')).toBe(old);

    // 来源受限但不是「未开放」时只能算失败
    fetchers.fetchEpisodeComments = vi.fn(async () => ({
      success: false,
      source_limited: true,
      error: '其他错误',
    }));
    expect((await exportSeriesText(options)).comments.fail).toBe(1);
  });
});

describe('原子写与并发', () => {
  it('写入或改名失败保留旧文件、清理临时文件，并释放目标锁供重试', async () => {
    const { target, options } = setup();
    options.kinds = { danmaku: true };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ partial: true, items: [] });
    fs.writeFileSync(target, original);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk error');
    });
    expect((await exportSeriesText(options)).danmaku).toEqual(tally(0, 1));
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
    rename.mockRestore();
    expect((await exportSeriesText(options)).danmaku).toEqual(tally(1));
  });

  it('同一目标的跨批并发只取写一次，迟到的结果不会覆盖先写的', async () => {
    const { target, options, fetchers } = setup();
    options.kinds = { danmaku: true };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    fetchers.danmaku.fetchDanmaku = vi.fn(async () => {
      calls += 1;
      await blocked;
      return danmaku();
    });
    const first = exportSeriesText(options);
    const second = exportSeriesText({
      ...options,
      fetchers: { ...fetchers, danmaku: { fetchDanmaku: vi.fn(async () => danmaku({ items: [] })) } },
    });
    release();
    const results = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(read(target).items).toHaveLength(1);
    for (const result of results) expect(result.danmaku.fail).toBe(0);
  });

  it('默认每批最多四集并发，单集与剧评异常不影响其余文件', async () => {
    const { dir, options, fetchers } = setup();
    options.episodes = Array.from({ length: 9 }, (_, index) => ({
      vid: String(BigInt(VID) + BigInt(index)),
      vid_index: index + 1,
      savePath: path.join(dir, `集${index}.mp4`),
    }));
    let active = 0;
    let peak = 0;
    fetchers.danmaku.fetchDanmaku = vi.fn(async ({ vid }: { vid: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (vid === VID) throw new Error('单集offline');
      return danmaku({ episode_id: vid });
    });
    fetchers.fetchPublicDetails = vi.fn(async () => {
      throw new Error('剧评offline');
    });
    const result = await exportSeriesText(options);
    expect(peak).toBe(4);
    expect(result.danmaku).toEqual(tally(8, 1));
    expect(result.comments).toEqual(tally(9, 0, 0, 9));
    expect(result.reviews).toEqual(tally(0, 1));
    expect(result.files).toHaveLength(17);
  });

  it('目标路径无效时只让该项失败，不写相对路径也不影响其他文件', async () => {
    const { dir, options } = setup();
    options.episodes = [
      { vid: VID, vid_index: 1, savePath: 'relative.mp4' },
      { vid: VID, vid_index: 2, savePath: path.join(dir, '错误.txt') },
      options.episodes[0],
    ];
    options.reviewsPath = undefined;
    const result = await exportSeriesText(options);
    expect(result.danmaku).toEqual(tally(1, 2));
    expect(result.comments).toEqual(tally(1, 2, 0, 1));
    expect(result.reviews).toEqual(tally(0, 1));
    expect(result.files).toHaveLength(2);
    expect(fs.existsSync(path.join(process.cwd(), 'relative.danmaku.json'))).toBe(false);
  });
});
