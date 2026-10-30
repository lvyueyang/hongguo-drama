/**
 * IPC 注册（不 import electron，因此可以在 node 下直接测试）。
 *
 * 这是替代 4.5「用 vm 跑 main.js + 手写假 Electron」的关键结构：
 * 主进程把 ipcMain / 可信发送者 / 事件广播 / 业务端口都作为依赖传进来，
 * 测试只要注入 stub 即可覆盖校验、越权与错误分支。
 */
import {
  type AnnouncementDismissRequest,
  accountHistoryRequestSchema,
  accountPollRequestSchema,
  announcementDismissRequestSchema,
  type BrowseRequest,
  browseRequestSchema,
  Channels,
  type DanmakuRequest,
  type DownloadEnqueueRequest,
  danmakuRequestSchema,
  deleteEpisodeRequestSchema,
  downloadEnqueueRequestSchema,
  type EventPayloads,
  type ExportTextRequest,
  exportTextRequestSchema,
  floatOpenRequestSchema,
  historyListRequestSchema,
  type IpcResult,
  ipcFail,
  ipcOk,
  libraryAddRequestSchema,
  type MergeStartRequest,
  mergeStartRequestSchema,
  type PlayPrepareRequest,
  type PrefetchRequest,
  type ProgressGetRequest,
  type ProgressSaveRequest,
  playPrepareRequestSchema,
  prefetchRequestSchema,
  progressGetRequestSchema,
  progressSaveRequestSchema,
  rankingsRequestSchema,
  searchRequestSchema,
  seriesIdSchema,
  settingsSchema,
  suggestRequestSchema,
  type TranscodeRequest,
  transcodeRequestSchema,
} from '@hongguo/contract';

