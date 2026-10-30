// 迁移自 4.5 src/native/custom-source.js（破坏性重构 M1）。算法未改动，仅模块语法转为 ESM。

import axios from 'axios';
import { isPublicMediaUrl, webMediaRequestOptions } from '../../internal/net/guard.ts';
import store from '../../services/storage/store.ts';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ID = /^\d{1,30}$/;
const USER_AGENT = 'Mozilla/5.0';
const activeRequests = new Map();
const plainText = (value) => (typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : '');

function validateSource(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('自定义源配置无效');
  const name = plainText(draft.name);
  if (!name || name.length > 80) throw new Error('来源名称需为 1 至 80 个字符');
  if (draft.id != null && !UUID.test(String(draft.id))) throw new Error('自定义源编号无效');
  if (typeof draft.url !== 'string' || draft.url.length > 4096 || !isPublicMediaUrl(draft.url)) {
    throw new Error('接口需为不含账号密码的公网 HTTP 或 HTTPS 地址');
  }
  const url = new URL(draft.url);
  if (url.pathname === '/') url.pathname = '/api.php/provide/vod/';
  url.hash = '';
  return {
    ...(draft.id == null ? {} : { id: String(draft.id).toLowerCase() }),
    name,
    url: url.href,
    enabled: draft.enabled !== false,
  };
}

function sourceId(value) {
  const parts = String(value || '').split(':');
  const id = parts[0] === 'custom' ? parts[1] : parts[0];
  if (!UUID.test(id || '')) throw new Error('自定义源编号无效');
  return id.toLowerCase();
}

function assertEnabled(value) {
  const id = sourceId(value);
  const sources = store.getSettings().custom_sources;
  const source = Array.isArray(sources) && sources.find((item) => String(item?.id).toLowerCase() === id);
  if (!source || source.enabled !== true) throw new Error('该自定义源已禁用或删除');
  return validateSource(source);
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (
    parts[0] !== 'custom' ||
    parts.length !== (episode ? 5 : 3) ||
    !UUID.test(parts[1]) ||
    !ID.test(parts[2]) ||
    (episode && !parts.slice(3).every((part) => /^\d{1,5}$/.test(part)))
  )
    throw new Error('自定义剧集编号无效');
  return {
    id: parts[1].toLowerCase(),
    vodId: parts[2],
    seriesId: `custom:${parts[1].toLowerCase()}:${parts[2]}`,
    line: Number(parts[3]),
    episode: Number(parts[4]),
  };
}

function cancelRequests(value) {
  const requests = activeRequests.get(sourceId(value));
  if (requests) for (const controller of requests) controller.abort();
}

async function request(source, params, draft = false) {
  const check = () => {
    if (!draft && assertEnabled(source.id).url !== source.url) throw new Error('来源配置已变更，请重新加载');
  };
  check();
  const url = new URL(source.url);
  for (const key of ['ac', 'pg', 't', 'wd', 'ids', 'at']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries<any>({ ac: 'detail', at: 'json', ...params }))
    url.searchParams.set(key, String(value));
  const guard = webMediaRequestOptions(url.href);
  const controller = new AbortController();
  const requests = activeRequests.get(source.id) || new Set();
  activeRequests.set(source.id, requests);
  requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    // axios 的配置联合类型不接受迁移代码里的宽松字面量（responseType/lookup/beforeRedirect 等），
    // 这里把整个配置断言到 any：这些字段来自 web-media-guard，本身也是宽松类型。
    const response = await axios.get(url.href, {
      // Proxy selection follows app settings; the selected proxy owns final destination DNS.
      ...guard,
      adapter: 'http',
      timeout: 12000,
      signal: controller.signal,
      maxContentLength: 8 * 1024 * 1024,
      maxBodyLength: 1024,
      responseType: 'text',
      transformResponse: [(data) => data],
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      lookup(hostname, options, callback) {
        try {
          check();
        } catch (error) {
          callback(error);
          return;
        }
        guard.lookup(hostname, options, (error, ...result) => {
          if (error) {
            callback(error);
            return;
          }
          try {
            check();
          } catch (failure) {
            callback(failure);
            return;
          }
          callback(null, ...result);
        });
      },
      beforeRedirect(options, response, request) {
        check();
        guard.beforeRedirect(options, response, request);
      },
    } as never);
    check();
    let data;
    try {
      data = JSON.parse(response.data);
    } catch (_) {
      throw new Error('自定义源未返回有效 JSON');
    }
    if (!data || Number(data.code) !== 1 || !Array.isArray(data.list) || data.list.length > 500) {
      throw new Error('自定义源返回的苹果 CMS 数据无效');
    }
    return data;
  } catch (error) {
    // Never forward remote messages or Axios diagnostics containing signed URLs.
    if (/^(自定义源|该自定义源|来源配置)/.test(error.message)) throw error;
    throw new Error(
      controller.signal.aborted || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)
        ? '自定义源请求已取消或超时，请重试'
        : '自定义源请求失败，请检查公网接口与网络',
    );
  } finally {
    clearTimeout(timer);
    requests.delete(controller);
    if (!requests.size && activeRequests.get(source.id) === requests) activeRequests.delete(source.id);
  }
}

