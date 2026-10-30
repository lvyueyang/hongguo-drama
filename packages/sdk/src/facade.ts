/**
 * SDK 门面：统一入口，宿主（桌面端 / CLI / 脚本）只用这里的方法。
 *
 * 设计约定（见 docs/refactor-plan.md）：
 * - 不依赖 electron：宿主能力通过 HostServices 或本文件的 config 注入；
 * - 业务性失败不抛异常，可选 `throwOnError` 让调用方用 try/catch；
 * - 游标不透明；超时用 timeoutMs/AbortSignal。
 *
 * 现状：`suggest` 与 `capabilities` 是重构后新写的实现；其余域先把 4.5 的
 * 成熟实现按域挂出来（`meta.migrated = true`），签名与返回结构在后续里程碑收紧。
 */
import { attempt, ErrorCodes, type Result, SdkError } from '@hongguo/shared';
import customProvider from './providers/custom/index.ts';
import hemaProvider from './providers/hema/index.ts';
import { browseList as browseAppCatalog } from './providers/hongguo-app/catalog.ts';
import { searchApp } from './providers/hongguo-app/search.ts';
import { createAccountService } from './providers/hongguo-passport/account.ts';
import { browseList as browseWebCatalog, setNetTransport } from './providers/hongguo-web/catalog.ts';
import { fetchPublicDetails } from './providers/hongguo-web/details.ts';
import {
  decryptMp4Buffer,
  decryptMp4File,
  deriveKey,
  fetchEpisodeList,
  fetchPlayUrlFromWeb,
  fetchPlayUrlSingle,
  resolveSeriesId,
} from './providers/hongguo-web/player.ts';
import { searchHongguo } from './providers/hongguo-web/search.ts';
import {
  type SuggestItem,
  type SuggestOptions,
  suggestSuggestions,
} from './providers/hongguo-web/suggest.ts';
import xifanProvider from './providers/xifan/index.ts';
import danmakuApi from './services/danmaku/index.ts';
import { exportSeriesText } from './services/export/text-export.ts';
import { listHistory } from './services/history/watch-history.ts';
import { remuxHls } from './services/media/hls.ts';
import { buildMergePlan, readMergeInfo } from './services/media/merge-plan.ts';
import { meetsDownloadQuality, normalizeDownloadQuality } from './services/media/quality.ts';
import { findSeriesSequels, searchSeries } from './services/search/series-search.ts';
import { getMediaSources, setBuiltinSourceEnabled } from './services/sources/media-sources.ts';
import {
  applyPortableDataDir,
  DATA_FILES,
  PORTABLE_MARKER,
  resolvePortableDataDir,
} from './services/storage/portable-data.ts';
import store from './services/storage/store.ts';

export interface SdkLogger {
  warn(message: string, detail?: unknown): void;
  info?(message: string, detail?: unknown): void;
}

export interface SdkConfig {
  logger?: SdkLogger;
  /** 默认请求超时；各方法可单独覆盖 */
  timeoutMs?: number;
  /**
   * 身份来源。当前只支持匿名设备身份；账号登录不参与取流，先留扩展位。
   */
  identity?: { kind: 'anonymous-device' } | { kind: 'account' };
  /** 账号服务所需的加密存储与网页请求（由宿主注入，SDK 不碰 Electron/系统钥匙串） */
  account?: {
    filePath: string;
    safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    };
  };
}

/** 账号服务的最小对外形状（迁移实现） */
export interface SdkAccountService {
  status(): Promise<unknown>;
  startLogin(): Promise<unknown>;
  pollLogin(loginId: string): Promise<unknown>;
  cancelLogin(loginId: string): unknown;
  logout(): Promise<unknown>;
  history(options?: { refresh?: boolean }): Promise<unknown>;
  row(seriesId: string): unknown;
}

export interface SdkCapabilities {
  /** 匿名设备身份即可取流 */
  canPlayAnonymous: boolean;
  /** 登录态当前是否影响取流：未验证，按事实标 false */
  accountAffectsPlayback: boolean;
  /** 登录态可读取云端观看记录 */
  accountCloudHistory: boolean;
  suggestEndpoint: string;
}

