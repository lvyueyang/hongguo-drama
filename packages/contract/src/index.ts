/**
 * IPC 契约单一真源：主进程用 zod 校验入参，preload 只取 channels.ts（不引入 zod）。
 */
import { z } from 'zod';
import type { EventPayloads, IpcResult } from './channels.ts';

export * from './channels.ts';

/* ===== 搜索联想 ===== */

export const suggestItemSeriesSchema = z.object({
  seriesId: z.string(),
  title: z.string(),
  intro: z.string(),
  cover: z.string(),
  episodeCount: z.number(),
  episodeRightText: z.string(),
  vids: z.array(z.string()),
  hotScore: z.number(),
  hotText: z.string(),
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
  celebrities: z.array(z.string()),
});

export const suggestItemSchema = z.object({
  wordType: z.enum(['short_play_name', 'common_query']),
  name: z.string(),
  keyword: z.string(),
  displayWords: z.array(z.string()),
  series: suggestItemSeriesSchema.nullable(),
});

export const suggestRequestSchema = z.object({
  keyword: z.string().min(1).max(30),
  limit: z.number().int().min(1).max(10).optional(),
});

export type SuggestItemDto = z.infer<typeof suggestItemSchema>;
export type SuggestRequest = z.infer<typeof suggestRequestSchema>;

/* ===== 搜索（官网接口；App 通道随后续里程碑接入）===== */

export const searchRequestSchema = z.object({
  keyword: z.string().min(1).max(80),
  page: z.number().int().min(1).max(50).optional(),
  // 来源：hongguo（默认，官网接口）/ hema / xifan / custom:<uuid>
  source: z.string().max(64).optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchResultSchema = z.object({
  seriesId: z.string(),
  title: z.string(),
  cover: z.string(),
  intro: z.string().optional(),
  source: z.string().optional(),
});

export type SearchResultDto = z.infer<typeof searchResultSchema>;

/* ===== 目录 ===== */

export const browseRequestSchema = z.object({
  source: z.string().min(1).max(64).default('hongguo'),
  category: z.string().max(64).optional(),
  genre: z.string().max(64).optional(),
  page: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(4096).nullable().optional(),
  appCatalog: z.boolean().optional(),
  // 目录线路：app = App 接口（默认），web = 官网页面
  catalogChannel: z.enum(['app', 'web']).optional(),
});

export type BrowseRequest = z.infer<typeof browseRequestSchema>;

export const browseSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
});

export type BrowseSourceDto = z.infer<typeof browseSourceSchema>;

/* ===== 下载与播放 ===== */

export const downloadEnqueueRequestSchema = z
  .object({
    seriesId: z.string().min(1).max(64),
    seriesTitle: z.string().max(200).default(''),
    vids: z.array(z.string().min(1).max(64)).min(1).max(500),
    quality: z.enum(['auto', '1080p', '720p']).default('auto'),
    root: z.string().max(4096).optional(),
  })
  // 跨来源混入直接拒绝：hema:/xifan:/custom: 的分集不能挂到别的剧下。
  // 放在契约层，宿主侧再兜一次，避免某个宿主漏判。
  .refine(
    (value) => {
      const prefixOf = (id: string) => /^(hema|xifan|custom):/.exec(id)?.[0] ?? '';
      const series = prefixOf(value.seriesId);
      return value.vids.every((vid) => prefixOf(vid) === series);
    },
    { message: '分集与剧集来源不匹配', path: ['vids'] },
  );

export type DownloadEnqueueRequest = z.infer<typeof downloadEnqueueRequestSchema>;

/* ===== 自定义源管理 ===== */

export const customSourceDraftSchema = z.object({
  /** 新增时没有编号；更新时必须给出，否则会新建一个来源 */
  id: z.string().max(64).optional(),
  name: z.string().min(1).max(80),
  url: z.string().min(1).max(4096),
  enabled: z.boolean().optional(),
});

export const customSourceSaveRequestSchema = z.object({
  source: customSourceDraftSchema,
  /** true = 删除这个来源 */
  remove: z.boolean().default(false),
  /** true = 保存前先真连一次接口 */
  test: z.boolean().default(false),
});
export type CustomSourceSaveRequest = z.infer<typeof customSourceSaveRequestSchema>;

export const customSourceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
});
export type CustomSourceView = z.infer<typeof customSourceViewSchema>;

export const customSourceSaveResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  sources: z.array(customSourceViewSchema),
});
export type CustomSourceSaveResponse = z.infer<typeof customSourceSaveResponseSchema>;

