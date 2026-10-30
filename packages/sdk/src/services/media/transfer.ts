// SPDX-License-Identifier: MIT
/**
 * 媒体传输：请求片源、判定可恢复错误、按候选逐个重试。
 *
 * 迁移自 4.5 `main.js` 的 `requestMedia` / `withMediaRecovery` / `awaitMediaOperation`，
 * 行为一条没减（这些行为都是踩出来的）：
 * - 官网/自定义源走带 DNS 与重定向守卫的 agent，不是裸 axios；
 * - 官网 404/410 与 5xx 会翻一次 Referer 再试（App 片源对 Referer 敏感）；
 * - 返回 HTML/JSON 错误页必须当传输失败，不能当作视频存下来；
 * - 服务端擅自给 206 且不是「整段」时拒绝，避免把半截文件当完整片源；
 * - 失败候选会标记官网优先降级，下一次取源不再先试官网。
 */
import type { Readable } from 'node:stream';
import axios from 'axios';
import { webMediaRequestOptions } from '../../internal/net/guard.ts';
import customProvider from '../../providers/custom/index.ts';
import {
  fetchPlayUrlSingle,
  markWebMediaFailure,
  UA,
  WEB_REFERER,
  WEB_UA,
} from '../../providers/hongguo-web/player.ts';
import { normalizeDownloadQuality } from './quality.ts';

export interface PlayInfoSource {
  source?: string;
  code?: string;
  message?: string;
}

/** 一次取源结果。字段与 4.5 的 playInfo 一致，缺省很多，调用方按需读。 */
export interface PlayInfo {
  url?: string | null;
  source?: string;
  vid?: string;
  codec?: string | null;
  /** CENC：32 位十六进制密钥，用 FFmpeg 解密 */
  contentKey?: string | null;
  /** 平台自有加密：spade_a，用派生密钥在 worker 里解密 */
  spadeA?: string | null;
  format?: string;
  width?: number;
  height?: number;
  quality?: string;
  variants?: PlayInfo[];
  candidates?: PlayInfo[];
  userAgent?: string;
  referer?: string;
  error?: string;
  code?: string;
  locked?: boolean;
  sources?: PlayInfoSource[];
}

export type MediaOpener = (
  vid: string,
  seriesId?: string,
  options?: { quality?: string; allowLowerQuality?: boolean; force?: boolean; signal?: AbortSignal },
) => Promise<PlayInfo | null>;

/** 默认取源：与 4.5 同一条链路（官网 → App → 旧接口）。 */
export const defaultOpen: MediaOpener = async (vid, seriesId, options = {}) =>
  (await fetchPlayUrlSingle(vid, seriesId, options)) as PlayInfo | null;

export type MediaStream = Readable & { destroy(error?: Error): void };

export interface MediaResponse {
  status: number;
  headers: Record<string, any>;
  data: MediaStream;
}

export interface RequestMediaOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 允许的状态码；默认 200/206/416（416 由调用方转换成分段错误） */
  acceptStatus?: number[];
}

export function mediaTransferError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'MEDIA_TRANSFER_ERROR',
    mediaRetryable: true,
  });
}

export function canceledError(message = '已取消媒体请求'): Error {
  return Object.assign(new Error(message), { code: 'CANCELED' });
}

/** 自定义源随时可能被停用：每次用之前重新确认，避免已缓存的会话继续生效。 */
export function assertSourceEnabled(value: unknown): void {
  const vid = String(value ?? '');
  if (!vid.startsWith('custom:')) return;
  customProvider.assertEnabled(vid);
}

function destroyBody(response: any): void {
  try {
    response?.data?.destroy?.();
  } catch {
    /* 已经结束 */
  }
}

function applyRefererTweak(headers: Record<string, string>, playInfo: PlayInfo, web: boolean): void {
  if (web) return;
  if (!['app', 'api'].includes(String(playInfo.source ?? ''))) return;
  if (headers.Referer && headers.Referer !== WEB_REFERER) delete headers.Referer;
  else headers.Referer = 'https://novelquickapp.com/';
}

/**
 * 请求片源字节流。
 *
 * 返回 416 也算「请求成功」：Range 越界是播放器的正常行为（拖动到末尾），
 * 由调用方当成 416 响应交回去，而不是抛错重试。
 */
