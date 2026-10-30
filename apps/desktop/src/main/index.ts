/**
 * 主进程入口（破坏性重构 M2）。
 *
 * 边界（见 docs/refactor-plan.md）：只做「窗口 / IPC 契约 / 宿主能力」三件事；
 * 业务逻辑一律走 @hongguo/sdk；通道注册在 ./ipc.ts，那里不 import electron，因此可在 node 下测试。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventPayloads } from '@hongguo/contract';
import { resolveProxyConfig, snapshotProxyEnv } from '@hongguo/host';
import type { SdkAccountService } from '@hongguo/sdk';
import {
  applyEpisodeUpdate,
  applyPortableDataDir,
  availableRelease,
  collectEpisodeTargets,
  collectSeriesTargets,
  collectStorageTargets,
  createAnnouncementService,
  createEpisodeCache,
  createSdk,
  createSessionRegistry,
  createUpdateInstaller,
  defaultOutputPath,
  deleteStorageTargets,
  downloadEpisode,
  episodeDeletionProblem,
  filterHistory,
  mergeNotificationMarks,
  mergeSequelUpdates,
  mergeSeries,
  openBufferSession,
  openMediaSession,
  partitionTargets,
  planUpdateNotifications,
  prefetchNextEpisode,
  pruneEmptyDirs,
  recordPlayback,
  refreshWatchHistory,
  resolveMediaTools,
  resolvePortableDataDir,
  seriesDeletionProblem,
  setNetTransport,
  sourceOf,
  transcodeForCompat,
  updatesEnabled,
  verifyDownloadedFile,
} from '@hongguo/sdk';
import { episodeFilePath, renderName } from '@hongguo/shared';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, net, safeStorage, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createElectronHost } from './electron-host.ts';
import { attachFloatingPlayerWindow, type FloatingPlayerHandle } from './floating-window.ts';
import { registerIpcHandlers } from './ipc.ts';
import { createMediaAccess } from './media-access.ts';
import { decideNavigation, decidePermission, isTrustedPermissionRequest } from './navigation-policy.ts';
import { registerProtocols, registerSchemes, STREAM_SCHEME } from './protocols.ts';
import { createProxyController } from './proxy-controller.ts';
import {
  createProxySessionApplier,
  decideProxyCredentials,
  type ProxySessionLike,
} from './proxy-sessions.ts';
import { createDownloadQueue } from './queue.ts';
import { createShutdown } from './shutdown.ts';
import { planDisabledSources } from './source-access.ts';

const host = createElectronHost();
const logger = host.logger();
const sdk = createSdk({
  logger,
  account: {
    filePath: path.join(host.userDataDir(), 'account-session.bin'),
    safeStorage,
  },
});
// 启动时快照系统代理：之后 system 模式必须读这份快照，否则会把上次的改写当成系统代理。
const proxySnapshot = snapshotProxyEnv(process.env as Record<string, string | undefined>);
const tools = resolveMediaTools(host);
// out/main/workers/decrypt-worker.js 与主入口同目录产出。
// 与 scripts/build-worker.mjs 的产物位置一致；放在 out/main 之外，避免被 electron-vite 清掉。
const decryptWorkerPath = path.join(__dirname, '..', 'workers', 'decrypt-worker.js');
const sessions = createSessionRegistry();
const mediaAccess = createMediaAccess(process.env.ELECTRON_RENDERER_URL);
let mainWindow: BrowserWindow | null = null;
let quitInProgress = false;

const queue = createDownloadQueue({
  concurrency: () => Number(sdk.storage.getSettings().max_concurrent) || 3,
  persist: (tasks) => sdk.storage.saveTasks(tasks as never),
  events: {
    progress: (task) =>
      sendToRenderer('download-progress', {
        id: task.id,
        progress: task.progress,
        receivedBytes: task.receivedBytes,
        totalBytes: task.totalBytes,
      }),
    completed: (task) =>
      sendToRenderer('download-state', {
        id: task.id,
        status: 'completed',
        actualQuality: task.actualQuality ?? null,
        qualityNotice: task.qualityNotice ?? '',
      }),
    failed: (task) =>
      sendToRenderer('download-state', { id: task.id, status: task.status, error: task.error ?? '' }),
    stopped: (task) => sendToRenderer('download-state', { id: task.id, status: 'stopped' }),
    persistFailed: (message: string) =>
      sendToRenderer('download-state', { id: '', status: 'persist-failed', error: message }),
  },
  run: async (task, context) => {
    // 已存在的成品先复核：可用就直接复用（省流量），坏文件留着重新下载覆盖。
    if (fs.existsSync(task.savePath)) {
      try {
        const existing = await verifyDownloadedFile({
          path: task.savePath,
          quality: task.quality,
          tools,
          signal: context.signal,
        });
        return { actualQuality: existing.actualQuality, qualityNotice: '已存在可用文件，跳过下载' };
      } catch {
        /* 校验不通过就走正常下载，坏文件不会先被删（原子发布时替换） */
      }
    }
    const playInfo = (await sdk.playback.sources(task.vid, task.seriesId, {
      quality: task.quality,
      allowLowerQuality: task.allowLowerQuality,
    })) as { url?: string; error?: string } | null;
    if (!playInfo?.url) throw new Error(playInfo?.error ?? '来源未开放该集');
    const result = await downloadEpisode({
      // vid/seriesId 必须显式传：hema/xifan 的取源结果里没有 vid，
      // 只从 playInfo 推断会让来源启用校验与重试拿到空 vid。
      vid: task.vid,
      seriesId: task.seriesId,
      playInfo: playInfo as never,
      outputPath: task.savePath,
      quality: task.quality,
      allowLowerQuality: task.allowLowerQuality,
      tools,
      host,
      decryptWorkerPath,
      signal: context.signal,
      onProgress: (progress) => context.onProgress(progress.receivedBytes, progress.totalBytes),
    });
    return { actualQuality: result.actualQuality, qualityNotice: result.qualityNotice };
  },
});