export interface Sdk {
  /** 搜索联想（红果官网 /api/search/suggestion），新实现 */
  suggest(keyword: string, options?: SuggestOptions): Promise<SuggestItem[]>;
  capabilities(): SdkCapabilities;
  /** 以下为按域挂出的迁移实现 */
  search: {
    web(keyword: string, options?: unknown): Promise<unknown>;
    bySource(
      keyword: unknown,
      options?: { source?: string; page?: number; deadline?: number },
    ): Promise<unknown>;
    app(keyword: string, options?: unknown): Promise<unknown>;
    series(keyword: string, search: unknown, known?: unknown[], options?: unknown): Promise<unknown>;
    sequels(entry: unknown, registry: unknown[], search: unknown, options?: unknown): Promise<unknown>;
  };
  catalog: {
    app(options?: any): Promise<unknown>;
    browse(options: {
      source?: string;
      category?: string;
      genre?: string;
      page?: number;
      cursor?: string | null;
      channel?: 'app' | 'web';
      allowTrustedDns?: boolean;
      proxyLogin?: unknown;
    }): Promise<unknown>;
    web(options?: any, proxyLogin?: unknown): Promise<unknown>;
    sources(): unknown;
    setSourceEnabled(id: string, enabled: boolean): unknown;
  };
  series: {
    resolve(input: unknown): Promise<unknown>;
    episodes(seriesId: string, options?: unknown): Promise<unknown>;
    details(seriesId: string, vid?: string, options?: unknown): Promise<unknown>;
  };
  playback: {
    sources(vid: string, sid?: string, options?: unknown): Promise<unknown>;
    fromWeb(vid: string, sid?: string, onFailure?: unknown): Promise<unknown>;
    deriveKey(spadeA: string): unknown;
    decryptBuffer(buffer: Buffer, key: unknown): unknown;
    decryptFile(src: string, dst: string, key: unknown): void;
  };
  danmaku: { fetch(options?: unknown): Promise<unknown> };
  exportText: { series(input: unknown): Promise<unknown> };
  history: { list(registry: unknown[], playback: unknown, sequelsEnabled?: boolean): unknown };
  media: {
    normalizeQuality(value: unknown): ReturnType<typeof normalizeDownloadQuality>;
    meetsQuality(variant: unknown, quality: unknown): boolean;
    readInfo(info: unknown): unknown;
    planMerge(infos: unknown, options?: unknown): unknown;
    remuxHls(options: unknown): Promise<unknown>;
  };
  account: { create(options: unknown): SdkAccountService };
  storage: typeof store;
}

const DEFAULT_SUGGEST_TIMEOUT = 6000;

