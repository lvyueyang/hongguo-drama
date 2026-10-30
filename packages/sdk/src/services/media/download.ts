// SPDX-License-Identifier: MIT
/**
 * 单集下载：取源 → 传输 → 解密 → 校验 → 原子发布。
 *
 * 迁移自 4.5 `main.js` 的 `executeHongguoDownload`。这里保留的每一条都是踩出来的：
 * - **校验在前，发布在后**：先把整集落到 `.enc.tmp`，探测分辨率/时长（必要时解码前 3 秒），
 *   通过了才用硬链接/独占复制发布成正式文件名 —— 半截文件永远不会以成品的样子存在；
 * - **清晰度不静默降级**：只下载到更低清晰度时要在进度里说清楚，不做无声妥协；
 * - **本地错误不重试换清晰度**：磁盘满、权限、安全拦截跟片源无关，换更低的清晰度也救不回来；
 * - **取消是终态**：取消后连临时文件都不留，重试不能把已取消的任务又拉起来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveKey } from '../../providers/hongguo-web/player.ts';
import { decryptContentKeyFile, decryptFileInWorker } from './decrypt.ts';
import { remuxHls } from './hls.ts';
import { meetsDownloadQuality, normalizeDownloadQuality, qualityPixels } from './quality.ts';
import { type MediaTools, probeMedia, publishFile } from './tools.ts';
import {
  assertSourceEnabled,
  canceledError,
  defaultOpen,
  type MediaOpener,
  mediaTransferError,
  type PlayInfo,
  pipeToFile,
  requestMedia,
  withMediaRecovery,
} from './transfer.ts';

export type { MediaOpener, PlayInfo };
export { defaultOpen };

export interface DownloadEpisodeHost {
  temporaryDir(): string;
  logger?(): { warn(message: string, detail?: unknown): void };
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  phase?: 'downloading' | 'decrypting' | 'verifying';
  /** 正在下载更低清晰度片源时的说明；空串表示没有 */
  qualityNotice?: string;
}

export interface DownloadEpisodeRequest {
  /** 分集编号（含 hema:/xifan:/custom: 前缀）；缺省时回退到 playInfo.vid */
  vid?: string;
  seriesId?: string;
  /** 已取到的片源信息；缺省时用 open 现取 */
  playInfo?: PlayInfo | null;
  outputPath: string;
  quality?: string;
  allowLowerQuality?: boolean;
  tools: MediaTools;
  host: DownloadEpisodeHost;
  decryptWorkerPath?: string;
  signal?: AbortSignal;
  onProgress?(progress: DownloadProgress): void;
  open?: MediaOpener;
  /** false = 只试当前地址（不换候选、不重新取源） */
  recover?: boolean;
  /** 单集字节上限；缺省不限制 */
  maxBytes?: number;
}

export interface DownloadEpisodeResult {
  actualQuality: string;
  qualityNotice: string;
  bytes: number;
}

export interface VerifyDownloadedRequest {
  path: string;
  quality?: string;
  tools: MediaTools;
  signal?: AbortSignal;
}

export interface VerifyDownloadedResult {
  actualQuality: string;
  /** ffprobe 读到的完整信息（调用方可能还要用分辨率/时长） */
  info: ReturnType<typeof normalizeInfo>;
}

function normalizeInfo(info: any): { w: number; h: number; duration: number; codec: string } {
  return {
    w: Number(info?.w) || 0,
    h: Number(info?.h) || 0,
    duration: Number(info?.duration) || 0,
    codec: String(info?.codec ?? ''),
  };
}

function pixelsOf(info: { w: number; h: number }): number {
  return Math.min(info.w, info.h);
}

interface VerifyOptions {
  file: string;
  quality: string;
  /** true = 复核磁盘上已有的文件（提示文案不同，且不删文件） */
  existing: boolean;
  tools: MediaTools;
  signal?: AbortSignal;
  verifyDecode?: boolean;
}

/** 分辨率/时长/解码三重校验，返回实际清晰度（如 '720p'）。 */
async function verifyMediaFile(
  options: VerifyOptions,
): Promise<{ actualQuality: string; info: ReturnType<typeof normalizeInfo> }> {
  const { file, tools, signal, existing } = options;
  const quality = normalizeDownloadQuality(options.quality);
  // 空文件不要浪费一次 ffprobe：直接按「没有有效视频轨」处理。
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new Error(existing ? '已有本地文件不存在或无法读取' : '片源文件不存在或无法读取');
  }
  if (!size) {
    throw new Error(
      `${existing ? '已有本地文件' : '片源文件'}为空，未完成下载${existing ? '；文件已保留，请先自行检查或移除' : ''}`,
    );
  }
  const probed = await probeMedia({ tools, file, signal, rejectToolErrors: true });
  const info = normalizeInfo(probed);
  const prefix = existing ? '已有本地文件' : '片源文件';
  if (!info.w || !info.h || !(info.duration > 0)) {
    throw new Error(
      `${prefix}缺少有效视频轨、分辨率或时长，未完成下载${existing ? '；文件已保留，请先自行检查或移除' : ''}`,
    );
  }
  if (!meetsDownloadQuality({ width: info.w, height: info.h }, quality)) {
    throw new Error(
      `${prefix}实际为 ${pixelsOf(info)}P（${info.w}×${info.h}），不满足 ${quality.toUpperCase()}${
        existing ? '；文件已保留，如需重新下载请先自行移除本地文件' : '，未自动降级'
      }`,
    );
  }
  if (options.verifyDecode) await verifyDecode(file, tools, signal);
  return { actualQuality: `${pixelsOf(info)}p`, info };
}

