/**
 * 通道与事件常量 + 信封类型：**不依赖 zod**。
 * preload 只 import 这里，避免把校验库打进沙箱预加载脚本。
 */
export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function ipcFail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

export const Channels = {
  appInfo: 'app:info',
  capabilities: 'sdk:capabilities',
  suggest: 'search:suggest',
  searchWeb: 'search:web',
  browseSources: 'catalog:sources',
  browseList: 'catalog:list',
  customSourceSave: 'custom-source:save',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  downloadEnqueue: 'download:enqueue',
  downloadList: 'download:list',
  downloadPause: 'download:pause',
  downloadResume: 'download:resume',
  downloadRemove: 'download:remove',
  playPrepare: 'play:prepare',
  playCancel: 'play:cancel',
  mergeStart: 'merge:start',
  mergeCancel: 'merge:cancel',
  mediaTranscode: 'media:transcode',
  libraryList: 'library:list',
  libraryAdd: 'library:add',
  libraryRemove: 'library:remove',
  seriesEpisodes: 'series:episodes',
  seriesSequels: 'series:sequels',
  historyList: 'history:list',
  historyRemove: 'history:remove',
  historyRefresh: 'history:refresh',
  rankings: 'catalog:rankings',
  accountStatus: 'account:status',
  accountStartLogin: 'account:start-login',
  accountPollLogin: 'account:poll-login',
  accountCancelLogin: 'account:cancel-login',
  accountLogout: 'account:logout',
  accountHistory: 'account:history',
  progressGet: 'progress:get',
  progressSave: 'progress:save',
  exportText: 'export:text',
  announcementGet: 'announcement:get',
  announcementDismiss: 'announcement:dismiss',
  announcementCheck: 'announcement:check',
  updateCheck: 'update:check',
  updateState: 'update:state-get',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateCancel: 'update:cancel',
  storageUsage: 'storage:usage',
  storageDeleteAll: 'storage:delete-all',
  storageDeleteSeries: 'storage:delete-series',
  storageDeleteEpisode: 'storage:delete-episode',
  libraryPurgeEmpty: 'library:purge-empty',
  proxyApply: 'proxy:apply',
  proxyTest: 'proxy:test',
  playerFloatOpen: 'player:float-open',
  playerFloatClose: 'player:float-close',
  danmakuList: 'danmaku:list',
  playPrefetch: 'play:prefetch',
} as const;

export type Channel = (typeof Channels)[keyof typeof Channels];

export const Events = {
  storageError: 'storage-error',
  accountUpdated: 'account-updated',
  downloadProgress: 'download-progress',
  downloadState: 'download-state',
  mergeProgress: 'merge-progress',
  mergeState: 'merge-state',
  transcodeProgress: 'transcode-progress',
  announcement: 'announcement',
  updateChanged: 'update-changed',
} as const;

export interface EventPayloads {
  [Events.storageError]: { error: string };
  [Events.accountUpdated]: { signedIn: boolean };
  [Events.downloadProgress]: { id: string; progress: number; receivedBytes: number; totalBytes: number };
  [Events.downloadState]: {
    id: string;
    status: string;
    error?: string;
    actualQuality?: string | null;
    qualityNotice?: string;
  };
  [Events.mergeProgress]: { seriesId: string; stage: string; stageText?: string; progress: number };
  [Events.mergeState]: { seriesId: string; status: string; outputPath?: string; error?: string };
  [Events.transcodeProgress]: { taskId: string; percent: number };
  [Events.announcement]: unknown;
  [Events.updateChanged]: { status: string; version?: string | null; percent?: number; error?: string };
}
