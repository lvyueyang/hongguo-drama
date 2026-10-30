// 迁移自 4.5 src/native/text-export.js（破坏性重构 M1）。算法未改动，仅模块语法转为 ESM。
import danmaku from '../danmaku/index.ts';

const fetchDanmaku = danmaku.fetchDanmaku;

import fs from 'node:fs';
import path from 'node:path';
import { fetchPublicDetails } from '../../providers/hongguo-web/details.ts';
import { fetchEpisodeComments } from '../comments/index.ts';

// Adapted from jayeeliu's PR #61, with path, partial-result and concurrent-write fixes (GPL-3.0).

const HONGGUO_ID = /^\d{6,30}$/;
const pending = new Map();

function writeJsonAtomic(target, obj) {
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw error;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

const isPartial = (data) =>
  data.partial === true ||
  data.truncated === true ||
  data.source_limited === true ||
  (Number.isFinite(data.total) && Array.isArray(data.items) && data.total > data.items.length);

function danmakuDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return {
    kind: 'danmaku',
    series_id: String(seriesId),
    episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index),
    series_title: seriesTitle,
    source: data.source || 'official',
    fetched_at: fetchedAt,
    truncated: data.truncated === true,
    partial: isPartial(data),
    notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map((it) => ({
      time: it.time,
      text: it.text,
      color: it.color || '',
      mode: it.mode || '',
    })),
  };
}

function commentsDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return {
    kind: 'comments',
    series_id: String(seriesId),
    episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index),
    series_title: seriesTitle,
    fetched_at: fetchedAt,
    total: data.total ?? null,
    source_limited: data.source_limited === true,
    partial: isPartial(data),
    notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map((it) => ({ id: it.id, content: it.content })),
  };
}

function reviewsDoc({ seriesId, seriesTitle }, reviews, fetchedAt) {
  return {
    kind: 'reviews',
    series_id: String(seriesId),
    series_title: seriesTitle,
    fetched_at: fetchedAt,
    total: reviews.total ?? null,
    partial: isPartial(reviews),
    items: (Array.isArray(reviews.items) ? reviews.items : []).map((it) => ({
      author: it.author,
      avatar: it.avatar || '',
      content: it.content,
      created_at: it.created_at ?? null,
      likes: it.likes ?? null,
      rating: it.rating ?? null,
    })),
  };
}

async function writeOne(target, build, fetch) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return { status: 'fail' };
  target = path.resolve(target);
  if (pending.has(target)) return pending.get(target);
  const task = (async () => {
    try {
      let retry = false;
      try {
        const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (previous?.partial !== true)
          return {
            status: 'skipped',
            itemCount: Array.isArray(previous?.items) ? previous.items.length : undefined,
          };
        retry = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const data = await fetch(retry);
      if (
        data?.success === false &&
        data.source_limited === true &&
        data.code === 'EPISODE_COMMENTS_UNAVAILABLE'
      )
        return { status: 'unavailable' };
      // Failed retries preserve the original partial file, even when the retry returns some items.
      if (!data || (data.success !== true && (retry || data.partial !== true))) return { status: 'fail' };
      const doc = build(data);
      writeJsonAtomic(target, doc);
      return { status: 'ok', partial: doc.partial === true, itemCount: doc.items.length, target };
    } catch (_) {
      return { status: 'fail' };
    }
  })();
  pending.set(target, task);
  try {
    return await task;
  } finally {
    pending.delete(target);
  }
}

async function exportSeriesText(options: any = {}) {
  const {
    seriesId,
    seriesTitle,
    episodes = [],
    kinds = {},
    reviewsPath,
    reviewsLimit = 1000,
    concurrency = 4,
    fetchers = { fetchDanmaku, fetchEpisodeComments, fetchPublicDetails },
    now = () => Date.now(),
  } = options;
  const tally = () => ({ ok: 0, fail: 0, skipped: 0, partial: 0, items: 0, empty: 0, unavailable: 0 });
  const out: any = { danmaku: tally(), comments: tally(), reviews: tally(), files: [] };
  const wantDanmaku = kinds.danmaku === true,
    wantComments = kinds.comments === true,
    wantReviews = kinds.reviews === true;
  if (!wantDanmaku && !wantComments && !wantReviews) return out;
  if (!HONGGUO_ID.test(String(seriesId))) {
    if (wantDanmaku) out.danmaku.skipped = episodes.length;
    if (wantComments) out.comments.skipped = episodes.length;
    if (wantReviews) out.reviews.skipped = 1;
    return out;
  }

  const record = (kind, result) => {
    out[kind][result.status]++;
    if (Number.isInteger(result.itemCount)) {
      out[kind].items += result.itemCount;
      if (result.itemCount === 0) out[kind].empty++;
    }
    if (result.status === 'ok') {
      if (result.partial) out[kind].partial++;
      if (!out.files.includes(result.target)) out.files.push(result.target);
    }
  };
  if (wantReviews)
    record(
      'reviews',
      await writeOne(
        reviewsPath,
        (d) => reviewsDoc({ seriesId, seriesTitle }, d.reviews, now()),
        () => fetchers.fetchPublicDetails(String(seriesId), '', { reviewsLimit }),
      ),
    );

  if (wantDanmaku || wantComments) {
    const results = await mapLimit(episodes, concurrency, async (ep) => {
      const stem =
        typeof ep?.savePath === 'string' && path.isAbsolute(ep.savePath) && /\.mp4$/i.test(ep.savePath)
          ? ep.savePath.slice(0, -4)
          : null;
      const cell: any = {};
      if (wantDanmaku)
        cell.danmaku = await writeOne(
          stem ? `${stem}.danmaku.json` : null,
          (d) => danmakuDoc({ seriesId, seriesTitle, ep }, d, now()),
          (fresh) => fetchers.danmaku.fetchDanmaku({ seriesId: String(seriesId), vid: ep.vid, fresh }),
        );
      if (wantComments)
        cell.comments = await writeOne(
          stem ? `${stem}.comments.json` : null,
          (d) => commentsDoc({ seriesId, seriesTitle, ep }, d, now()),
          () =>
            fetchers.fetchEpisodeComments({
              seriesId: String(seriesId),
              episodeId: ep.vid,
              cursor: null,
              limit: 30,
            }),
        );
      return cell;
    });
    for (const r of results) {
      if (!r.ok) {
        if (wantDanmaku) out.danmaku.fail++;
        if (wantComments) out.comments.fail++;
        continue;
      }
      if (wantDanmaku) record('danmaku', r.value.danmaku);
      if (wantComments) record('comments', r.value.comments);
    }
  }
  return out;
}

export default {
  exportSeriesText,
};
export { exportSeriesText };