/** 解码校验：只解前 3 秒，坏文件在这里会失败（元数据可能完好、样本数据是坏的）。 */
async function verifyDecode(file: string, tools: MediaTools, signal?: AbortSignal): Promise<void> {
  if (!tools.ffmpeg) {
    throw Object.assign(new Error('视频解码校验工具不可用，请修复安装后重试'), {
      code: 'LOCAL_MEDIA_TOOL_ERROR',
    });
  }
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      tools.ffmpeg as string,
      ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-t', '3', '-f', 'null', '-'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(canceledError('已取消视频解码校验'));
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(
        Object.assign(new Error('视频解码校验工具超时或无法运行'), {
          code: 'LOCAL_MEDIA_TOOL_ERROR',
        }),
      );
    }, 30_000);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const code = String(error.code ?? '');
      finish(
        ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(code)
          ? Object.assign(new Error('视频解码校验工具不可用，请修复安装后重试'), {
              code: 'LOCAL_MEDIA_TOOL_ERROR',
            })
          : Object.assign(new Error('视频解码校验工具无法运行'), {
              code: 'LOCAL_MEDIA_TOOL_ERROR',
            }),
      );
    });
    child.once('close', (code) => {
      if (settled) return;
      if (stderr.trim() || code !== 0) {
        finish(
          Object.assign(new Error('视频解码校验失败，文件可能损坏，请重新下载'), {
            code: 'MEDIA_DECODE_ERROR',
          }),
        );
        return;
      }
      finish();
    });
  });
}

/** 复核磁盘上已有的成品：只读，永不删除或改写用户文件。 */
export async function verifyDownloadedFile(
  request: VerifyDownloadedRequest,
): Promise<VerifyDownloadedResult> {
  return verifyMediaFile({
    file: request.path,
    quality: normalizeDownloadQuality(request.quality),
    existing: true,
    tools: request.tools,
    signal: request.signal,
  });
}

function lowQualityNotice(pixels: number, quality: string): string {
  if (!pixels || quality === 'auto') return '';
  const target = qualityPixels(quality);
  if (!target || pixels >= target) return '';
  return `正在下载更低质量片源：${pixels}P（原选 ${quality.toUpperCase()}）`;
}