const downloadPort = {
  enqueue(input: { seriesId: string; seriesTitle: string; vids: string[]; quality: string; root?: string }) {
    const settings = sdk.storage.getSettings();
    const root = input.root || String(settings.root || '') || host.downloadsDir();
    // 跨来源混入必须拒绝：hema:/xifan:/custom: 前缀的分集不能挂到别的剧下。
    const sourcePrefix = /^(hema|xifan|custom):/.exec(input.seriesId)?.[0] ?? '';
    for (const vid of input.vids) {
      const vidPrefix = /^(hema|xifan|custom):/.exec(vid)?.[0] ?? '';
      if (vidPrefix !== sourcePrefix && (vidPrefix || String(input.seriesId).startsWith('custom:'))) {
        throw new Error('分集与剧集来源不匹配');
      }
    }
    const nameFormat = String(settings.name_format || '剧名 集数');
    // 剧名来自上游，必须净化后再拼路径；episodeFilePath 会再复核一次越界。
    const tasks = input.vids.map((vid, index) => {
      const fileName = renderName(nameFormat, input.seriesTitle, index + 1) ?? `第${index + 1}集`;
      return {
        id: `${input.seriesId}-${vid}`,
        vid,
        seriesId: input.seriesId,
        seriesTitle: input.seriesTitle,
        savePath: episodeFilePath(root, input.seriesId, input.seriesTitle, index + 1, fileName),
        quality: input.quality,
        allowLowerQuality: input.quality !== 'auto',
      };
    });
    return queue.enqueue(tasks);
  },
  list: () => queue.list(),
  pause: (id: string) => queue.pause(id),
  resume: (id: string) => queue.resume(id),
  remove: (id: string, options?: { deleteFiles?: boolean }) =>
    queue.remove(id, {
      deleteFiles: options?.deleteFiles === true,
      deleteFile: (task) => {
        const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
        const episode = collectEpisodeTargets({ root, savePath: task.savePath });
        const result = deleteStorageTargets(episode.targets, { root });
        pruneEmptyDirs(
          root,
          new Set(episode.targets.map((target: { path: string }) => path.dirname(target.path))),
        );
        return result;
      },
    }),
};

const mergeRuns = new Map<string, { cancelled: boolean }>();

const mergePort = {
  async start(input: { seriesId: string; compatible: boolean; require1080?: boolean }) {
    const files = queue
      .list()
      .filter((task) => task.seriesId === input.seriesId && task.status === 'completed')
      .sort((a, b) => a.savePath.localeCompare(b.savePath));
    if (!files.length) throw new Error('这部剧还没有已完成的下载，无法合并');
    const outDir = path.dirname(files[0].savePath);
    const outputPath = defaultOutputPath(outDir, files[0].seriesTitle || input.seriesId);
    const run = { cancelled: false };
    mergeRuns.set(input.seriesId, run);
    const task: Record<string, unknown> = {
      id: `merge-${input.seriesId}`,
      seriesId: input.seriesId,
      status: 'running',
      startTime: Date.now(),
      get cancelled() {
        return run.cancelled;
      },
    };
    try {
      const result = await mergeSeries({
        task: task as never,
        episodes: files.map((file, index) => ({ path: file.savePath, vid_index: index + 1 })),
        outDir,
        outputPath,
        tools,
        compatible: input.compatible,
        require1080: input.require1080 === true,
        onProgress: () =>
          sendToRenderer('merge-progress', {
            seriesId: input.seriesId,
            stage: String(task.stage ?? 'running'),
            stageText: typeof task.stageText === 'string' ? task.stageText : undefined,
            progress: Number(task.progress) || 0,
          }),
      });
      sendToRenderer('merge-state', {
        seriesId: input.seriesId,
        status: 'completed',
        outputPath: result.path,
      });
      return { seriesId: input.seriesId, outputPath: result.path, count: result.count };
    } catch (error) {
      const cancelled = run.cancelled;
      sendToRenderer('merge-state', {
        seriesId: input.seriesId,
        status: cancelled ? 'stopped' : 'failed',
        error: (error as Error).message,
      });
      throw error;
    } finally {
      mergeRuns.delete(input.seriesId);
    }
  },
  cancel(seriesId: string) {
    const run = mergeRuns.get(seriesId);
    if (run) run.cancelled = true;
    return { cancelled: Boolean(run) };
  },
};

/** 在飞转码：退出时要能中断（否则进程带着 ffmpeg 子进程一起死，留下 .part）。 */
const transcodeJobs = new Set<AbortController>();

const transcodePort = {
  async run(input: { taskId: string }) {
    const task = queue.get(input.taskId);
    if (!task || task.status !== 'completed') throw new Error('找不到已完成的下载任务');
    const output = `${task.savePath}.compat.mp4`;
    const controller = new AbortController();
    transcodeJobs.add(controller);
    try {
      const result = await transcodeForCompat({
        input: task.savePath,
        output,
        tools,
        signal: controller.signal,
        onProgress: (percent) => sendToRenderer('transcode-progress', { taskId: task.id, percent }),
      });
      return { url: mediaAccess.localUrl(result.output), cached: result.cached };
    } finally {
      transcodeJobs.delete(controller);
    }
  },
};

/**
 * 退出收尾控制器：先取消合并与转码、再停下载，等落定（最多 10 秒）后放行退出。
 * 有界等待是硬要求——宁可留临时文件，也不能让用户点了退出却关不掉窗口。
 */
const shutdown = createShutdown({
  cancelMerges: () => {
    for (const run of mergeRuns.values()) run.cancelled = true;
  },
  stopDownloads: () => queue.stopAll(),
  abortTranscodes: () => {
    for (const controller of transcodeJobs) controller.abort();
  },
  isIdle: () =>
    mergeRuns.size === 0 &&
    transcodeJobs.size === 0 &&
    !queue.list().some((task) => task.status === 'downloading'),
  quit: () => {
    quitInProgress = true;
    app.quit();
  },
});

const seriesList = () => sdk.storage.getSeries() as Array<Record<string, unknown> & { series_id: string }>;

