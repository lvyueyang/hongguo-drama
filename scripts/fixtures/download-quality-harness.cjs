// 下载质量/媒体恢复类的 main.js 夹具（原属 check-download-quality-integration.cjs）。
//
// 那个检查已迁成 Vitest（packages/sdk/src/services/media/download.test.ts），
// 但还有别的旧检查（check-player-online-quality.cjs 的 main 段）用它跑真 main.js，
// 所以夹具单独留在这里：谁还在用一眼能看出来，main.js 删掉时一并清理。
// Isolated main-process checks: exercise real task/IPC code without user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../main.js');
const req = createRequire(source);
const dirs = [];
function fixture({ width = 1080, height = 1920, quality = 'auto', realMedia = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-quality-'));
  dirs.push(root);
  const handlers = {}, calls = [], events = [], app = new EventEmitter();
  let settings = { root, download_quality: quality }, saved;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const context = vm.createContext({ require: n => n === 'electron'
    ? { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {} } }
    : n === './src/native/hongguo' ? { fetchPlayUrlSingle: async (...args) => { calls.push(args); return { url: 'https://media.example/video.mp4' }; } }
    : n === './src/store' ? { getSettings: () => settings, saveSettings: s => settings = s,
      saveTasks: tasks => { saved = JSON.parse(JSON.stringify(tasks)); } } : req(n),
    __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
    testEvents: events, testReadStream: () => Readable.from([Buffer.alloc(200000)]), testDimensions: { w: width, h: height, duration: 12, codec: "h264" } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./trusted-ipc.cjs')(context, handlers);
  const run = text => vm.runInContext(text, context);
  run(`globalThis.originalProbeVideoInfo = probeVideoInfo; sendToRenderer = (channel, data) => testEvents.push({channel, data: {...data}}); pumpQueue = () => {};
    requestMedia = async () => ({headers: {'content-length': '200000'}, data: testReadStream()});
    seriesRegistry = [{series_id:'1',series_title:'测试剧',episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]}];`);
  // Synthetic transfers mock validation; realMedia keeps the production probe, decoder and tool discovery.
  if (!realMedia) run(`resolveFfmpeg = () => '/test/ffprobe'; verifyDownloadDecode = async () => {};
    probeVideoInfo = async () => testDimensions;`);
  return { root, context, run, handlers, calls, events, saved: () => saved,
    setQuality: value => { settings.download_quality = value; } };
}
const payload = quality => ({ seriesId: '1', seriesTitle: '测试剧', episodes: [{vid:'11',vid_index:1}], ...(quality ? {quality} : {}) });

module.exports = { fixture, dirs };