function isLocked(item) {
  return (
    item.locked === true ||
    Number(item.vod_points_play) > 0 ||
    Number(item.vod_points) > 0 ||
    !!String(item.vod_pwd_play || item.vod_pwd || '').trim()
  );
}

function normalizeItem(item, source) {
  if (!item || !ID.test(String(item.vod_id)) || !plainText(item.vod_name)) return null;
  return {
    series_id: `custom:${source.id}:${item.vod_id}`,
    series_title: plainText(item.vod_name),
    cover: isPublicMediaUrl(item.vod_pic) ? item.vod_pic : '',
    episode_count: Number(item.vod_total) || 0,
    intro: plainText(item.vod_content),
    tags: plainText(item.type_name) ? [plainText(item.type_name)] : [],
    source: `custom:${source.id}`,
    locked: isLocked(item),
  };
}

function pageResult(data, source, page) {
  if (data.page != null && Number(data.page) !== page) throw new Error('自定义源返回的页码不一致');
  const seen = new Set();
  const results = data.list
    .map((item) => normalizeItem(item, source))
    .filter((item) => {
      if (!item || seen.has(item.series_id)) return false;
      seen.add(item.series_id);
      return true;
    });
  const totalPages = Math.max(0, Number.parseInt(data.pagecount, 10) || 0);
  const endpoint = new URL(source.url);
  return {
    success: true,
    results,
    page,
    total: Math.max(0, Number.parseInt(data.total, 10) || 0),
    totalPages,
    hasMore: results.length > 0 && page < totalPages,
    nextPage: results.length > 0 && page < totalPages ? page + 1 : null,
    genres: (Array.isArray(data.class) ? data.class : [])
      .slice(0, 500)
      .filter((item) => ID.test(String(item?.type_id)) && plainText(item.type_name))
      .map((item) => ({ slug: String(item.type_id), label: plainText(item.type_name) })),
    pageTitle: source.name,
    sourceUrl: endpoint.origin + endpoint.pathname,
  };
}

