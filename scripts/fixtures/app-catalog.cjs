// Offline App catalogue fixtures shared by the remaining 4.5 checks
// (`src/components/check-ui-state.cjs`). No upstream requests, account or device files.
// 5.0 的等价用例在 packages/sdk/src/providers/hongguo-app/catalog-fixtures.test.ts；
// 这里保留 JS 版只是因为 check-ui-state.cjs 还在用它当夹具。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../../src/native');
const file = path.join(nativeDir, 'hongguo-app-catalog.js');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const video = (id = '7697209269287914521') => ({ series_id: id, title: '<b>测试</b> &amp; 剧', cover: 'https://img.example/cover.jpg',
  episode_cnt: 100, video_desc: '完整简介', content_type: 1004, sub_title_list: [{ content: '脑洞' }] });
const categoryPayload = (id, next = 37, more = true, contentType = 1) => ({ code: 0, data: { video_data: [{ ...video(id), content_type: contentType }], has_more: more,
  next_offset: next, session_id: 'fixture-session', selector_rows: [
    { type: 'category_dim_theme', items: [{ selector_item_id: 'cate_165', show_name: '悬疑' }, { selector_item_id: 'cate_1219', show_name: '恐怖' }] },
    { type: 'category_dim_role', items: [{ selector_item_id: 'cate_36', show_name: '重生' }] },
  ] } });
const ranks = { 'hot-drama': ['all', 'ranklist_hot_play_sc'], 'hot-real-drama': ['human', 'human_hot_play'],
  'hot-comic-drama': ['comic_series_rank', 'comic_series_hot_play'], 'hot-ai-drama': ['ai_playlet', 'ai_playlet_hot_play'] };
const rankPayload = (category, more = true) => ({ code: 0, data: { has_more: more, next_offset: 29, session_id: 'rank-session',
  cell_view: { cell_data: [{ video_data: { ...video(), content_type: category === 'hot-real-drama' ? 1 : 1004 } }], cell_selector: { outer_row: { items: [{ selector_item_id: ranks[category][0], is_selected: true,
    sub_cell_selector: { outer_row: { items: [{ selector_item_id: ranks[category][1], is_selected: true }] } } }] } } } } });

function fixture(respond = () => categoryPayload()) {
  let now = 1000;
  const calls = [], timers = new Map(); let nextTimer = 0;
  const context = { module: { exports: {} }, Buffer, URL, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === './app-source') return {
        parseSearchInteger: require(path.join(nativeDir, 'app-source')).parseSearchInteger,
        signedMetadataRequest(apiPath, values, body) { return { url: 'https://api5-normal-sinfonlineb.fqnovel.com' + apiPath,
          headers: {}, body: body == null ? null : Buffer.from(JSON.stringify(body)), values }; },
        requestJson(url, options, deadline, signal) {
          const call = { url, options, deadline, signal, body: options.data ? JSON.parse(options.data.toString()) : null };
          // Capture the business query without generating cryptographic signatures in every fixture.
          call.values = signedValues.shift(); calls.push(call);
          return Promise.resolve(respond(call, calls.length));
        },
      };
      if (name === './hongguo-app-search') return require(path.join(nativeDir, 'hongguo-app-search'));
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  const signedValues = [];
  const originalRequire = context.require;
  context.require = name => {
    const dependency = originalRequire(name);
    if (name === './app-source') {
      const sign = dependency.signedMetadataRequest;
      dependency.signedMetadataRequest = (api, values, body) => { signedValues.push(clone(values)); return sign(api, values, body); };
    }
    return dependency;
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { browse: context.module.exports.browseList, calls, advance(ms) { now += ms; for (const [id, timer] of [...timers]) {
    if (timer.at <= now) { timers.delete(id); timer.fn(); }
  } }, timers };
}

// 只在作为夹具被 require 时使用；不单独执行。
module.exports = { fixture, categoryPayload, rankPayload };