/** 归一化分集档案（沿用 4.5 upsertSeriesRegistry 的字段约定）。 */
function toSeriesEntry(data: Record<string, unknown>): Record<string, unknown> {
  const episodes = Array.isArray(data.episodes) ? (data.episodes as Array<Record<string, unknown>>) : [];
  return {
    series_id: String(data.series_id ?? ''),
    series_title: String(data.series_title ?? '未命名短剧'),
    cover: String(data.cover ?? ''),
    total: episodes.length,
    web_accessible_episodes: data.web_accessible_episodes ?? null,
    episodes: episodes.map((episode) => ({
      vid: String(episode.vid ?? ''),
      vid_index: Number(episode.vid_index) || 0,
      title: String(episode.title ?? ''),
      cover: String(episode.cover ?? ''),
      locked: episode.locked === true,
    })),
    updatedAt: Date.now(),
    dismissed: false,
    forgotten: false,
  };
}

function upsertSeries(entry: Record<string, unknown>): Record<string, unknown> {
  const list = seriesList();
  const index = list.findIndex((item) => String(item.series_id) === String(entry.series_id));
  if (index === -1) list.unshift(entry as never);
  else list[index] = { ...list[index], ...entry, dismissed: false } as never;
  sdk.storage.saveSeries(list as never);
  return entry;
}

const libraryPort = {
  list: () => seriesList().filter((item) => item.dismissed !== true),
  /** 清掉「文件已被删掉」的剧集档案，避免剧库留下点开就空的条目。 */
  purgeEmpty() {
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    const list = seriesList();
    const kept = [];
    const removed: string[] = [];
    for (const entry of list) {
      const records = queue
        .list()
        .filter((task) => task.seriesId === String(entry.series_id))
        .map((task) => ({ path: task.savePath, seriesId: task.seriesId, seriesTitle: task.seriesTitle }));
      const series = collectSeriesTargets({ root, seriesId: String(entry.series_id), records });
      if (series.totalFiles === 0) removed.push(String(entry.series_id));
      else kept.push(entry);
    }
    if (removed.length) sdk.storage.saveSeries(kept as never);
    return { removed: removed.length, seriesIds: removed };
  },
  async add(seriesId: string) {
    const data = (await sdk.series.episodes(seriesId)) as Record<string, unknown>;
    return upsertSeries(toSeriesEntry(data));
  },
  remove(seriesId: string) {
    const list = seriesList();
    const index = list.findIndex((item) => String(item.series_id) === String(seriesId));
    if (index === -1) return { removed: false };
    list[index] = { ...list[index], dismissed: true } as never;
    sdk.storage.saveSeries(list as never);
    return { removed: true };
  },
};

// 更新下载经代理时可能需要认证：只对更新主机给出凭据，别的一律拒绝。
const updateHosts = ['github.com', 'api.github.com', 'objects.githubusercontent.com'];
function attachUpdateCredentials(): void {
  const updateSession = (autoUpdater as { netSession?: { webRequest?: unknown; on?: unknown } }).netSession;
  const webRequest = updateSession?.webRequest as
    | { on(event: 'login', listener: (...args: unknown[]) => void): void }
    | undefined;
  if (!webRequest?.on) return;
  webRequest.on('login', (...args: unknown[]) => {
    const [, details, authInfo, callback] = args as [
      unknown,
      { host?: string },
      unknown,
      (credentials?: { username: string; password: string }) => void,
    ];
    const settings = sdk.storage.getSettings() as { proxy_username?: string; proxy_password?: string };
    const decided = decideProxyCredentials(
      details as { host: string },
      settings.proxy_username
        ? { username: String(settings.proxy_username), password: String(settings.proxy_password ?? '') }
        : undefined,
      updateHosts,
    );
    if (decided) callback(decided);
    else callback();
  });
}

const proxyController = createProxyController({
  readSettings: () => sdk.storage.getSettings() as never,
  snapshot: proxySnapshot,
  env: process.env as Record<string, string | undefined>,
  logger: { warn: (message) => logger.warn(message) },
  timeoutMs: 3000,
  applyToSession: async (config) => {
    await createProxySessionApplier({
      windowSession: session.defaultSession as never,
      // 更新器有自己的网络会话：只给窗口设代理会让更新请求绕过代理直连。
      updateSession: () =>
        (autoUpdater as { netSession?: unknown }).netSession as never as ProxySessionLike | undefined,
      logger,
    })(config);
  },
});

function applyProxyFromSettings() {
  return proxyController.apply();
}