export const danmakuRequestSchema = z.object({
  vid: z.string().min(1).max(64),
  seriesId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(2000).optional(),
  fresh: z.boolean().optional(),
});
export type DanmakuRequest = z.infer<typeof danmakuRequestSchema>;

export const danmakuItemSchema = z.object({
  time: z.number(),
  text: z.string(),
  color: z.string().optional(),
  mode: z.string().optional(),
});

export const danmakuResponseSchema = z.object({
  success: z.boolean(),
  items: z.array(danmakuItemSchema),
  notice: z.string().default(''),
  error: z.string().default(''),
});
export type DanmakuResponse = z.infer<typeof danmakuResponseSchema>;

/** 预取请求：渲染层把当前分集表交上来，由主进程决定并执行预取。 */
export const prefetchRequestSchema = z.object({
  seriesId: z.string().min(1).max(64),
  currentVid: z.string().min(1).max(64),
  episodes: z.array(z.object({ vid: z.string().min(1).max(64), locked: z.boolean().optional() })).max(2000),
});
export type PrefetchRequest = z.infer<typeof prefetchRequestSchema>;

export const floatOpenRequestSchema = z.object({
  vid: z.string().min(1).max(64),
  seriesId: z.string().min(1).max(64),
});
export type FloatOpenRequest = z.infer<typeof floatOpenRequestSchema>;

export const playPrepareRequestSchema = z.object({
  vid: z.string().min(1).max(64),
  seriesId: z.string().max(30).optional(),
  quality: z.enum(['auto', '1080p', '720p']).default('auto'),
  /**
   * 强制重新取源（忽略缓存）。用户手动「重试」时必须带它：
   * 不然会把上一次失败的缓存结果原样再拿一遍。
   */
  force: z.boolean().default(false),
});

export const playCancelRequestSchema = z.object({ sessionId: z.string().min(1).max(128) });
export type PlayCancelRequest = z.infer<typeof playCancelRequestSchema>;

export type PlayPrepareRequest = z.infer<typeof playPrepareRequestSchema>;

export const playPrepareResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

export type PlayPrepareResponse = z.infer<typeof playPrepareResponseSchema>;

/* ===== 剧库 / 观看记录 / 榜单 / 账号 ===== */

export const seriesIdSchema = z.string().min(1).max(64);

export const libraryAddRequestSchema = z.object({ seriesId: seriesIdSchema });
export const deleteEpisodeRequestSchema = z.object({ taskId: z.string().min(1).max(200) });
export const rankingsRequestSchema = z.object({
  kind: z.enum(['hot-drama', 'hot-real-drama', 'hot-comic-drama', 'hot-ai-drama']).default('hot-drama'),
  page: z.number().int().min(1).max(50).default(1),
});
export const historyListRequestSchema = z.object({
  scope: z.enum(['all', 'latest', 'unfinished', 'skip-completed-low']).default('all'),
});
export const historyRefreshRequestSchema = z.object({
  /** 只重检这一部剧（单行重检；忽略 24 小时检查点） */
  seriesId: seriesIdSchema.optional(),
});
export type HistoryRefreshRequest = z.infer<typeof historyRefreshRequestSchema>;

export const historyRemoveRequestSchema = z.object({ seriesId: seriesIdSchema });
export type HistoryRemoveRequest = z.infer<typeof historyRemoveRequestSchema>;
export const accountHistoryRequestSchema = z.object({ refresh: z.boolean().default(false) });
export const accountPollRequestSchema = z.object({ loginId: z.string().min(1).max(200) });

export type RankingsRequest = z.infer<typeof rankingsRequestSchema>;
export type HistoryListRequest = z.infer<typeof historyListRequestSchema>;

/* ===== 公告 ===== */

export const announcementDismissRequestSchema = z.object({ mode: z.enum(['day', 'version']) });
export type AnnouncementDismissRequest = z.infer<typeof announcementDismissRequestSchema>;

/* ===== 文字导出（弹幕 / 评论 / 剧评）===== */

export const exportTextRequestSchema = z
  .object({
    seriesId: seriesIdSchema,
    seriesTitle: z.string().max(200).default(''),
    kinds: z
      .object({
        danmaku: z.boolean().default(false),
        comments: z.boolean().default(false),
        reviews: z.boolean().default(false),
      })
      .default({ danmaku: false, comments: false, reviews: false }),
  })
  // 三类都没选时不应该发起导出：在契约层就拒绝，宿主侧再兜一次。
  .refine((value) => value.kinds.danmaku || value.kinds.comments || value.kinds.reviews, {
    message: '请至少选择一种要导出的文字数据',
    path: ['kinds'],
  });