export function createSdk(config: SdkConfig = {}): Sdk {
  const logger = config.logger;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_SUGGEST_TIMEOUT;

  return {
    async suggest(keyword, options = {}) {
      const started = Date.now();
      const items = await suggestSuggestions(keyword, {
        ...options,
        timeoutMs: options.timeoutMs ?? timeoutMs,
      });
      logger?.info?.(`suggest ${items.length} 条 ${Date.now() - started}ms`);
      return items;
    },

    capabilities() {
      return {
        canPlayAnonymous: true,
        // 事实核对结论：取流请求不带 Cookie，仍以 user_is_login=0 发出。
        // 登录态是否影响清晰度/可用范围未验证，这里如实标 false。
        accountAffectsPlayback: false,
        accountCloudHistory: true,
        suggestEndpoint: 'https://hongguoduanju.com/api/search/suggestion/?query=',
      };
    },

    search: {
      web: (keyword, options) => searchHongguo(keyword as string, (options ?? {}) as any),
      /**
       * 按来源搜索。各来源共用同一个总预算（deadline），
       * 否则慢来源会把整次搜索拖到超时（4.5 `check-search-deadline` 守的就是这条）。
       */
      async bySource(keyword: unknown, options: { source?: string; page?: number; deadline?: number } = {}) {
        const source = String(options.source ?? 'hongguo');
        const page = Number(options.page) >= 1 ? Number(options.page) : 1;
        const deadline = Number(options.deadline) > 0 ? Number(options.deadline) : 0;
        const kw = String(keyword ?? '').trim();
        if (!kw || kw.length > 200) {
          throw new SdkError(ErrorCodes.INPUT_INVALID, '请输入 1 至 200 字的搜索词');
        }
        if (source === 'hema') return hemaProvider.search(kw, page, { deadline });
        if (source === 'xifan') return xifanProvider.search(kw, page, { deadline });
        if (source.startsWith('custom:')) return customProvider.searchSeries(kw, { source, page });
        if (source !== 'hongguo') {
          throw new SdkError(ErrorCodes.SOURCE_DISABLED, '不支持的搜索来源');
        }
        return searchHongguo(kw, { page, ...(deadline ? { deadline } : {}) } as never);
      },
      app: (keyword, options) => searchApp(keyword as string, (options ?? {}) as any),
      series: (keyword, search, known, options) =>
        searchSeries(keyword as string, search as any, (known ?? []) as any, (options ?? {}) as any),
      sequels: (entry, registry, search, options) =>
        findSeriesSequels(entry as any, registry as any, search as any, (options ?? {}) as any),
    },

    catalog: {
      app: (options) => browseAppCatalog((options ?? {}) as any),
      /** 按来源分流：红果默认 App 目录（可显式切官网线路），西饭/河马/自定义各自实现。 */
      async browse(options: {
        source?: string;
        category?: string;
        genre?: string;
        page?: number;
        cursor?: string | null;
        channel?: 'app' | 'web';
        allowTrustedDns?: boolean;
        proxyLogin?: unknown;
      }) {
        const source = String(options?.source ?? 'hongguo');
        const base = {
          category: options?.category,
          genre: options?.genre,
          page: options?.page ?? 1,
          cursor: options?.cursor ?? null,
        };
        if (source === 'hema') return hemaProvider.browseList(base);
        if (source === 'xifan') return xifanProvider.browseList(base);
        if (source.startsWith('custom:')) return customProvider.browseList(base);
        if (source !== 'hongguo') {
          throw new SdkError(ErrorCodes.SOURCE_DISABLED, '不支持的目录来源');
        }
        if (options?.channel === 'web') {
          return browseWebCatalog(
            { ...base, allowTrustedDns: options.allowTrustedDns === true },
            options.proxyLogin,
          );
        }
        return browseAppCatalog(base);
      },
      web: (options, proxyLogin) => browseWebCatalog((options ?? {}) as any, proxyLogin as any),
      sources: () => getMediaSources(store.getSettings()),
      setSourceEnabled: (id, enabled) => setBuiltinSourceEnabled(store.getSettings(), id, enabled),
    },

    series: {
      resolve: (input) => resolveSeriesId(input),
      episodes: (seriesId, options) => fetchEpisodeList(seriesId, (options ?? {}) as any),
      details: (seriesId, vid, options) =>
        fetchPublicDetails(seriesId as string, (vid ?? '') as string, (options ?? {}) as any),
    },

    playback: {
      sources: (vid, sid, options) => fetchPlayUrlSingle(vid, sid as any, (options ?? {}) as any),
      fromWeb: (vid, sid, onFailure) => fetchPlayUrlFromWeb(vid, sid as any, onFailure as any),
      deriveKey: (spadeA) => deriveKey(spadeA),
      decryptBuffer: (buffer, key) => decryptMp4Buffer(buffer, key as any),
      decryptFile: (src, dst, key) => decryptMp4File(src, dst, key as any),
    },

    danmaku: { fetch: (options) => danmakuApi.fetchDanmaku((options ?? {}) as any) },
    exportText: { series: (input) => exportSeriesText(input as any) },
    history: {
      list: (registry, playback, sequelsEnabled) => listHistory(registry, playback, sequelsEnabled),
    },

    media: {
      normalizeQuality: normalizeDownloadQuality,
      meetsQuality: (variant, quality) =>
        meetsDownloadQuality(variant as any, normalizeDownloadQuality(quality as any)),
      readInfo: (info) => readMergeInfo(info as any),
      planMerge: (infos, options) => buildMergePlan(infos as any, (options ?? {}) as any),
      remuxHls: (options) => remuxHls(options as any),
    },

    account: {
      create(options) {
        if (!config.account) {
          throw new SdkError(ErrorCodes.ACCOUNT_REQUIRED, '账号服务需要宿主注入加密存储');
        }
        return createAccountService({ ...config.account, ...(options as object) } as any);
      },
    },

    storage: store,
  };
}

export type { Result, SuggestItem };
export {
  applyPortableDataDir,
  attempt,
  DATA_FILES,
  ErrorCodes,
  PORTABLE_MARKER,
  resolvePortableDataDir,
  SdkError,
  setNetTransport,
};