const proxyPort = {
  apply: () => applyProxyFromSettings(),
  async test(draft: Record<string, unknown>) {
    // 用草稿解析，不写环境变量：测试不应该改变正在生效的代理。
    const resolved = resolveProxyConfig(
      { ...(sdk.storage.getSettings() as object), ...draft } as never,
      proxySnapshot,
    );
    if (draft.proxy_enabled === true && (draft.proxy_mode ?? 'system') === 'custom' && !resolved.url) {
      throw new Error('请填写完整的代理地址与端口');
    }
    const started = Date.now();
    const response = await net.fetch('https://www.baidu.com', {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return { success: response.ok, status: response.status, ms: Date.now() - started, mode: resolved.mode };
  },
};

const storagePort = {
  usage() {
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    // 记录只用于补剧集归属，目标集以磁盘扫描为准（保证「统计到的 = 删得到的」）。
    const records = [
      ...queue.list().map((task) => ({
        path: task.savePath,
        seriesId: task.seriesId,
        seriesTitle: task.seriesTitle,
      })),
      ...seriesList().map((entry) => ({
        path: '',
        seriesId: String(entry.series_id ?? ''),
        seriesTitle: String(entry.series_title ?? ''),
      })),
    ];
    return collectStorageTargets({ root, records });
  },
  deleteSeries(seriesId: string) {
    // 删除前先看有没有在跑的任务：4.5 会拒绝，删掉正在写的那份文件只会让下载失败得更难看。
    const blocked = seriesDeletionProblem(queue.list(), seriesId);
    if (blocked) throw new Error(blocked);
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    const records = queue
      .list()
      .filter((task) => task.seriesId === seriesId)
      .map((task) => ({ path: task.savePath, seriesId: task.seriesId, seriesTitle: task.seriesTitle }));
    const series = collectSeriesTargets({ root, seriesId, records });
    const result = deleteStorageTargets(series.targets, { root });
    // 清空目录，避免留下空壳；只清刚删过的目录。
    const dirs = new Set(series.targets.map((target: { path: string }) => path.dirname(target.path)));
    const removedDirs = pruneEmptyDirs(root, dirs);
    return { ...result, totalFiles: series.totalFiles, totalBytes: series.totalBytes, removedDirs };
  },
  deleteEpisode(input: { taskId: string }) {
    const task = queue.get(input.taskId);
    if (!task) throw new Error('找不到该下载任务');
    const blocked = episodeDeletionProblem(task);
    if (blocked) throw new Error(blocked);
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    const episode = collectEpisodeTargets({ root, savePath: task.savePath });
    const result = deleteStorageTargets(episode.targets, { root });
    pruneEmptyDirs(
      root,
      new Set(episode.targets.map((target: { path: string }) => path.dirname(target.path))),
    );
    return { ...result, totalFiles: episode.totalFiles, totalBytes: episode.totalBytes };
  },
  deleteAll() {
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    // 正在合并的剧集要保护：删掉源文件会让合并中途失败并留下坏产物。
    const merging = new Set(mergeRuns.keys());
    const guarded = new Set<string>();
    for (const task of queue.list()) {
      if (!merging.has(task.seriesId)) continue;
      guarded.add(path.resolve(task.savePath));
      guarded.add(path.resolve(`${task.savePath}.compat.mp4`));
    }
    // 顺序：先停写（否则删掉的正是下载正在写的那份），再删文件，最后清记录。
    queue.stopAll();
    const usage = collectStorageTargets({ root });
    const { remove, kept } = partitionTargets(usage.targets, guarded);
    const result = deleteStorageTargets(remove, { root });
    // 记录同步清掉，避免界面显示「已完成」但文件已不存在（受保护的剧集保留记录）。
    for (const task of queue.list()) {
      if (!merging.has(task.seriesId)) queue.remove(task.id);
    }
    return {
      ...result,
      totalFiles: usage.totalFiles,
      totalBytes: usage.totalBytes,
      skipped: [...merging],
      skippedFiles: kept.length,
    };
  },
};

const updateInstaller = createUpdateInstaller({
  updater: autoUpdater as never,
  currentVersion: host.app().version,
  isEnabled: () => sdk.storage.getSettings().app_updates_enabled !== false,
  // 退出过程中不允许再启动安装，避免半途打断清理（沿用 4.5 的约定）。
  installBlocker: () => Boolean(quitInProgress),
  // 未打包运行时 electron-updater 没有安装目标：如实标记不支持，别让用户点了才失败。
  // 便携版同理：自动更新会把程序装到系统目录，必须让用户手动替换。
  supported: app.isPackaged && !isPortableBuild(),
  supportedReason: app.isPackaged ? '' : '开发运行时不会自动更新，请使用打包版本。',
  emit: (state: unknown) => sendToRenderer('update-changed', state as never),
} as never);

const updatePort = {
  async check() {
    // 关闭更新检测时一个请求都不发（既省流量，也不向 GitHub 泄漏使用情况）。
    if (!updatesEnabled(sdk.storage.getSettings())) {
      return { release: null, enabled: false, state: updateInstaller.getState() };
    }
    const response = await net.fetch('https://api.github.com/repos/jackotom/hongguo-drama/releases/latest', {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hongguo-drama' },
    });
    if (!response.ok) throw new Error(`更新检查失败（HTTP ${response.status}）`);
    const data = await response.json();
    const release = availableRelease(data, host.app().version);
    return { release: release ?? null, enabled: true, state: updateInstaller.getState() };
  },
  state: () => updateInstaller.getState(),
  // download 需要预期的版本号，避免把「检查到的新版」与「实际下载的版本」搞混。
  download: async () => {
    const current = updateInstaller.getState() as { version?: string | null };
    return updateInstaller.download(current.version ?? undefined);
  },
  install: () => updateInstaller.install(),
  cancel: () => updateInstaller.cancel(),
};

const announcementService = createAnnouncementService({
  store: sdk.storage,
  version: host.app().version,
  request: async (url: string) => {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(8000) });
    return { status: response.status, data: await response.text() };
  },
  isEnabled: () => sdk.storage.getSettings().app_updates_enabled !== false,
  onAnnouncement: (payload: unknown) => sendToRenderer('announcement', payload),
} as never);

const announcementPort = {
  get: () => announcementService.getCurrentAnnouncement(),
  dismiss: (input: { mode: 'day' | 'version' }) => announcementService.dismissAnnouncement(input),
  check: () => announcementService.checkAnnouncements({ urgentOnly: true }),
};

const exportPort = {
  async run(input: {
    seriesId: string;
    seriesTitle: string;
    kinds: { danmaku: boolean; comments: boolean; reviews: boolean };
  }) {
    if (!input.kinds.danmaku && !input.kinds.comments && !input.kinds.reviews) {
      throw new Error('请至少选择一种要导出的文字数据');
    }
    // 有已完成下载的分集时，文字与视频同名同目录；否则只导出剧评到下载根目录。
    const files = queue
      .list()
      .filter((task) => task.seriesId === input.seriesId && task.status === 'completed')
      .sort((a, b) => a.savePath.localeCompare(b.savePath));
    const root = String(sdk.storage.getSettings().root || '') || host.downloadsDir();
    const dir = files.length
      ? path.dirname(files[0]!.savePath)
      : path.join(root, input.seriesTitle || input.seriesId);
    host.fs().ensureDir(dir);
    const result = await sdk.exportText.series({
      seriesId: input.seriesId,
      seriesTitle: input.seriesTitle,
      episodes: files.map((task, index) => ({
        vid: task.vid,
        vid_index: index + 1,
        savePath: task.savePath,
      })),
      kinds: input.kinds,
      reviewsPath: path.join(dir, '剧评.json'),
    });
    return result;
  },
};

const historyPort = {
  list(scope: string) {
    const rows = sdk.history.list(
      seriesList(),
      sdk.storage.getPlayback(),
      sdk.storage.getSettings().watch_sequels_enabled !== false,
    ) as Array<Record<string, unknown>>;
    // 筛选逻辑在 SDK 的纯函数里（filterHistory），宿主只负责取数。
    return filterHistory(rows as never, scope as never);
  },
  remove(seriesId: string) {
    // 移除观看记录：只删记录，不动剧库档案（4.5 的 remove-watch-history 就是这个语义）。
    const playback = sdk.storage.getPlayback() as Record<string, unknown>;
    const key = String(seriesId);
    if (!(key in playback)) return { removed: false };
    delete playback[key];
    sdk.storage.savePlayback(playback as never);
    return { removed: true };
  },
};