export async function requestMedia(
  playInfo: PlayInfo,
  options: RequestMediaOptions = {},
): Promise<MediaResponse> {
  if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
  let url: URL;
  try {
    url = new URL(playInfo.url);
  } catch {
    throw Object.assign(new Error('无效播放地址'), { code: 'SECURITY_BLOCKED' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('无效播放地址'), { code: 'SECURITY_BLOCKED' });
  }
  assertSourceEnabled(playInfo.vid ?? '');
  const web = playInfo.source === 'web';
  const custom = playInfo.source === 'custom';
  const headers: Record<string, string> = {
    'User-Agent': playInfo.userAgent || (web ? WEB_UA : UA),
    'Accept-Encoding': 'identity',
    ...(playInfo.referer || web ? { Referer: playInfo.referer || WEB_REFERER } : {}),
    ...options.headers,
  };
  const config: Record<string, any> = {
    method: options.method ?? 'GET',
    url: url.href,
    responseType: 'stream',
    timeout: options.timeoutMs ?? 60_000,
    signal: options.signal,
    headers,
    maxRedirects: 5,
    // 状态码自己在下面判断：需要拿 404/403 的具体数字决定「换个候选」还是「就此失败」。
    validateStatus: () => true,
  };
  if (web || custom) Object.assign(config, webMediaRequestOptions(url.href));
  const accept = options.acceptStatus ?? [200, 206, 416];

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: any;
    try {
      response = await axios(config);
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      const causeCode = String((error as { cause?: { code?: unknown } })?.cause?.code ?? '');
      if (code === 'ERR_WEB_MEDIA_ADDRESS' || causeCode === 'ERR_WEB_MEDIA_ADDRESS') {
        markWebMediaFailure(playInfo);
        throw Object.assign(mediaTransferError('官网片源地址不安全，正在尝试其他片源'), {
          code: 'ERR_WEB_MEDIA_ADDRESS',
        });
      }
      if (options.signal?.aborted || code === 'ERR_CANCELED') throw canceledError();
      const transient = [
        'ECONNRESET',
        'ECONNABORTED',
        'ETIMEDOUT',
        'EPIPE',
        'EAI_AGAIN',
        'ERR_BAD_RESPONSE',
        'ERR_STREAM_PREMATURE_CLOSE',
      ].includes(code);
      lastError = transient ? Object.assign(error as Error, { mediaRetryable: true }) : error;
      if (attempt === 0 && transient) {
        applyRefererTweak(headers, playInfo, web);
        continue;
      }
      throw lastError;
    }

    const status = Number(response.status);
    const retryableStatus = web
      ? [404, 410].includes(status) || (status >= 500 && status <= 599)
      : status === 403;
    if (!accept.includes(status)) {
      const retryable = [403, 404, 408, 410].includes(status) || (status >= 500 && status <= 599);
      if (attempt === 0 && retryableStatus) {
        destroyBody(response);
        applyRefererTweak(headers, playInfo, web);
        continue;
      }
      destroyBody(response);
      throw Object.assign(new Error(`片源请求失败（HTTP ${status}），请重新连接片源`), {
        mediaStatus: status,
        mediaRetryable: retryable,
      });
    }

    const contentType = String(response.headers?.['content-type'] ?? '');
    if ([200, 206].includes(status) && /(?:text\/html|application\/json)/i.test(contentType)) {
      destroyBody(response);
      throw mediaTransferError('片源返回了错误页面，请重新获取片源');
    }
    if ((options.method ?? 'GET') === 'GET' && !headers.Range && status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/.exec(String(response.headers?.['content-range'] ?? ''));
      if (!range || Number(range[1]) + 1 !== Number(range[2])) {
        destroyBody(response);
        throw mediaTransferError('视频响应不完整，请重新获取片源');
      }
      response.headers['content-length'] = range[2];
      response.headers['content-range'] = undefined;
    }
    return { status, headers: response.headers ?? {}, data: response.data };
  }
  throw lastError ?? mediaTransferError('片源请求失败，请重新连接片源');
}

