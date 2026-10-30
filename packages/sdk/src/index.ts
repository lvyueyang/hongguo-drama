/**
 * SDK 唯一入口。宿主只依赖这里导出的内容。
 */
export * from './facade.ts';
export * from './media.ts';
export { refreshWatchHistory, SEQUEL_CHECK_INTERVAL_MS } from './services/history/refresh.ts';
export { seasonTitle, sourceOf } from './services/history/watch-history.ts';
export { createAnnouncementService } from './services/meta/announcements.ts';
export { availableRelease, updatesEnabled } from './services/meta/update.ts';
export { createUpdateInstaller } from './services/meta/update-installer.ts';
export { normalizePlayerSettings } from './services/settings/player.ts';
export type { StorageGroup, StorageTarget, StorageUsage } from './services/storage/targets.ts';
export {
  collectEpisodeTargets,
  collectSeriesTargets,
  collectStorageTargets,
  deleteStorageTargets,
  pruneEmptyDirs,
} from './services/storage/targets.ts';