const seriesPort = {
  episodes: (seriesId: string) => sdk.series.episodes(seriesId),
  async sequels(seriesId: string) {
    const entry = seriesList().find((item) => String(item.series_id) === String(seriesId));
    if (!entry) throw new Error('未找到该剧档案，请先在剧库中打开');
    const registry = seriesList().filter((item) => item.forgotten !== true);
    return sdk.search.sequels(entry, registry, (keyword: string, call: unknown) =>
      sdk.search.web(keyword, call),
    );
  },
};

const progressPort = {
  get(seriesId: string) {
    const record = (sdk.storage.getPlayback() as Record<string, Record<string, unknown>>)[String(seriesId)];
    if (!record) return null;
    return {
      vid: String(record.vid ?? ''),
      vidIndex: Number(record.vid_index) || 0,
      currentTime: Number(record.currentTime) || 0,
      duration: Number(record.duration) || 0,
      updatedAt: Number(record.updatedAt) || 0,
      watched: record.watched === true,
    };
  },
  save(input: {
    seriesId: string;
    vid: string;
    vidIndex: number;
    currentTime: number;
    duration: number;
    watched: boolean;
    ended?: boolean;
  }) {
    const playback = sdk.storage.getPlayback() as Record<string, Record<string, unknown>>;
    const previous = playback[input.seriesId] ?? {};
    // 只在时间前进或跨集时覆盖，避免拖动回看把进度写回去（与 4.5 的续播语义一致）。
    const sameEpisode = String(previous.vid ?? '') === input.vid;
    const currentTime = sameEpisode
      ? Math.max(Number(previous.currentTime) || 0, input.currentTime)
      : input.currentTime;
    const duration = input.duration || Number(previous.duration) || 0;
    // 完成证据（`completedEpisode`）由 recordPlayback 统一算：只有「播到结尾」才算看完，
    // 暂停、拖到最后、只看了一部分都不能让「已看完的低季不再提示」误伤。
    const series = seriesList().find((item) => String(item.series_id) === String(input.seriesId));
    const recorded = recordPlayback(
      previous,
      series ?? { series_id: input.seriesId, total: 0 },
      input.vidIndex,
      currentTime,
      Date.now(),
      { duration, ended: input.ended === true && input.watched === true },
    ) as Record<string, unknown>;
    const next = {
      ...previous,
      ...recorded,
      vid: input.vid,
      vid_index: input.vidIndex,
      duration,
      watched: input.watched === true || previous.watched === true,
    };
    playback[input.seriesId] = next;
    sdk.storage.savePlayback(playback);
    return this.get(input.seriesId);
  },
};

/**
 * 预取下一集：用与真正播放同一条取流路径，命中同一份会话缓存。
 * 失败一律静默（用户不需要知道预取失败），切换集时再正常取流。
 */
const prefetchPort = {
  run(input: { seriesId: string; currentVid: string; episodes: Array<{ vid: string; locked?: boolean }> }) {
    return prefetchNextEpisode({
      episodes: input.episodes.map((episode, index) => ({ ...episode, vid_index: index + 1 })),
      currentVid: input.currentVid,
      load: (vid: string) => sdk.playback.sources(vid, input.seriesId, { quality: 'auto' }),
      timeoutMs: 15_000,
    });
  },
};

/**
 * 后台续作刷新：只查该剧自己的来源，有限次数；部分失败不推进 24 小时检查点。
 * 记录写回走 storage，刷新本身不阻塞界面。
 */
let floatingHandle: FloatingPlayerHandle | null = null;

const searchPort = {
  query(input: { keyword: string; page?: number; source?: string }) {
    // 单次搜索总预算 20s：所有来源共用，慢来源不会各自重开计时。
    const deadline = Date.now() + 20_000;
    const source = String(input.source ?? 'hongguo');
    if (source === 'hongguo') {
      // 红果走完整链路：App 优先 → 官网兜底 → 5xx 用 App 救场 → 首页补一次今日上新。
      // 其它来源各走自己的适配器（bySource）。
      return sdk.search.series2(input.keyword, {
        page: input.page ?? 1,
        deadline,
      });
    }
    return sdk.search.bySource(input.keyword, { source, page: input.page ?? 1, deadline });
  },
};

const floatingPort = {
  open(input: { vid: string; seriesId: string }) {
    if (floatingHandle) {
      floatingHandle.window.focus?.();
      return { opened: false };
    }
    const settings = sdk.storage.getSettings() as { floating_player_size?: unknown };
    if (!mainWindow || mainWindow.isDestroyed()) return { opened: false };
    floatingHandle = attachFloatingPlayerWindow({
      BrowserWindow,
      parent: mainWindow,
      // 悬浮窗走同一个渲染入口，用 query 切到悬浮布局；它拿不到 preload，只能读公开数据。
      url: buildRendererUrl({ floating: '1', vid: input.vid, seriesId: input.seriesId }),
      size: settings.floating_player_size,
      // 导航守卫：只允许停在应用自身页面上（外部链接一律拦下）
      isTrustedUrl: (url) => decideNavigation(url, navigationContext()) === 'allow',
      persistSize: (size) => {
        // 必须合并已有设置，不能只写这一个键。
        sdk.storage.saveSettings({ ...sdk.storage.getSettings(), floating_player_size: size });
      },
    });
    floatingHandle.window.on('closed', () => {
      floatingHandle = null;
    });
    return { opened: true };
  },
  close() {
    if (!floatingHandle) return { closed: false };
    floatingHandle.close();
    floatingHandle = null;
    return { closed: true };
  },
};

