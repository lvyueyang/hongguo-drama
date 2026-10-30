/**
 * preload：只暴露契约里声明的 API，不泄漏 ipcRenderer，也不暴露 Node 能力。
 * 类型来自 @hongguo/contract（type-only 引入，不会把 zod 打进沙箱预加载脚本）。
 */

import type { EventPayloads, RendererApi } from '@hongguo/contract';
import { Channels } from '@hongguo/contract/channels';
import { contextBridge, ipcRenderer } from 'electron';

const api: RendererApi = {
  appInfo: () => ipcRenderer.invoke(Channels.appInfo),
  capabilities: () => ipcRenderer.invoke(Channels.capabilities),
  suggest: (request) => ipcRenderer.invoke(Channels.suggest, request),
  searchWeb: (request) => ipcRenderer.invoke(Channels.searchWeb, request),
  browseSources: () => ipcRenderer.invoke(Channels.browseSources),
  browseList: (request) => ipcRenderer.invoke(Channels.browseList, request),
  customSourceSave: (request) => ipcRenderer.invoke(Channels.customSourceSave, request),
  getSettings: () => ipcRenderer.invoke(Channels.settingsGet),
  saveSettings: (settings) => ipcRenderer.invoke(Channels.settingsSave, settings),
  downloadEnqueue: (request) => ipcRenderer.invoke(Channels.downloadEnqueue, request),
  downloadList: () => ipcRenderer.invoke(Channels.downloadList),
  downloadPause: (id) => ipcRenderer.invoke(Channels.downloadPause, id),
  downloadResume: (id) => ipcRenderer.invoke(Channels.downloadResume, id),
  downloadRemove: (id) => ipcRenderer.invoke(Channels.downloadRemove, id),
  playPrepare: (request) => ipcRenderer.invoke(Channels.playPrepare, request),
  playCancel: (request) => ipcRenderer.invoke(Channels.playCancel, request),
  mergeStart: (request) => ipcRenderer.invoke(Channels.mergeStart, request),
  mergeCancel: (seriesId) => ipcRenderer.invoke(Channels.mergeCancel, seriesId),
  transcode: (request) => ipcRenderer.invoke(Channels.mediaTranscode, request),
  libraryList: () => ipcRenderer.invoke(Channels.libraryList),
  libraryAdd: (request) => ipcRenderer.invoke(Channels.libraryAdd, request),
  libraryRemove: (seriesId) => ipcRenderer.invoke(Channels.libraryRemove, seriesId),
  seriesEpisodes: (seriesId) => ipcRenderer.invoke(Channels.seriesEpisodes, seriesId),
  seriesSequels: (seriesId) => ipcRenderer.invoke(Channels.seriesSequels, seriesId),
  historyList: (request) => ipcRenderer.invoke(Channels.historyList, request),
  historyRemove: (request) => ipcRenderer.invoke(Channels.historyRemove, request),
  rankings: (request) => ipcRenderer.invoke(Channels.rankings, request),
  accountStatus: () => ipcRenderer.invoke(Channels.accountStatus),
  accountStartLogin: () => ipcRenderer.invoke(Channels.accountStartLogin),
  accountPollLogin: (loginId) => ipcRenderer.invoke(Channels.accountPollLogin, { loginId }),
  accountCancelLogin: (loginId) => ipcRenderer.invoke(Channels.accountCancelLogin, { loginId }),
  accountLogout: () => ipcRenderer.invoke(Channels.accountLogout),
  accountHistory: (refresh) => ipcRenderer.invoke(Channels.accountHistory, { refresh: refresh === true }),
  progressGet: (request) => ipcRenderer.invoke(Channels.progressGet, request),
  progressSave: (request) => ipcRenderer.invoke(Channels.progressSave, request),
  exportText: (request) => ipcRenderer.invoke(Channels.exportText, request),
  announcementGet: () => ipcRenderer.invoke(Channels.announcementGet),
  announcementDismiss: (request) => ipcRenderer.invoke(Channels.announcementDismiss, request),
  announcementCheck: () => ipcRenderer.invoke(Channels.announcementCheck),
  updateCheck: () => ipcRenderer.invoke(Channels.updateCheck),
  updateState: () => ipcRenderer.invoke(Channels.updateState),
  updateDownload: () => ipcRenderer.invoke(Channels.updateDownload),
  updateInstall: () => ipcRenderer.invoke(Channels.updateInstall),
  updateCancel: () => ipcRenderer.invoke(Channels.updateCancel),
  storageUsage: () => ipcRenderer.invoke(Channels.storageUsage),
  storageDeleteAll: () => ipcRenderer.invoke(Channels.storageDeleteAll),
  storageDeleteSeries: (seriesId) => ipcRenderer.invoke(Channels.storageDeleteSeries, seriesId),
  storageDeleteEpisode: (request) => ipcRenderer.invoke(Channels.storageDeleteEpisode, request),
  libraryPurgeEmpty: () => ipcRenderer.invoke(Channels.libraryPurgeEmpty),
  proxyApply: () => ipcRenderer.invoke(Channels.proxyApply),
  proxyTest: (draft) => ipcRenderer.invoke(Channels.proxyTest, draft),
  danmakuList: (request) => ipcRenderer.invoke(Channels.danmakuList, request),
  historyRefresh: () => ipcRenderer.invoke(Channels.historyRefresh),
  playPrefetch: (request) => ipcRenderer.invoke(Channels.playPrefetch, request),
  playerFloatOpen: (request) => ipcRenderer.invoke(Channels.playerFloatOpen, request),
  playerFloatClose: () => ipcRenderer.invoke(Channels.playerFloatClose),
  on(event, listener) {
    // Events 的取值与 EventPayloads 的键一致，直接用事件名作为通道名。
    const channel = String(event);
    const wrapped = (_event: unknown, payload: EventPayloads[typeof event]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
