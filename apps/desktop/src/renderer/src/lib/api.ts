import type {
  BrowseRequest,
  CustomSourceSaveRequest,
  CustomSourceSaveResponse,
  DownloadEnqueueRequest,
  ExportTextRequest,
  HistoryListRequest,
  IpcResult,
  MergeStartRequest,
  PlayPrepareRequest,
  PlayPrepareResponse,
  ProgressDto,
  RankingsRequest,
  SettingsDto,
  SuggestItemDto,
  TranscodeRequest,
  TranscodeResponse,
} from '@hongguo/contract';

/** 把 IpcResult 信封拆成「值或抛错」，让 TanStack Query 的错误分支统一。 */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.data;
  const error = new Error(result.error.message);
  error.name = result.error.code;
  throw error;
}

/** 渲染层唯一的 API 入口：方法名与契约通道一一对应。 */
export const api = {
  appInfo: () => unwrap(window.api.appInfo()),
  capabilities: () => unwrap(window.api.capabilities()),
  suggest: (keyword: string) => unwrap(window.api.suggest({ keyword })),
  searchWeb: (keyword: string, page = 1, source?: string) =>
    unwrap(window.api.searchWeb({ keyword, page, source })),
  browseSources: () => unwrap(window.api.browseSources()),
  browseList: (request: BrowseRequest) => unwrap(window.api.browseList(request)),
  getSettings: () => unwrap(window.api.getSettings()),
  saveSettings: (settings: SettingsDto) => unwrap(window.api.saveSettings(settings)),

  libraryList: () => unwrap(window.api.libraryList()),
  libraryAdd: (seriesId: string) => unwrap(window.api.libraryAdd({ seriesId })),
  libraryRemove: (seriesId: string) => unwrap(window.api.libraryRemove(seriesId)),
  seriesEpisodes: (seriesId: string) => unwrap(window.api.seriesEpisodes(seriesId)),
  seriesSequels: (seriesId: string) => unwrap(window.api.seriesSequels(seriesId)),
  historyList: (request: HistoryListRequest) => unwrap(window.api.historyList(request)),
  rankings: (request: RankingsRequest) => unwrap(window.api.rankings(request)),

  downloadList: () => unwrap(window.api.downloadList()),
  downloadPause: (id: string) => unwrap(window.api.downloadPause(id)),
  downloadResume: (id: string) => unwrap(window.api.downloadResume(id)),
  downloadRemove: (id: string) => unwrap(window.api.downloadRemove(id)),
  downloadEnqueue: (request: DownloadEnqueueRequest) => unwrap(window.api.downloadEnqueue(request)),

  playPrepare: (
    request: Omit<PlayPrepareRequest, 'force'> & { force?: boolean },
  ): Promise<PlayPrepareResponse> => unwrap(window.api.playPrepare({ force: false, ...request })),
  playCancel: (sessionId: string) => unwrap(window.api.playCancel({ sessionId })),
  customSourceSave: (request: CustomSourceSaveRequest): Promise<CustomSourceSaveResponse> =>
    unwrap(window.api.customSourceSave(request)),
  mergeStart: (request: MergeStartRequest) => unwrap(window.api.mergeStart(request)),
  mergeCancel: (seriesId: string) => unwrap(window.api.mergeCancel(seriesId)),
  transcode: (request: TranscodeRequest): Promise<TranscodeResponse> => unwrap(window.api.transcode(request)),

  accountStatus: () => unwrap(window.api.accountStatus()),
  accountStartLogin: () => unwrap(window.api.accountStartLogin()),
  accountPollLogin: (loginId: string) => unwrap(window.api.accountPollLogin(loginId)),
  accountCancelLogin: (loginId: string) => unwrap(window.api.accountCancelLogin(loginId)),
  accountLogout: () => unwrap(window.api.accountLogout()),
  accountHistory: (refresh = false) => unwrap(window.api.accountHistory(refresh)),
  progressGet: (seriesId: string) => unwrap(window.api.progressGet({ seriesId })),
  announcementGet: () => unwrap(window.api.announcementGet()),
  storageUsage: () => unwrap(window.api.storageUsage()),
  proxyApply: () => unwrap(window.api.proxyApply()),
  proxyTest: (draft: Record<string, unknown>) => unwrap(window.api.proxyTest(draft)),
  historyRefresh: (seriesId?: string) => unwrap(window.api.historyRefresh(seriesId ? { seriesId } : {})),
  prefetch: (seriesId: string, currentVid: string, episodes: Array<{ vid: string; locked?: boolean }>) =>
    unwrap(window.api.playPrefetch({ seriesId, currentVid, episodes })),
  danmaku: (vid: string, seriesId: string, fresh = false) =>
    unwrap(window.api.danmakuList({ vid, seriesId, fresh })),
  floatOpen: (vid: string, seriesId: string) => unwrap(window.api.playerFloatOpen({ vid, seriesId })),
  floatClose: () => unwrap(window.api.playerFloatClose()),
  storageDeleteAll: () => unwrap(window.api.storageDeleteAll()),
  storageDeleteSeries: (seriesId: string) => unwrap(window.api.storageDeleteSeries(seriesId)),
  updateCheck: () => unwrap(window.api.updateCheck()),
  updateState: () => unwrap(window.api.updateState()),
  updateDownload: () => unwrap(window.api.updateDownload()),
  updateInstall: () => unwrap(window.api.updateInstall()),
  updateCancel: () => unwrap(window.api.updateCancel()),
  announcementDismiss: (mode: 'day' | 'version') => unwrap(window.api.announcementDismiss({ mode })),
  exportText: (request: ExportTextRequest) => unwrap(window.api.exportText(request)),
  historyRemove: (seriesId: string): Promise<{ removed: boolean }> =>
    unwrap(window.api.historyRemove({ seriesId })),
  progressSave: (request: {
    seriesId: string;
    vid: string;
    vidIndex: number;
    currentTime: number;
    duration: number;
    watched: boolean;
    /** 播到结尾了（完成证据；暂停不算） */
    ended?: boolean;
  }) => unwrap(window.api.progressSave({ ended: false, ...request })),
};

export type { ProgressDto, SuggestItemDto };
