/**
 * 本地持久化：单个 JSON 文件保存设置、下载任务、短剧档案、播放进度与合并记录。
 *
 * 沿用 4.5 `src/store.js` 的行为约定（有回归测试保护，不能改）：
 * - 原子写 tmp → fsync → rename，权限 0600；
 * - 读取失败（非 ENOENT）冻结保存并回滚内存副本，避免用坏数据覆盖原文件；
 * - 写失败回滚内存副本、删除临时文件并上报，然后抛出原错误。
 *
 * 迁移自 4.5 `src/store.js`（破坏性重构 M1），补全类型；文件路径由宿主注入。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CustomSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface Settings {
  root?: string;
  name_format?: string;
  max_concurrent?: number;
  download_quality?: string;
  custom_sources?: CustomSource[];
  auto_delete_watched?: boolean;
  compat_mode?: boolean;
  cache_next_episode?: boolean;
  app_updates_enabled?: boolean;
  watch_updates_enabled?: boolean;
  watch_sequels_enabled?: boolean;
  watch_notifications_enabled?: boolean;
  search_app_enabled?: boolean;
  proxy_enabled?: boolean;
  proxy_mode?: 'system' | 'custom' | 'direct';
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
  export_text?: Record<string, boolean>;
  builtin_sources?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface DownloadTask {
  id: string;
  status?: string;
  progress?: number;
  [key: string]: unknown;
}

export interface SeriesEntry {
  series_id: string;
  series_title?: string;
  episodes?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface StoreDocument {
  settings: Settings;
  tasks: DownloadTask[];
  series?: SeriesEntry[];
  playback?: Record<string, Record<string, unknown>>;
  mergeTasks?: Array<Record<string, unknown>>;
  announcement?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StoreErrorPayload {
  error: string;
}

export const READ_ERROR_MESSAGE =
  '读取本地数据失败，已保留原文件并暂停保存；请检查文件或目录权限，恢复数据后重启应用。';
const WRITE_ERROR_MESSAGE = '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。';

export interface Store {
  init(filePath: string): void;
  setErrorHandler(handler: ((payload: StoreErrorPayload | null) => void) | null): void;
  getSettings(): Settings;
  saveSettings(settings: Partial<Settings>): void;
  getAnnouncementState(): Record<string, unknown>;
  saveAnnouncementState(patch: Record<string, unknown>): void;
  getTasks(): DownloadTask[];
  saveTasks(tasks: DownloadTask[]): void;
  getSeries(): SeriesEntry[];
  saveSeries(list: SeriesEntry[]): void;
  getPlayback(): Record<string, Record<string, unknown>>;
  savePlayback(map: Record<string, Record<string, unknown>>): void;
  getMergeTasks(): Array<Record<string, unknown>>;
  saveMergeTasks(list: Array<Record<string, unknown>>): void;
}

export function createStore(): Store {
  let dataFile: string | null = null;
  let cache: StoreDocument | null = null;
  let durable = '{}';
  let errorHandler: ((payload: StoreErrorPayload | null) => void) | null = null;
  let readError: (Error & { code?: string }) | null = null;
  let writeError = false;

  const reportReadError = (): void => {
    try {
      errorHandler?.({ error: READ_ERROR_MESSAGE });
    } catch {
      /* 上报失败不影响主流程 */
    }
  };

  function loadCache(): StoreDocument {
    if (!dataFile) throw new Error('store 未初始化');
    if (cache) return cache;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Invalid store document');
      }
      const document = parsed as StoreDocument;
      for (const key of ['tasks', 'series', 'mergeTasks']) {
        if (key in document && !Array.isArray(document[key])) throw new TypeError(`Invalid store ${key}`);
      }
      for (const key of ['settings', 'playback']) {
        const value = document[key];
        if (key in document && (!value || typeof value !== 'object' || Array.isArray(value))) {
          throw new TypeError(`Invalid store ${key}`);
        }
      }
      cache = document;
    } catch (error) {
      cache = {} as StoreDocument;
      if ((error as { code?: string }).code !== 'ENOENT') {
        const failure = new Error(READ_ERROR_MESSAGE, { cause: error }) as Error & { code?: string };
        failure.code = 'STORE_READ_FAILED';
        readError = failure;
        reportReadError();
      }
    }
    if (!Array.isArray(cache.tasks)) cache.tasks = [];
    if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
    durable = JSON.stringify(cache);
    return cache;
  }

  function flush(): void {
    if (!dataFile) return;
    const file = dataFile;
    if (readError) {
      cache = JSON.parse(durable) as StoreDocument;
      reportReadError();
      throw readError;
    }
    const temporary = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const serialized = JSON.stringify(cache ?? {}, null, 2);
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, serialized, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      durable = serialized;
      if (writeError) {
        writeError = false;
        try {
          errorHandler?.(null);
        } catch {
          /* 上报失败不影响主流程 */
        }
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* 临时文件可能已不存在 */
      }
      cache = JSON.parse(durable) as StoreDocument;
      writeError = true;
      try {
        errorHandler?.({ error: WRITE_ERROR_MESSAGE });
      } catch {
        /* 上报失败不影响主流程 */
      }
      throw error;
    }
  }

  return {
    init(filePath) {
      dataFile = filePath;
      cache = null;
      readError = null;
      writeError = false;
      loadCache();
    },
    setErrorHandler(handler) {
      errorHandler = handler;
    },
    getSettings() {
      return loadCache().settings;
    },
    saveSettings(settings) {
      loadCache().settings = (settings ?? {}) as Settings;
      flush();
    },
    getAnnouncementState() {
      const state = loadCache().announcement;
      return state && typeof state === 'object' && !Array.isArray(state)
        ? (structuredClone(state) as Record<string, unknown>)
        : {};
    },
    saveAnnouncementState(patch) {
      loadCache().announcement = { ...this.getAnnouncementState(), ...patch };
      flush();
    },
    getTasks() {
      return loadCache().tasks;
    },
    saveTasks(tasks) {
      loadCache().tasks = tasks ?? [];
      flush();
    },
    getSeries() {
      const document = loadCache();
      if (!Array.isArray(document.series)) document.series = [];
      return document.series;
    },
    saveSeries(list) {
      loadCache().series = list ?? [];
      flush();
    },
    getPlayback() {
      const document = loadCache();
      if (!document.playback || typeof document.playback !== 'object') document.playback = {};
      return document.playback;
    },
    savePlayback(map) {
      loadCache().playback = map ?? {};
      flush();
    },
    getMergeTasks() {
      const document = loadCache();
      if (!Array.isArray(document.mergeTasks)) document.mergeTasks = [];
      return document.mergeTasks;
    },
    saveMergeTasks(list) {
      loadCache().mergeTasks = list ?? [];
      flush();
    },
  };
}

/** 全局单例：主进程启动时 init(路径)，其余模块直接调用。 */
const store = createStore();

export default store;