const historyRefreshPort = {
  /**
   * 后台/单行更新检查。
   *
   * 一轮做三件事：续作检查（24 小时检查点）→ 分集总量检查（红点来源）→ 更新通知（去重）。
   * `seriesId` 存在时只查那一部，并且忽略 24 小时检查点（用户主动点的「检查更新」）。
   */
  async refresh(seriesId?: string) {
    const registry = (sdk.storage.getSeries?.() ?? []).filter(
      (item: any) => item.forgotten !== true,
    ) as never[];
    const playback = (sdk.storage.getPlayback?.() ?? {}) as Record<string, never>;
    const result = await refreshWatchHistory({
      series: registry as never,
      playback,
      ...(seriesId ? { seriesId } : {}),
      searchSequels: (series: { series_id: string; series_title: string }, keyword: string) =>
        sdk.search.sequels(series, [], (query: string) =>
          sdk.search.bySource(query, {
            source: sourceOf(series.series_id) ?? undefined,
            deadline: Date.now() + 10_000,
          }),
        ) as never,
    });
    if (Object.keys(result.updates).length) {
      // 写回时重新取一遍并只合并续作字段：刷新期间的进度保存与删除都不能被覆盖/复活。
      const latest = (sdk.storage.getPlayback?.() ?? {}) as Record<string, Record<string, unknown>>;
      sdk.storage.savePlayback(
        mergeSequelUpdates(latest, result.updates as Record<string, Record<string, unknown>>) as never,
      );
    }

    // 分集总量检查：这才是「未看集数」的来源（续作检查只关心新季）。
    const watchedIds = Object.keys(sdk.storage.getPlayback() as object)
      .filter((id) => !seriesId || id === seriesId)
      .slice(0, 20);
    for (const id of watchedIds) {
      const entry = seriesList().find((item) => String(item.series_id) === id);
      const current = (sdk.storage.getPlayback() as Record<string, Record<string, unknown>>)[id];
      if (!entry || !current) continue;
      const all = sdk.storage.getPlayback() as Record<string, Record<string, unknown>>;
      try {
        const fresh = (await sdk.series.episodes(id)) as Record<string, unknown>;
        if (!all[id]) continue; // 期间被移除：不复活
        all[id] = applyEpisodeUpdate(all[id] as never, entry as never, fresh as never, Date.now()) as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (!all[id]) continue;
        const reason = `分集检查未完成：${(error as Error).message}`;
        all[id] = { ...all[id], lastEpisodeCheckError: reason, lastCheckError: reason };
      }
      sdk.storage.savePlayback(all as never);
    }

    notifyUpdates();
    return { checked: result.checked, failed: result.failed };
  },
};

/** 更新通知：同一条只提醒一次；开关关掉就一条都不发。 */
function notifyUpdates(): void {
  const settings = sdk.storage.getSettings() as { watch_notifications_enabled?: boolean };
  if (settings.watch_notifications_enabled === false) return;
  const rows = historyPort.list('all') as Array<Record<string, unknown>>;
  const playback = sdk.storage.getPlayback() as Record<string, never>;
  const plan = planUpdateNotifications(rows as never, playback as never);
  if (!plan.notifications.length) return;
  for (const item of plan.notifications) {
    try {
      if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) continue;
      new Notification({ title: item.title, body: item.body }).show();
    } catch {
      // 通知失败不影响检查结果
    }
  }
  const latest = sdk.storage.getPlayback() as Record<string, Record<string, unknown>>;
  sdk.storage.savePlayback(mergeNotificationMarks(latest, plan.updates as never) as never);
}

const rankingsPort = {
  list: (kind: string, page: number) => sdk.catalog.app({ category: kind, page }),
};

/** 目录浏览：按来源分流；自定义代理下不允许走可信 DNS 直连（渲染层无法指定）。 */
const catalogPort = {
  list(input: {
    source: string;
    category?: string;
    genre?: string;
    page?: number;
    cursor?: string | null;
    catalogChannel?: 'app' | 'web';
  }) {
    const proxyMode = (proxyController.current()?.mode ?? 'system') as string;
    return sdk.catalog.browse({
      ...input,
      channel: input.catalogChannel,
      allowTrustedDns: proxyMode !== 'custom',
    });
  },
};

let accountServiceRef: SdkAccountService | null = null;
let accountWebSessionRef: import('electron').Session | null = null;

function getAccountWebSession() {
  accountWebSessionRef ||= session.fromPartition('hongguo-account-login', { cache: false });
  return accountWebSessionRef;
}

async function clearAccountCookies(): Promise<void> {
  if (accountWebSessionRef) await accountWebSessionRef.clearStorageData({ storages: ['cookies'] });
  const cookies = await session.defaultSession.cookies.get({});
  for (const cookie of cookies) {
    if (!/(?:^|.)hongguoduanju.com$/i.test(String(cookie.domain || ''))) continue;
    const hostName = String(cookie.domain || '').replace(/^./, '');
    if (!hostName) continue;
    try {
      await session.defaultSession.cookies.remove('https://' + hostName + (cookie.path || '/'), cookie.name);
    } catch {
      /* 已失效的 cookie 忽略 */
    }
  }
}

function accountService() {
  if (!accountServiceRef) {
    accountServiceRef = sdk.account.create({
      webRequest: async (url: string, options: { method?: string; headers?: Record<string, string> }) => {
        const response = await getAccountWebSession().fetch(url, {
          method: options.method || 'GET',
          headers: options.headers || {},
          redirect: 'manual',
          signal: AbortSignal.timeout(12_000),
        });
        const headers: Record<string, string> = {};
        for (const [name, value] of response.headers) headers[name] = value;
        const cookies = response.headers.getSetCookie?.();
        // CookieJar 只接受字符串头；多个 set-cookie 用逗号拼接（值里不含逗号分隔语义）。
        if (cookies?.length) headers['set-cookie'] = cookies.join(', ');
        return { status: response.status, headers, data: await response.text() };
      },
      onAccountExpired: () => {
        void clearAccountCookies();
        sendToRenderer('account-updated', { signedIn: false });
      },
    });
  }
  return accountServiceRef;
}

const accountPort = {
  status: async () => accountService().status(),
  async startLogin() {
    await clearAccountCookies();
    return accountService().startLogin();
  },
  async pollLogin(loginId: string) {
    const result = (await accountService().pollLogin(loginId)) as { status?: string };
    if (result.status === 'signed-in') sendToRenderer('account-updated', { signedIn: true });
    else if (result.status === 'expired') await clearAccountCookies();
    return result;
  },
  async cancelLogin(loginId: string) {
    const result = accountService().cancelLogin(loginId);
    await clearAccountCookies();
    return result;
  },
  async logout() {
    const result = await accountService().logout();
    await clearAccountCookies();
    sendToRenderer('account-updated', { signedIn: false });
    return result;
  },
  history: (refresh: boolean) => accountService().history({ refresh }),
};

