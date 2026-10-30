/**
 * 媒体能力对外子集：宿主（桌面端 / CLI）只从这里取媒体原语。
 * 与 facade 分开导出，避免把「队列 / 协议」这类宿主职责混进 SDK 门面。
 */

export { decryptMp4Buffer, decryptMp4File } from './providers/hongguo-web/player.ts';
export type { EpisodeCache, EpisodeCacheEntry, EpisodeCacheOptions } from './services/media/cache.ts';
export { createEpisodeCache, DEFAULT_MAX_BYTES, writeCacheFile } from './services/media/cache.ts';
export type { DecryptTaskOptions } from './services/media/decrypt.ts';
export { decryptBufferInWorker, decryptFileInWorker } from './services/media/decrypt.ts';
export type {
  DownloadEpisodeRequest,
  DownloadEpisodeResult,
  DownloadProgress,
  MediaOpener,
  PlayInfo,
} from './services/media/download.ts';
export { defaultOpen, downloadEpisode, verifyDownloadedFile } from './services/media/download.ts';
export { remuxHls } from './services/media/hls.ts';
export type { MergeEpisode, MergeRequest, MergeResult, MergeTask } from './services/media/merge.ts';
export { createEncoderPicker, defaultOutputPath, mergeSeries } from './services/media/merge.ts';
export {
  nextPrefetchTarget,
  type PrefetchEpisode,
  type PrefetchResult,
  prefetchNextEpisode,
  resetPrefetchState,
} from './services/media/prefetch.ts';
export type {
  MediaChunk,
  MediaSession,
  OpenSessionRequest,
  SessionRegistry,
} from './services/media/stream.ts';
export { createSessionRegistry, openBufferSession, openMediaSession } from './services/media/stream.ts';
export type { MediaProbeInfo, MediaTools } from './services/media/tools.ts';
export { probeMedia, publishFile, resolveMediaTools, runTool, shortEdge } from './services/media/tools.ts';
export type { TranscodeRequest, TranscodeResult } from './services/media/transcode.ts';
export { parseProgress, transcodeArgs, transcodeForCompat } from './services/media/transcode.ts';
export { default as announcementService } from './services/meta/announcements.ts';