export async function downloadEpisode(request: DownloadEpisodeRequest): Promise<DownloadEpisodeResult> {
  const { outputPath, tools, host, signal } = request;
  const quality = normalizeDownloadQuality(request.quality);
  const allowLowerQuality = request.allowLowerQuality === true && quality !== 'auto';
  const announce = (progress: Partial<DownloadProgress>) =>
    request.onProgress?.({
      receivedBytes: progress.receivedBytes ?? 0,
      totalBytes: progress.totalBytes ?? 0,
      percent: progress.percent ?? 0,
      ...(progress.phase ? { phase: progress.phase } : {}),
      ...(progress.qualityNotice !== undefined ? { qualityNotice: progress.qualityNotice } : {}),
    });

  let notice = '';
  const notifyQuality = (pixels: number) => {
    const next = lowQualityNotice(pixels, allowLowerQuality ? quality : 'auto');
    if (next === notice) return;
    notice = next;
    announce({ qualityNotice: notice });
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const temporaryPath = `${outputPath}.enc.tmp`;
  const decodedPath = `${temporaryPath}.decoded`;
  // vid 必须由调用方给出：hema/xifan 的取源结果里根本没有 vid 字段，
  // 只从 playInfo 取会让自定义源的「来源是否仍启用」校验与重试全部失准。
  const videoId = String(request.vid ?? request.playInfo?.vid ?? '');
  const seriesId =
    request.seriesId ?? (request.playInfo as { seriesId?: string } | null | undefined)?.seriesId;

  // 先复核「这个来源还能不能用」，再看有没有现成文件。
  // 4.5 就是这个顺序：自定义源被停用后，排队中的任务必须失败，不能因为一份旧文件
  // 「刚好存在」就报成功——否则用户停用来源后仍然会看到它下载成功。
  assertSourceEnabled(videoId);

  // 已存在成品：可用就直接算完成（不去覆盖用户文件），不可用则如实失败。
  if (fs.existsSync(outputPath)) {
    const existing = await verifyDownloadedFile({
      path: outputPath,
      quality,
      tools,
      signal,
    });
    return { actualQuality: existing.actualQuality, qualityNotice: '已存在可用文件，跳过下载', bytes: 0 };
  }

  const cleanup = () => {
    for (const file of [temporaryPath, decodedPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 没建出来 */
      }
    }
  };

  const verifyDownloaded = async (file: string): Promise<string> => {
    announce({ phase: 'verifying' });
    const result = await verifyMediaFile({
      file,
      // 允许降级时只要求「有画面」，具体清晰度后续单独汇报；不允许降级就必须达标。
      quality: allowLowerQuality ? 'auto' : quality,
      existing: false,
      tools,
      signal,
      verifyDecode: true,
    });
    notifyQuality(Number.parseInt(result.actualQuality, 10) || 0);
    return result.actualQuality;
  };

  const publish = (source: string) => {
    assertSourceEnabled(videoId);
    publishFile(source, outputPath);
  };

  try {
    const actualQuality = await withMediaRecovery(
      videoId,
      seriesId,
      {
        playInfo: request.playInfo ?? null,
        quality,
        allowLowerQuality,
        force: true,
        signal,
        open: request.open ?? defaultOpen,
        recover: request.recover,
      },
      async (candidate) => {
        assertSourceEnabled(videoId);
        notifyQuality(Math.min(Number(candidate.width) || 0, Number(candidate.height) || 0));
        announce({ receivedBytes: 0, totalBytes: 0, percent: 0 });

        if (candidate.format === 'hls') {
          await remuxHls({
            url: String(candidate.url),
            output: temporaryPath,
            ffmpeg: tools.ffmpeg,
            signal,
            checkAccess: () => assertSourceEnabled(videoId),
            headers: {
              ...(candidate.userAgent ? { 'User-Agent': candidate.userAgent } : {}),
              ...(candidate.referer ? { Referer: candidate.referer } : {}),
            },
            onProgress: (received) => announce({ receivedBytes: received, totalBytes: 0, percent: 0 }),
          });
          const hlsQuality = await verifyDownloaded(temporaryPath);
          publish(temporaryPath);
          return hlsQuality;
        }

        const response = await requestMedia(candidate, { signal });
        const totalBytes = Number(response.headers?.['content-length']) || 0;
        announce({ receivedBytes: 0, totalBytes, percent: 0 });
        await pipeToFile(response, temporaryPath, {
          signal,
          maxBytes: request.maxBytes,
          onProgress: (received, total) => {
            announce({
              receivedBytes: received,
              totalBytes: total || totalBytes,
              percent: total ? Math.min(99, Math.floor((received / total) * 100)) : 0,
            });
          },
        });

        if (candidate.contentKey || candidate.spadeA) announce({ phase: 'decrypting', totalBytes });
        if (candidate.contentKey) {
          await decryptContentKeyFile(
            { input: temporaryPath, output: decodedPath, contentKey: String(candidate.contentKey) },
            { ffmpeg: tools.ffmpeg, signal },
          );
          const decryptedQuality = await verifyDownloaded(decodedPath);
          publish(decodedPath);
          return decryptedQuality;
        }
        if (candidate.spadeA) {
          const key = deriveKey(candidate.spadeA);
          if (!key) throw Object.assign(new Error('Key 派生失败'), { code: 'MEDIA_DECODE_ERROR' });
          await decryptFileInWorker(
            { srcPath: temporaryPath, dstPath: decodedPath, key },
            { signal, workerPath: request.decryptWorkerPath },
          );
          const decryptedQuality = await verifyDownloaded(decodedPath);
          publish(decodedPath);
          return decryptedQuality;
        }
        const downloadedQuality = await verifyDownloaded(temporaryPath);
        publish(temporaryPath);
        return downloadedQuality;
      },
    );

    const bytes = (() => {
      try {
        return fs.statSync(outputPath).size;
      } catch {
        return 0;
      }
    })();
    announce({ receivedBytes: bytes, totalBytes: bytes, percent: 100 });
    return {
      actualQuality,
      // 进度里的「正在下载更低质量」在完成后要改成「已下载」，否则界面一直显示「正在」。
      qualityNotice: notice.replace('正在下载', '已下载'),
      bytes,
    };
  } catch (error) {
    if (signal?.aborted) {
      cleanup();
      throw canceledError('已取消下载');
    }
    // 片源不可用但已拿到「换个地址」的信号时，交给上层按传输失败重试。
    if (!(error as { code?: string })?.code && !(error as Error)?.message) {
      throw mediaTransferError('视频下载失败，请重试');
    }
    throw error;
  } finally {
    cleanup();
  }
}