/** 业务端口：只声明本层用到的能力，便于测试替换。 */
export interface IpcSdkPort {
  capabilities(): unknown;
  suggest(keyword: string, options?: { limit?: number }): Promise<unknown>;
  search: { web(keyword: string, options?: unknown): Promise<unknown> };
  catalog: { sources(): unknown; app(options?: Record<string, unknown>): Promise<unknown> };
  storage: { getSettings(): Record<string, unknown>; saveSettings(settings: Record<string, unknown>): void };
  danmaku: { fetch(options?: unknown): Promise<unknown> };
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface IpcDownloadPort {
  enqueue(request: DownloadEnqueueRequest): unknown;
  list(): unknown;
  pause(id: string): unknown;
  resume(id: string): unknown;
  remove(id: string, options?: { deleteFiles?: boolean }): unknown;
}

export interface IpcPlaybackPort {
  prepare(request: PlayPrepareRequest): Promise<{ url: string; sessionId: string }>;
}

export interface IpcMergePort {
  start(request: MergeStartRequest): Promise<unknown>;
  cancel(seriesId: string): unknown;
}

export interface IpcTranscodePort {
  run(request: TranscodeRequest): Promise<{ url: string; cached: boolean }>;
}

export interface IpcLibraryPort {
  list(): unknown;
  purgeEmpty(): unknown;
  add(seriesId: string): Promise<unknown>;
  remove(seriesId: string): unknown;
}

export interface IpcSeriesPort {
  episodes(seriesId: string): Promise<unknown>;
  sequels(seriesId: string): Promise<unknown>;
}

export interface IpcHistoryPort {
  list(scope: string): unknown;
}

export interface IpcRankingsPort {
  list(kind: string, page: number): Promise<unknown>;
}

export interface IpcAccountPort {
  status(): Promise<unknown>;
  startLogin(): Promise<unknown>;
  pollLogin(loginId: string): Promise<unknown>;
  cancelLogin(loginId: string): Promise<unknown>;
  logout(): Promise<unknown>;
  history(refresh: boolean): Promise<unknown>;
}

export interface IpcProgressPort {
  get(seriesId: string): unknown;
  save(request: ProgressSaveRequest): unknown;
}

export interface IpcExportPort {
  run(request: ExportTextRequest): Promise<unknown>;
}

export interface IpcAnnouncementPort {
  get(): Promise<unknown>;
  dismiss(request: AnnouncementDismissRequest): unknown;
  check(): Promise<unknown>;
}

export interface IpcUpdatePort {
  check(): Promise<unknown>;
  state(): unknown;
  // 下载/安装/取消可能是同步返回（例如被前置条件拦下），统一放宽以便测试替身。
  download(): unknown;
  install(): unknown;
  cancel(): unknown;
}

export interface IpcStoragePort {
  usage(): unknown;
  deleteAll(): unknown;
  deleteSeries(seriesId: string): unknown;
  deleteEpisode(request: { taskId: string }): unknown;
}

export interface IpcProxyPort {
  apply(): unknown;
  test(draft: Record<string, unknown>): Promise<unknown>;
}

export interface IpcHistoryRefreshPort2 {
  refresh(): Promise<{ checked: number; failed: number }>;
}

export interface IpcPrefetchPort {
  run(input: {
    seriesId: string;
    currentVid: string;
    episodes: Array<{ vid: string; locked?: boolean }>;
  }): Promise<{ target: string; status: string; error?: string }>;
}

export interface IpcFloatingPort {
  open(input: { vid: string; seriesId: string }): { opened: boolean };
  close(): { closed: boolean };
}

export interface IpcSearchPort {
  query(input: { keyword: string; page?: number; source?: string }): Promise<unknown>;
}

export interface IpcCatalogPort {
  list(input: {
    source: string;
    category?: string;
    genre?: string;
    page?: number;
    cursor?: string | null;
    catalogChannel?: 'app' | 'web';
  }): Promise<unknown>;
}

export interface IpcDeps {
  ipcMain: IpcMainLike;
  sdk: IpcSdkPort;
  floating: IpcFloatingPort;
  prefetch: IpcPrefetchPort;
  historyRefresh: IpcHistoryRefreshPort2;
  search: IpcSearchPort;
  catalog: IpcCatalogPort;
  isTrustedSender(event: unknown): boolean;
  appInfo(): unknown;
  download: IpcDownloadPort;
  playback: IpcPlaybackPort;
  merge: IpcMergePort;
  transcode: IpcTranscodePort;
  library: IpcLibraryPort;
  series: IpcSeriesPort;
  history: IpcHistoryPort;
  rankings: IpcRankingsPort;
  account: IpcAccountPort;
  progress: IpcProgressPort;
  exportText: IpcExportPort;
  announcement: IpcAnnouncementPort;
  update: IpcUpdatePort;
  storage: IpcStoragePort;
  proxy: IpcProxyPort;
  logger: { warn(message: string): void };
}

export type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>;

export function registerIpcHandlers({
  ipcMain,
  sdk,
  isTrustedSender,
  appInfo,
  download,
  playback,
  merge,
  transcode,
  library,
  series,
  history,
  rankings,
  account,
  progress,
  exportText,
  announcement,
  update,
  storage,
  proxy,
  logger,
  catalog,
  search,
  floating,
  prefetch,
  historyRefresh,
}: IpcDeps): void {
  const handle = <TIn, TOut>(
    channel: string,
    parse: (input: unknown) => TIn,
    run: (input: TIn) => Promise<TOut> | TOut,
  ): void => {
    ipcMain.handle(channel, async (event, raw): Promise<IpcResult<TOut>> => {
      if (!isTrustedSender(event)) return ipcFail('UNTRUSTED_SENDER', '窗口请求无效');
      let input: TIn;
      try {
        input = parse(raw);
      } catch (error) {
        return ipcFail('INPUT_INVALID', (error as Error).message || '请求参数无效');
      }
      try {
        return ipcOk(await run(input));
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        const message = (error as Error).message || '操作失败';
        logger.warn(`${channel} 失败: ${message}`);
        return ipcFail(code, message);
      }
    });
  };

  const noInput = (): undefined => undefined;

  handle(Channels.appInfo, noInput, () => appInfo());
  handle(Channels.capabilities, noInput, () => sdk.capabilities());
  handle(
    Channels.suggest,
    (raw) => suggestRequestSchema.parse(raw),
    (input) => sdk.suggest(input.keyword, { limit: input.limit }),
  );
  handle(
    Channels.searchWeb,
    (raw) => searchRequestSchema.parse(raw),
    (input) => sdk.search.web(input.keyword, { page: input.page ?? 1 }),
  );
  handle(Channels.browseSources, noInput, () => sdk.catalog.sources());
  handle(
    Channels.browseList,
    (raw) => browseRequestSchema.parse(raw),
    (input: BrowseRequest) =>
      sdk.catalog.app({
        source: input.source,
        category: input.category,
        genre: input.genre,
        page: input.page ?? 1,
        cursor: input.cursor ?? null,
      }),
  );
  handle(Channels.settingsGet, noInput, () => sdk.storage.getSettings());
  handle(
    Channels.settingsSave,
    (raw) => settingsSchema.parse(raw),
    (input) => {
      sdk.storage.saveSettings(input);
      return sdk.storage.getSettings();
    },
  );

  handle(
    Channels.downloadEnqueue,
    (raw) => downloadEnqueueRequestSchema.parse(raw),
    (input) => download.enqueue(input),
  );
  handle(Channels.downloadList, noInput, () => download.list());
  handle(
    Channels.downloadPause,
    (raw) => String(raw ?? ''),
    (id) => {
      if (!id) throw Object.assign(new Error('缺少任务编号'), { code: 'INPUT_INVALID' });
      return download.pause(id);
    },
  );
  handle(
    Channels.downloadResume,
    (raw) => String(raw ?? ''),
    (id) => {
      if (!id) throw Object.assign(new Error('缺少任务编号'), { code: 'INPUT_INVALID' });
      return download.resume(id);
    },
  );
  handle(
    Channels.downloadRemove,
    (raw) => String(raw ?? ''),
    (id) => {
      if (!id) throw Object.assign(new Error('缺少任务编号'), { code: 'INPUT_INVALID' });
      return { removed: download.remove(id) };
    },
  );
  handle(
    Channels.playPrepare,
    (raw) => playPrepareRequestSchema.parse(raw),
    (input) => playback.prepare(input),
  );

  handle(
    Channels.mergeStart,
    (raw) => mergeStartRequestSchema.parse(raw),
    (input) => merge.start(input),
  );
  handle(
    Channels.mergeCancel,
    (raw) => String(raw ?? ''),
    (seriesId) => {
      if (!seriesId) throw Object.assign(new Error('缺少剧集编号'), { code: 'INPUT_INVALID' });
      return merge.cancel(seriesId);
    },
  );
  handle(
    Channels.mediaTranscode,
    (raw) => transcodeRequestSchema.parse(raw),
    (input) => transcode.run(input),
  );

  handle(Channels.libraryList, noInput, () => library.list());
  handle(Channels.libraryPurgeEmpty, noInput, () => library.purgeEmpty());
  handle(
    Channels.libraryAdd,
    (raw) => libraryAddRequestSchema.parse(raw),
    (input) => library.add(input.seriesId),
  );
  handle(
    Channels.libraryRemove,
    (raw) => seriesIdSchema.parse(raw),
    (seriesId) => library.remove(seriesId),
  );
  handle(
    Channels.seriesEpisodes,
    (raw) => seriesIdSchema.parse(raw),
    (seriesId) => series.episodes(seriesId),
  );
  handle(
    Channels.seriesSequels,
    (raw) => seriesIdSchema.parse(raw),
    (seriesId) => series.sequels(seriesId),
  );
  handle(
    Channels.historyList,
    (raw) => historyListRequestSchema.parse(raw),
    (input) => history.list(input.scope),
  );
  handle(
    Channels.rankings,
    (raw) => rankingsRequestSchema.parse(raw),
    (input) => rankings.list(input.kind, input.page),
  );
  handle(Channels.accountStatus, noInput, () => account.status());
  handle(Channels.accountStartLogin, noInput, () => account.startLogin());
  handle(
    Channels.accountPollLogin,
    (raw) => accountPollRequestSchema.parse(raw),
    (input) => account.pollLogin(input.loginId),
  );
  handle(
    Channels.accountCancelLogin,
    (raw) => accountPollRequestSchema.parse(raw),
    (input) => account.cancelLogin(input.loginId),
  );
  handle(Channels.accountLogout, noInput, () => account.logout());
  handle(
    Channels.accountHistory,
    (raw) => accountHistoryRequestSchema.parse(raw ?? {}),
    (input) => account.history(input.refresh),
  );
  handle(
    Channels.progressGet,
    (raw) => progressGetRequestSchema.parse(raw),
    (input: ProgressGetRequest) => progress.get(input.seriesId),
  );
  handle(
    Channels.progressSave,
    (raw) => progressSaveRequestSchema.parse(raw),
    (input: ProgressSaveRequest) => progress.save(input),
  );
  handle(
    Channels.exportText,
    (raw) => exportTextRequestSchema.parse(raw),
    (input: ExportTextRequest) => exportText.run(input),
  );
  handle(Channels.announcementGet, noInput, () => announcement.get());
  handle(
    Channels.announcementDismiss,
    (raw) => announcementDismissRequestSchema.parse(raw),
    (input) => announcement.dismiss(input),
  );
  handle(Channels.announcementCheck, noInput, () => announcement.check());
  handle(Channels.updateCheck, noInput, () => update.check());
  handle(Channels.updateState, noInput, () => update.state());
  handle(Channels.updateDownload, noInput, () => update.download());
  handle(Channels.updateInstall, noInput, () => update.install());
  handle(Channels.updateCancel, noInput, () => update.cancel());
  handle(Channels.storageUsage, noInput, () => storage.usage());
  handle(Channels.storageDeleteAll, noInput, () => storage.deleteAll());
  handle(
    Channels.storageDeleteSeries,
    (raw) => seriesIdSchema.parse(raw),
    (seriesId) => storage.deleteSeries(seriesId),
  );
  handle(
    Channels.storageDeleteEpisode,
    (raw) => deleteEpisodeRequestSchema.parse(raw),
    (input) => storage.deleteEpisode(input),
  );
  handle(
    Channels.playerFloatOpen,
    (raw) => floatOpenRequestSchema.parse(raw),
    (input) => floating.open(input),
  );
  handle(Channels.historyRefresh, noInput, () => historyRefresh.refresh());
  handle(
    Channels.danmakuList,
    (raw) => danmakuRequestSchema.parse(raw),
    (input: DanmakuRequest) =>
      sdk.danmaku.fetch({
        vid: input.vid,
        seriesId: input.seriesId,
        limit: input.limit,
        fresh: input.fresh === true,
      }),
  );
  handle(
    Channels.playPrefetch,
    (raw) => prefetchRequestSchema.parse(raw),
    (input: PrefetchRequest) => prefetch.run(input),
  );
  handle(Channels.playerFloatClose, noInput, () => floating.close());
  handle(Channels.proxyApply, noInput, () => proxy.apply());
  handle(
    Channels.proxyTest,
    (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}),
    (input) => proxy.test(input),
  );
}

export type { EventPayloads };