/** 给任意 promise 套一层「可取消 + 截止时间」，共享的取源任务不会因此中断。 */
export function awaitMediaOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs = 0,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (settle: (value: any) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    const abort = () => finish(reject, canceledError());
    if (timeoutMs) {
      timer = setTimeout(() => finish(reject, mediaTransferError('获取片源超时，请稍后重试')), timeoutMs);
      timer.unref?.();
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

/** 片源不可用是否属于「过一会儿可能好」：安全拦截与空响应都不算。 */
export function sourceFailureIsTransient(error: any): boolean {
  const sources: PlayInfoSource[] = Array.isArray(error?.sources) ? error.sources : [];
  return sources.some(
    (item) =>
      (item.source === 'web' && /^HTTP_(?:404|410)$/.test(String(item.code))) ||
      /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(String(item.code)),
  );
}

export interface RecoverOptions {
  playInfo?: PlayInfo | null;
  quality?: string;
  allowLowerQuality?: boolean;
  force?: boolean;
  signal?: AbortSignal;
  /** false = 只试当前地址（播放流已经交给播放器后不能再换片源） */
  recover?: boolean;
  open?: MediaOpener;
  /** 轮次上限；默认按 4.5 的规则：红果数字 vid 三轮，其它来源一轮 */
  rounds?: number;
}

const RETRYABLE_CODES = [
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_BAD_RESPONSE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'EAI_AGAIN',
];

function isRecoverable(error: any): boolean {
  if (!error) return false;
  if (error.code === 'SOURCE_UNAVAILABLE') return sourceFailureIsTransient(error);
  if (String(error.code ?? '') === 'CANCELED' || String(error.code ?? '') === 'ERR_CANCELED') return false;
  return (
    Boolean(error.mediaRetryable) ||
    error.code === 'MEDIA_DECODE_ERROR' ||
    RETRYABLE_CODES.includes(String(error.code ?? ''))
  );
}

/**
 * 一次「取源 + 消费」的重试外壳。
 *
 * 重试的是**整个操作**，不是剩下的字节：断在中间的 body 绝不能算成功，
 * 也不能接着上次的偏移继续写，否则成品是一个前半段来自 A、后半段来自 B 的文件。
 */
export async function withMediaRecovery<T>(
  vid: string,
  seriesId: string | undefined,
  options: RecoverOptions,
  consume: (candidate: PlayInfo) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const outerSignal = options.signal;
  const abort = () => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  outerSignal?.addEventListener('abort', abort, { once: true });
  const open = options.open ?? defaultOpen;
  const cancelled = () => {
    if (outerSignal?.aborted || controller.signal.aborted) throw canceledError();
  };
  const rounds = options.rounds ?? (options.recover !== false && /^\d{1,30}$/.test(String(vid)) ? 3 : 1);
  let lastError: any;
  let decodeFailure: any;
  let transfers = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      cancelled();
      if (round)
        await awaitMediaOperation(
          new Promise((resolve) => setTimeout(resolve, round * 500)),
          controller.signal,
        );
      cancelled();
      let info: PlayInfo | null | undefined;
      try {
        info =
          (!round && options.playInfo) ||
          (await awaitMediaOperation(
            open(vid, seriesId, {
              quality: options.quality,
              allowLowerQuality: options.allowLowerQuality,
              force: options.force || round > 0,
            }),
            controller.signal,
            30_000,
          ));
      } catch (error) {
        cancelled();
        if (!isRecoverable(error)) throw error;
        lastError = error;
        continue;
      }
      cancelled();
      if (!info?.url) {
        lastError = Object.assign(new Error(info?.error || '未获取到有效播放地址'), {
          code: (info as any)?.code,
          sources: (info as any)?.sources,
        });
        if (!isRecoverable(lastError) || (info as any)?.locked) throw lastError;
        continue;
      }
      const seen = new Set<string>();
      const candidates = [
        info,
        ...(options.recover === false ? [] : (info.variants ?? info.candidates ?? [])),
      ];
      for (const candidate of candidates) {
        const identity = JSON.stringify([
          candidate?.url,
          candidate?.contentKey,
          candidate?.spadeA,
          candidate?.userAgent,
          candidate?.referer,
        ]);
        if (!candidate?.url || seen.has(identity)) continue;
        seen.add(identity);
        cancelled();
        transfers += 1;
        try {
          const value = await consume(candidate);
          cancelled();
          return value;
        } catch (error) {
          cancelled();
          // 本地存储/安全失败换更低的清晰度也修不好：直接失败，别浪费流量。
          const code = String((error as any)?.code ?? '');
          const terminal =
            Boolean((error as any)?.path) ||
            Boolean((error as any)?.dest) ||
            /^(?:EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EIO|ENOENT|EEXIST|ENOTDIR|EISDIR|EMFILE|ENFILE|EBUSY|ENAMETOOLONG|EMLINK|EFBIG|LOCAL_MEDIA_TOOL_ERROR|SECURITY_BLOCKED|ERR_WEB_MEDIA_ADDRESS)$/.test(
              code,
            );
          if (
            (options.allowLowerQuality && terminal) ||
            (!isRecoverable(error) && !options.allowLowerQuality)
          ) {
            throw error;
          }
          lastError = error;
          // 官网 body 坏了要改来源优先级：先重新取源（可能换到 App），而不是直接报错。
          if (code === 'MEDIA_DECODE_ERROR' && candidate.source !== 'web') decodeFailure = error;
          markWebMediaFailure(candidate);
          if (transfers >= 4 && !options.allowLowerQuality) throw lastError;
        }
      }
      if (decodeFailure) throw decodeFailure;
    }
    throw lastError ?? mediaTransferError('片源请求失败，请重新连接片源');
  } finally {
    outerSignal?.removeEventListener('abort', abort);
  }
}