async function fetchCatalog({ source, genre = '', page = 1 }: any = {}) {
  try {
    const config = assertEnabled(source),
      pg = Number(page);
    if (!Number.isSafeInteger(pg) || pg < 1 || pg > 100000 || (genre && !ID.test(String(genre))))
      throw new Error('自定义源分类或页码无效');
    const data = await request(config, { pg, ...(genre ? { t: genre } : {}) });
    return pageResult(data, config, pg);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function searchSeries(keyword, { source, page = 1 }: any = {}) {
  try {
    const config = assertEnabled(source),
      pg = Number(page),
      wd = String(keyword || '').trim();
    if (!wd || wd.length > 200 || !Number.isSafeInteger(pg) || pg < 1 || pg > 100000)
      throw new Error('自定义源搜索词或页码无效');
    return pageResult(await request(config, { wd, pg }), config, pg);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function detail(seriesId) {
  const id = parseId(seriesId),
    source = assertEnabled(id.id);
  const data = await request(source, { ids: id.vodId });
  if (data.list.length !== 1 || String(data.list[0]?.vod_id) !== id.vodId)
    throw new Error('自定义源返回的剧集与请求不一致');
  const item = data.list[0];
  if (!normalizeItem(item, source)) throw new Error('自定义源详情无效');
  return { id, source, item };
}

function episodeKey(title) {
  const number = title.match(/^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/);
  return number ? `number:${Number(number[1])}` : title;
}

function mediaLines(item) {
  const names = String(item.vod_play_from || '').split('$$$');
  return String(item.vod_play_url || '')
    .split('$$$')
    .slice(0, 32)
    .map((line, lineIndex) => ({
      line: lineIndex,
      name: plainText(names[lineIndex]),
      episodes: line
        .split('#')
        .slice(0, 10000)
        .map((entry, episodeIndex) => {
          const split = entry.indexOf('$');
          if (split < 1) return null;
          const title = plainText(entry.slice(0, split)),
            value = entry.slice(split + 1).trim();
          if (!title || !isPublicMediaUrl(value)) return null;
          const url = new URL(value),
            extension = url.pathname.match(/\.(mp4|m3u8)$/i)?.[1].toLowerCase();
          if (!extension) return null;
          return {
            title,
            key: episodeKey(title),
            url: url.href,
            format: extension === 'm3u8' ? 'hls' : 'mp4',
            line: lineIndex,
            episode: episodeIndex,
          };
        })
        // 过滤掉解析失败的分集（null），避免下游拿到可空元素
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    }))
    .filter((line) => line.episodes.length);
}

async function fetchEpisodeList(seriesId) {
  const { id, source, item } = await detail(seriesId);
  const lines = mediaLines(item).sort((a, b) => b.episodes.length - a.episodes.length);
  if (!lines.length) throw new Error('该剧没有可直接播放的 MP4 或 M3U8 分集，不支持网页解析');
  const normalized = normalizeItem(item, source);
  // 归一化失败说明来源数据不可信：这里显式失败，而不是带着 null 继续拼分集。
  if (!normalized) throw new Error('自定义源返回的剧集信息不完整');
  const seen = new Set<string>();
  const episodes = lines[0]!.episodes
    .filter((episode) => {
      if (seen.has(episode.key)) return false;
      seen.add(episode.key);
      return true;
    })
    .map((episode, index) => ({
      vid: `${id.seriesId}:${episode.line}:${episode.episode}`,
      vid_index: index + 1,
      title: episode.title,
      series_id: id.seriesId,
      series_title: normalized.series_title,
      cover: normalized.cover,
      locked: normalized.locked,
      source: normalized.source,
    }));
  return { ...normalized, total: episodes.length, episodes };
}

async function fetchPlayUrlSingle(vid, sid, options: any = {}) {
  try {
    const id = parseId(vid, true);
    if (sid != null && sid !== '' && parseId(sid).seriesId !== id.seriesId)
      throw new Error('自定义分集不属于当前剧集');
    const { source, item } = await detail(id.seriesId);
    if (isLocked(item))
      return {
        url: null,
        source: 'custom',
        locked: true,
        error: '该剧当前需付费或密码，请在来源平台确认观看权限',
      };
    const lines = mediaLines(item);
    const selected = lines
      .find((line) => line.line === id.line)
      ?.episodes.find((episode) => episode.episode === id.episode);
    if (!selected) throw new Error('自定义源未找到可直接播放的分集');
    const candidates = [
      selected,
      ...lines.flatMap((line) => line.episodes.filter((episode) => episode.key === selected.key)),
    ]
      .filter((episode, index, all) => all.findIndex((other) => other.url === episode.url) === index)
      .map((episode) => ({
        url: episode.url,
        format: episode.format,
        source: 'custom',
        spadeA: null,
        codec: '',
        vid: `${id.seriesId}:${episode.line}:${episode.episode}`,
        userAgent: USER_AGENT,
        referer: new URL(source.url).origin + '/',
      }));
    return { ...candidates[0], candidates };
  } catch (error) {
    return { url: null, source: 'custom', spadeA: null, codec: null, error: error.message };
  }
}

async function testCustomSource(draft) {
  try {
    const source = validateSource(draft);
    const data = await request(source, { pg: 1 }, true);
    return { success: true, count: data.list.length, genres: pageResult(data, source, 1).genres };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export default {
  validateSource,
  validateCustomSource: validateSource,
  testCustomSource,
  assertEnabled,
  cancelRequests,
  fetchCatalog,
  browseList: fetchCatalog,
  searchSeries,
  fetchEpisodeList,
  fetchPlayUrlSingle,
};