export const exportTextResultSchema = z.object({
  danmaku: z.object({
    ok: z.number(),
    fail: z.number(),
    skipped: z.number(),
    partial: z.number(),
    items: z.number(),
    empty: z.number(),
    unavailable: z.number(),
  }),
  comments: z.object({
    ok: z.number(),
    fail: z.number(),
    skipped: z.number(),
    partial: z.number(),
    items: z.number(),
    empty: z.number(),
    unavailable: z.number(),
  }),
  reviews: z.object({
    ok: z.number(),
    fail: z.number(),
    skipped: z.number(),
    partial: z.number(),
    items: z.number(),
    empty: z.number(),
    unavailable: z.number(),
  }),
  files: z.array(z.string()),
});

export type ExportTextRequest = z.infer<typeof exportTextRequestSchema>;
export type ExportTextResult = z.infer<typeof exportTextResultSchema>;

/* ===== 播放进度（断点续播）===== */

export const progressGetRequestSchema = z.object({ seriesId: seriesIdSchema });
export const progressSaveRequestSchema = z.object({
  seriesId: seriesIdSchema,
  vid: z.string().min(1).max(64),
  vidIndex: z.number().int().min(1).max(100000),
  currentTime: z.number().min(0).max(86400),
  duration: z.number().min(0).max(86400).default(0),
  watched: z.boolean().default(false),
  /**
   * 这一集是不是播到结尾了。
   * 只看 `watched` 分不出「暂停」与「播完」，而「已看完的低季不再提示」必须靠播完的证据。
   */
  ended: z.boolean().default(false),
});
export const progressSchema = z
  .object({
    vid: z.string(),
    vidIndex: z.number(),
    currentTime: z.number(),
    duration: z.number(),
    updatedAt: z.number(),
    watched: z.boolean(),
  })
  .nullable();

export type ProgressGetRequest = z.infer<typeof progressGetRequestSchema>;
export type ProgressSaveRequest = z.infer<typeof progressSaveRequestSchema>;
export type ProgressDto = z.infer<typeof progressSchema>;

/* ===== 合并与转码 ===== */

export const mergeStartRequestSchema = z.object({
  seriesId: z.string().min(1).max(64),
  compatible: z.boolean().default(false),
  /**
   * 只合并达到 1080P 的分集（4.5 的 require1080）：任一集达不到就拒绝，
   * 而不是悄悄把 720P 的集混进「合集」里。
   */
  require1080: z.boolean().default(false),
});

export type MergeStartRequest = z.infer<typeof mergeStartRequestSchema>;

export const mergeStartResponseSchema = z.object({
  seriesId: z.string(),
  outputPath: z.string(),
  count: z.number(),
});

export type MergeStartResponse = z.infer<typeof mergeStartResponseSchema>;

export const transcodeRequestSchema = z.object({
  taskId: z.string().min(1).max(200),
});

export type TranscodeRequest = z.infer<typeof transcodeRequestSchema>;

export const transcodeResponseSchema = z.object({
  url: z.string(),
  cached: z.boolean(),
});

export type TranscodeResponse = z.infer<typeof transcodeResponseSchema>;

/* ===== 设置 ===== */

/** 画中画模式：native 用系统 PiP，custom 用应用自己的悬浮窗口（4.5 `picture_in_picture_mode`）。 */
export const pictureInPictureModeSchema = z.enum(['native', 'custom']);
export type PictureInPictureMode = z.infer<typeof pictureInPictureModeSchema>;

export const floatingSizeSchema = z.object({
  width: z.number().int().min(180).max(900),
  height: z.number().int().min(240).max(1600),
});

export const settingsSchema = z.record(z.string(), z.unknown());
export type SettingsDto = z.infer<typeof settingsSchema>;

/* ===== 应用信息与能力 ===== */

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  architecture: z.string(),
});

export type AppInfoDto = z.infer<typeof appInfoSchema>;

export const capabilitiesSchema = z.object({
  canPlayAnonymous: z.boolean(),
  accountAffectsPlayback: z.boolean(),
  accountCloudHistory: z.boolean(),
  suggestEndpoint: z.string(),
});

export type CapabilitiesDto = z.infer<typeof capabilitiesSchema>;