/** 播放/下载共用：把 Range 头解析成字节区间；非法返回 false，无 Range 返回 null。 */
export function mediaRange(
  range: string | null | undefined,
  size: number,
): { start: number; end: number } | null | false {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return false;
  return { start, end };
}

/** 质量档位归一（下载校验与取源都要用同一条规则）。 */
export { normalizeDownloadQuality };

export interface ConsumeOptions {
  signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
  /** 硬上限：超了立即断开（在线播放的大集保护） */
  maxBytes?: number;
}

function totalOf(headers: Record<string, any>): number {
  const value = Number(headers?.['content-length']);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 把 body 写进文件，并校验「一个字节都没少」。
 *
 * 半截文件绝不能算成功：CDN 断流时 `pipeline` 会 reject，但「服务端少发了尾部
 * 且没有 advertised长度」只能靠字节数比对发现，所以两道都要有。
 */
export async function pipeToFile(
  response: MediaResponse,
  file: string,
  options: ConsumeOptions = {},
): Promise<number> {
  const { signal } = options;
  const total = totalOf(response.headers);
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  let received = 0;
  let lastProgress = 0;
  response.data.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (options.maxBytes && received > options.maxBytes) {
      response.data.destroy(Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' }));
      return;
    }
    if (options.onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
      options.onProgress(received, total);
      lastProgress = Date.now();
    }
  });
  try {
    await pipeline(response.data, createWriteStream(file, { mode: 0o600 }), { signal });
  } catch (error) {
    // pipeline 把「上游突然断开」报成 ERR_STREAM_PREMATURE_CLOSE / aborted；
    // 这些码散到上层会被当成不可重试的失败，所以统一收敛成可重试的「不完整」。
    if (signal?.aborted) throw canceledError();
    throw mediaTransferError('视频下载不完整，请重试', error);
  }
  if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
  return received;
}

/** 把 body 收进内存（解密前的整集就这一份）；超限立即放弃，不要一点点把内存吃满。 */
export async function readToBuffer(response: MediaResponse, options: ConsumeOptions = {}): Promise<Buffer> {
  const { signal } = options;
  const total = totalOf(response.headers);
  const chunks: Buffer[] = [];
  let received = 0;
  let lastProgress = 0;
  try {
    for await (const chunk of response.data) {
      if (signal?.aborted) throw canceledError();
      received += chunk.length;
      if (received > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        response.data.destroy();
        throw Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (options.onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
        options.onProgress(received, total);
        lastProgress = Date.now();
      }
    }
  } catch (error) {
    // 与 pipeToFile 同理：断流要收敛成可重试的错误，而不是把底层码漏出去。
    if (signal?.aborted) throw canceledError();
    if ((error as { code?: string }).code) throw error;
    throw mediaTransferError('视频下载不完整，请重试', error);
  }
  if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
  return Buffer.concat(chunks);
}