const playbackCache = createEpisodeCache({
  cacheDir: path.join(host.userDataDir(), 'cache', 'playback'),
});

const playbackPort = {
  async prepare(input: { vid: string; seriesId?: string; quality: string; force?: boolean }) {
    const playInfo = (await sdk.playback.sources(input.vid, input.seriesId, {
      quality: input.quality,
      // 手动重试必须强制换一次源：否则会把上次失败的缓存结果原样再拿一遍。
      ...(input.force ? { force: true } : {}),
    })) as { url?: string; error?: string; contentKey?: string; spadeA?: string; source?: string } | null;
    if (!playInfo?.url) throw new Error(playInfo?.error ?? '来源未开放该集');

    // 缓存键与片源指纹：同一集换了片源就不复用旧内容。
    const cacheKey = playbackCache.key(input.vid, input.quality);
    const mediaIdentity = JSON.stringify([
      playInfo.url,
      playInfo.contentKey ?? null,
      playInfo.spadeA ?? null,
    ]);
    const cached = input.force
      ? null
      : playbackCache.lookup({
          key: cacheKey,
          vid: input.vid,
          seriesId: input.seriesId,
          source: playInfo.source,
          mediaIdentity,
        });

    if (!cached) {
      const session = await openMediaSession(
        { playInfo: playInfo as never, vid: input.vid, seriesId: input.seriesId, host },
        sessions,
      );
      // 已解密的片源写入缓存，下次同集重开不必再取流与解密。
      const snapshot = await session.snapshot?.();
      if (snapshot?.length) {
        playbackCache
          .store({
            key: cacheKey,
            vid: input.vid,
            seriesId: input.seriesId ?? '',
            source: playInfo.source ?? '',
            quality: input.quality,
            mediaIdentity,
            bytes: snapshot.length,
            complete: true,
            buffer: snapshot,
          })
          .release();
      }
      return { url: `${STREAM_SCHEME}://play/${session.id}`, sessionId: session.id };
    }

    // 命中缓存：直接从内存按 Range 供给，不再取流、也不再解密。
    const buffer = await cached.read();
    cached.release();
    const session = openBufferSession({ buffer, vid: input.vid, seriesId: input.seriesId }, sessions);
    return { url: `${STREAM_SCHEME}://play/${session.id}`, sessionId: session.id };
  },
  cancel(sessionId: string) {
    // 释放会话：中止在飞上游连接、删掉解密临时文件（离开这一集/重试前都要调）。
    const known = sessions.get(sessionId);
    sessions.release(sessionId);
    return { released: Boolean(known) };
  },
};

/** 只接受本窗口主 frame 的请求；其余一律拒绝（沿用 4.5 的安全约定）。 */
/** 允许在应用窗口内加载的来源（开发服务器 origin；打包后是 file:）。 */
/**
 * 应用菜单（macOS 需要它才有 Cmd+C/V/A 这些编辑快捷键）。
 *
 * 菜单项只给标准角色，不放自定义动作：界面里的功能都有可见入口，
 * 菜单再放一份只会出现两套状态需要同步。
 */
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Array<Record<string, unknown>> = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ];
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template as never));
  } catch (error) {
    logger.warn(`应用菜单创建失败: ${(error as Error).message}`);
  }
}

/** 便携包（Windows 便携 EXE / 便携 ZIP）：不支持自动更新，只能手动替换程序。 */
function isPortableBuild(): boolean {
  try {
    return Boolean(resolvePortableDataDir({ env: process.env, platform: process.platform }).portableDir);
  } catch {
    return false;
  }
}

function appOrigins(): string[] {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  return devServer ? [new URL(devServer).origin] : [];
}

/** 导航上下文：开发服务器 origin + 打包后的渲染入口文件（只认这一个 file:）。 */
function navigationContext(): { appOrigins: string[]; appFiles: string[] } {
  return {
    appOrigins: appOrigins(),
    appFiles: [path.join(__dirname, '../renderer/index.html').replace(/\\/g, '/')],
  };
}

/** 渲染层入口地址（含 query）。悬浮窗复用它，保证与主窗口同一套资源与协议。 */
function buildRendererUrl(query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    const base = devServer.endsWith('/') ? devServer : `${devServer}/`;
    return `${base}?${search}`;
  }
  const file = path.join(__dirname, '../renderer/index.html');
  return `${pathToFileURL(file).href}?${search}`;
}

/** 外部链接交给系统浏览器（宿主把 openExternal 放在顶层，不是 windows 下）。 */
function openExternal(url: string): void {
  void host.openExternal?.(url)?.catch?.(() => {});
}

function isTrustedSender(event: unknown): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const candidate = event as { sender?: unknown; senderFrame?: unknown };
  return (
    candidate.sender === mainWindow.webContents && candidate.senderFrame === mainWindow.webContents.mainFrame
  );
}

function sendToRenderer<E extends keyof EventPayloads>(event: E, payload: EventPayloads[E]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(String(event), payload);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '红果短剧',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: '#faf9f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 新窗口一律不在应用内打开；https 只交给系统浏览器。
    if (decideNavigation(url, navigationContext()) === 'external') void openExternal(url);
    return { action: 'deny' };
  });
  // 页面内跳转：应用自身允许，外部交给系统浏览器，其它协议拒绝。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, navigationContext());
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void openExternal(url);
  });
  // 服务器重定向也要守：主窗口只注册 will-navigate 的话，302 到外部站点会被放行。
  mainWindow.webContents.on('will-redirect', (event, url) => {
    const decision = decideNavigation(url, navigationContext());
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void openExternal(url);
  });
  // 播放与下载不需要敏感权限：一律拒绝；但全屏与剪贴板是播放器/分享链接要用的，
  // 只给应用自己的主 frame，其余（子 frame、外部页面、窗口已销毁）全部拒绝。
  const permissionTrusted = (contents: unknown, details: unknown, origin?: string): boolean => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (contents !== mainWindow.webContents) return false;
    const info = details as { isMainFrame?: boolean; requestingUrl?: string } | null | undefined;
    return isTrustedPermissionRequest(
      { isMainFrame: info?.isMainFrame, requestingUrl: info?.requestingUrl ?? origin ?? '' },
      navigationContext(),
    );
  };
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(decidePermission(permission, { trusted: permissionTrusted(contents, details) }));
  });
  // 有些 API 走的是「同步检查」而不是「请求」：两条路径用同一套策略，不然会出现
  // 「请求被允许但检查被拒」这种看起来像 bug 的不一致。
  mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) =>
    decidePermission(permission, { trusted: permissionTrusted(contents, details, String(origin ?? '')) }),
  );

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void mainWindow.loadURL(devServer);
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