/** preload 暴露给渲染层的 API 形状。 */
export interface RendererApi {
  appInfo(): Promise<IpcResult<AppInfoDto>>;
  capabilities(): Promise<IpcResult<CapabilitiesDto>>;
  suggest(request: SuggestRequest): Promise<IpcResult<SuggestItemDto[]>>;
  searchWeb(request: SearchRequest): Promise<IpcResult<unknown>>;
  browseSources(): Promise<IpcResult<BrowseSourceDto[]>>;
  browseList(request: BrowseRequest): Promise<IpcResult<unknown>>;
  customSourceSave(request: CustomSourceSaveRequest): Promise<IpcResult<CustomSourceSaveResponse>>;
  getSettings(): Promise<IpcResult<SettingsDto>>;
  saveSettings(settings: SettingsDto): Promise<IpcResult<SettingsDto>>;
  downloadEnqueue(request: DownloadEnqueueRequest): Promise<IpcResult<unknown>>;
  downloadList(): Promise<IpcResult<unknown>>;
  downloadPause(id: string): Promise<IpcResult<unknown>>;
  downloadResume(id: string): Promise<IpcResult<unknown>>;
  downloadRemove(id: string): Promise<IpcResult<unknown>>;
  playPrepare(request: PlayPrepareRequest): Promise<IpcResult<PlayPrepareResponse>>;
  /** 取消一次播放会话（释放上游连接与临时文件） */
  playCancel(request: PlayCancelRequest): Promise<IpcResult<{ released: boolean }>>;
  mergeStart(request: MergeStartRequest): Promise<IpcResult<MergeStartResponse>>;
  mergeCancel(seriesId: string): Promise<IpcResult<unknown>>;
  transcode(request: TranscodeRequest): Promise<IpcResult<TranscodeResponse>>;
  libraryList(): Promise<IpcResult<unknown>>;
  libraryAdd(request: { seriesId: string }): Promise<IpcResult<unknown>>;
  libraryRemove(seriesId: string): Promise<IpcResult<unknown>>;
  seriesEpisodes(seriesId: string): Promise<IpcResult<unknown>>;
  seriesSequels(seriesId: string): Promise<IpcResult<unknown>>;
  historyList(request: HistoryListRequest): Promise<IpcResult<unknown>>;
  historyRemove(request: HistoryRemoveRequest): Promise<IpcResult<{ removed: boolean }>>;
  rankings(request: RankingsRequest): Promise<IpcResult<unknown>>;
  accountStatus(): Promise<IpcResult<unknown>>;
  accountStartLogin(): Promise<IpcResult<unknown>>;
  accountPollLogin(loginId: string): Promise<IpcResult<unknown>>;
  accountCancelLogin(loginId: string): Promise<IpcResult<unknown>>;
  accountLogout(): Promise<IpcResult<unknown>>;
  accountHistory(refresh?: boolean): Promise<IpcResult<unknown>>;
  progressGet(request: ProgressGetRequest): Promise<IpcResult<ProgressDto>>;
  progressSave(request: ProgressSaveRequest): Promise<IpcResult<ProgressDto>>;
  exportText(request: ExportTextRequest): Promise<IpcResult<ExportTextResult>>;
  announcementGet(): Promise<IpcResult<unknown>>;
  announcementDismiss(request: AnnouncementDismissRequest): Promise<IpcResult<unknown>>;
  announcementCheck(): Promise<IpcResult<unknown>>;
  updateCheck(): Promise<IpcResult<unknown>>;
  updateState(): Promise<IpcResult<unknown>>;
  updateDownload(): Promise<IpcResult<unknown>>;
  updateInstall(): Promise<IpcResult<unknown>>;
  updateCancel(): Promise<IpcResult<unknown>>;
  storageUsage(): Promise<IpcResult<unknown>>;
  storageDeleteAll(): Promise<IpcResult<unknown>>;
  storageDeleteSeries(seriesId: string): Promise<IpcResult<unknown>>;
  storageDeleteEpisode(request: { taskId: string }): Promise<IpcResult<unknown>>;
  libraryPurgeEmpty(): Promise<IpcResult<unknown>>;
  proxyApply(): Promise<IpcResult<unknown>>;
  proxyTest(draft: Record<string, unknown>): Promise<IpcResult<unknown>>;
  danmakuList(request: DanmakuRequest): Promise<IpcResult<DanmakuResponse>>;
  historyRefresh(request?: HistoryRefreshRequest): Promise<IpcResult<{ checked: number; failed: number }>>;
  playPrefetch(
    request: PrefetchRequest,
  ): Promise<IpcResult<{ target: string; status: string; error?: string }>>;
  playerFloatOpen(request: FloatOpenRequest): Promise<IpcResult<{ opened: boolean }>>;
  playerFloatClose(): Promise<IpcResult<{ closed: boolean }>>;
  on<E extends keyof EventPayloads>(event: E, listener: (payload: EventPayloads[E]) => void): () => void;
}