registerSchemes();

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // 便携版：必须在任何 getPath('userData') 之前切换目录，否则首个读到的还是系统目录。
  // 但用户显式给了 --user-data-dir 时要尊重它（4.5 的规则：便携迁移只改「默认」目录）。
  const explicitUserData = Boolean(app.commandLine.hasSwitch?.('user-data-dir'));
  if (!explicitUserData) {
    const portable = applyPortableDataDir({
      app,
      defaultUserData: app.getPath('userData'),
    });
    if (portable.reason) logger.warn(portable.reason);
  }

  void app.whenReady().then(() => {
    // 会话只能在 app ready 之后访问。
    attachUpdateCredentials();
    try {
      sdk.storage.init(path.join(host.userDataDir(), 'data.json'));
    } catch (error) {
      logger.warn(`本地数据初始化失败: ${(error as Error).message}`);
    }
    // 读盘失败（文件损坏/无权限）时不能静默带病运行：后面每一次保存都会失败。
    // 4.5 直接弹框退出；这里保留应用可用性，只提示一次并说明「保存会失败」。
    const readFailure = sdk.storage.readError?.();
    if (readFailure) {
      logger.warn(`本地数据读取失败: ${readFailure.message}`);
      try {
        dialog.showErrorBox(
          '本地数据读取失败',
          `${readFailure.message}\n\n设置与记录暂时无法保存。请检查 ${host.userDataDir()} 下的 data.json 后重启应用。`,
        );
      } catch {
        /* 无 GUI 环境忽略 */
      }
    }
    // 存储初始化之后再回填上次的下载任务（构造队列时存储还没就绪）。
    queue.restore((sdk.storage.getTasks() as never[]) ?? []);
    sdk.storage.setErrorHandler((payload: { error: string } | null) => {
      if (payload) sendToRenderer('storage-error', payload);
    });
    // 目录抓取复用 Electron 的 net（系统代理与会话）；未注入时 SDK 自动回退 axios。
    setNetTransport(net);
    applyProxyFromSettings();
    registerProtocols({ sessions, mediaAccess });
    registerIpcHandlers({
      // Electron 的 handle 多一个 event 参数，这里收敛成契约里的形状。
      ipcMain: { handle: (channel, listener) => ipcMain.handle(channel, listener) },
      // 设置保存时若停用了自定义源，要立刻把它的在飞任务与已解密内容收掉；
      // 只在 IPC 入口包一层，内部写设置（代理、更新开关等）不需要这段收尾。
      sdk: {
        ...sdk,
        storage: {
          ...sdk.storage,
          saveSettings: (next: Record<string, unknown>) => {
            const before = sdk.storage.getSettings().custom_sources;
            sdk.storage.saveSettings(next as never);
            const plan = planDisabledSources(
              before as never,
              sdk.storage.getSettings().custom_sources as never,
              queue.list(),
            );
            if (!plan.disabledIds.length) return;
            for (const id of plan.stoppedTaskIds) queue.pause(id);
            if (plan.clearSessions) sessions.clear();
            if (plan.clearCache) playbackCache.clear();
            if (plan.cancelRequests) {
              for (const id of plan.disabledIds) sdk.catalog.cancelRequests(id);
            }
            logger.warn(`已停用自定义源并收尾：${plan.disabledIds.join('、')}`);
          },
        },
      },
      search: searchPort,
      floating: floatingPort,
      prefetch: prefetchPort,
      historyRefresh: historyRefreshPort,
      catalog: catalogPort,
      isTrustedSender,
      appInfo: () => host.app(),
      download: downloadPort,
      playback: playbackPort,
      merge: mergePort,
      transcode: transcodePort,
      library: libraryPort,
      series: seriesPort,
      history: historyPort,
      rankings: rankingsPort,
      account: accountPort,
      progress: progressPort,
      exportText: exportPort,
      announcement: announcementPort,
      update: updatePort,
      storage: storagePort,
      proxy: proxyPort,
      logger,
    });
    createWindow();
    installApplicationMenu();

    // 退出收尾：取消合并 → 停下载 → 断转码 → 有界等待 → 真正退出。
    // 注册在窗口建好之后：收尾要通知渲染层状态，没有窗口就没必要拦。
    app.on('before-quit', (event) => {
      const idle =
        mergeRuns.size === 0 &&
        transcodeJobs.size === 0 &&
        !queue.list().some((task) => task.status === 'downloading');
      if (idle) {
        quitInProgress = true;
        return;
      }
      shutdown.handleBeforeQuit(event);
    });

    // 后台更新检查：启动 30 秒后查一次，之后每 6 小时一次。
    // 开关是 watch_updates_enabled（4.5 死掉的设置之一），关掉就完全不查。
    const updateCheckTimer = setInterval(
      () => {
        if (sdk.storage.getSettings().watch_updates_enabled === false) return;
        void historyRefreshPort.refresh().catch(() => {});
      },
      6 * 60 * 60 * 1000,
    );
    updateCheckTimer.unref?.();
    const updateCheckKickoff = setTimeout(() => {
      if (sdk.storage.getSettings().watch_updates_enabled === false) return;
      void historyRefreshPort.refresh().catch(() => {});
    }, 30_000);
    updateCheckKickoff.unref?.();

    // 紧急公告要能主动弹出来：启动后查一次，之后定期查。
    // 只在窗口建好后开始，保证事件有接收方；定时器不阻止退出。
    const announcementTimer = setInterval(
      () => {
        void announcementPort.check().catch(() => {});
      },
      15 * 60 * 1000,
    );
    announcementTimer.unref?.();
    void announcementPort.check().catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
