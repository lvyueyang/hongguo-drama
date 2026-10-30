// SPDX-License-Identifier: MIT
/**
 * 一键合并：ffmpeg concat，能直复制就不重编码，不能才统一编码。
 *
 * 迁移自 4.5 `src/native/merge-runner.js`（`runMerge`）。保留的关键行为：
 * - 每集先探测，缺时长/尺寸直接报「请重新下载本集」，不猜；
 * - 编码一致走 copy（无损且快）；不一致先按各自分辨率统一编码，再 concat；
 * - 硬件编码器**整轮失败才换**，绝不中途混用两种编码器参数；
 * - 合并前算磁盘余量：重编码需要 2.2 倍、直复制 1.1 倍，不够就别开始；
 * - 发布用硬链接/独占复制，绝不覆盖合并过程中用户新建的同名文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFolderName } from '@hongguo/shared';
import { buildMergePlan, canUseHardwareFrames, checkMinimumQuality, type MergeInfo } from './merge-plan.ts';
import {
  createEncoderPicker,
  type EncoderPicker,
  type MediaProbeInfo,
  type MediaTools,
  probeMedia,
  publishFile,
  spawnTool,
} from './tools.ts';

export type { EncoderPicker };
export { createEncoderPicker };

export interface MergeEpisode {
  path: string;
  vid_index: number;
}

/** 合并任务：宿主直接持有并读它渲染进度，所以这里是可变对象而不是纯数据。 */
export interface MergeTask {
  id?: string;
  seriesId?: string;
  status?: string;
  cancelled?: boolean;
  stage?: string;
  stageText?: string;
  progress?: number;
  done?: number;
  checked?: number;
  totalDuration?: number;
  method?: string;
  codecWarning?: string;
  targetBitrate?: number | null;
  speed?: number;
  etaSeconds?: number | null;
  encoder?: string;
  decoder?: string;
  concurrency?: number;
  verified?: string;
  outputBytes?: number;
  totalBytes?: number;
  elapsedSeconds?: number;
  phaseTimings?: Record<string, number>;
  cleanupWarning?: string;
  children?: Set<unknown>;
}

export interface MergeRequest {
  task: MergeTask;
  episodes: MergeEpisode[];
  outDir: string;
  outputPath: string;
  tools: MediaTools;
  compatible?: boolean;
  /** 只合并达到 1080P 的分集；任一集不达标就拒绝（4.5 的 require1080） */
  require1080?: boolean;
  onProgress?(): void;
  pickEncoder?: EncoderPicker;
  probe?(file: string): Promise<MergeInfo | null>;
}

export interface MergeResult {
  path: string;
  count: number;
  bytes: number;
}

/** 默认输出名：`<剧名>_合集.mp4`；同名已存在就顺延 `(2)`，不覆盖别人的文件。 */
export function defaultOutputPath(outDir: string, seriesTitle: string): string {
  const baseName = sanitizeFolderName(seriesTitle) || '未命名短剧';
  return uniqueOutputPath(outDir, `${baseName}_合集`);
}

function uniqueOutputPath(outDir: string, baseName: string): string {
  let output = path.join(outDir, `${baseName}.mp4`);
  for (let number = 2; fs.existsSync(output); number++) {
    output = path.join(outDir, `${baseName} (${number}).mp4`);
  }
  return output;
}

/** 清掉上次中断留下的工作目录；只删自己建的合法目录，别动用户的东西。 */
export async function cleanupMergeTemps(directories: string[]): Promise<void> {
  for (const directory of directories) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.merge-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const temporary = path.join(directory, entry.name);
      const children = await fs.promises.readdir(temporary, { withFileTypes: true });
      if (
        children.some(
          (child) => !child.isFile() || !/^(?:\d+\.(?:mp4|ts)|list\.ffconcat|output\.mp4)$/.test(child.name),
        )
      )
        continue;
      await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

export async function mergeSeries(request: MergeRequest): Promise<MergeResult> {
  const { task, episodes, outDir, outputPath, tools } = request;
  if (!episodes.length) throw new Error('这部剧还没有已完成的下载，无法合并');
  const pickEncoder = request.pickEncoder ?? createEncoderPicker(tools);
  const probe =
    request.probe ??
    (async (file: string): Promise<MergeInfo | null> =>
      (await probeMedia({ tools, file, rejectToolErrors: true })) as MediaProbeInfo | null);
  if (!tools.ffmpeg || !tools.ffprobe) throw new Error('未找到完整 FFmpeg 工具，无法检查并合并分集');

  const ordered = [...episodes].sort((a, b) => a.vid_index - b.vid_index);
  task.children ??= new Set();
  const children = task.children;
  let temporary: string | undefined;
  let lastUpdate = 0;
  let stageStarted = Date.now();
  task.phaseTimings ??= {};

  const check = () => {
    if (task.cancelled) throw new Error('已取消');
  };
  const emit = (force = false) => {
    if (force || Date.now() - lastUpdate > 500) {
      lastUpdate = Date.now();
      request.onProgress?.();
    }
  };
  const recordStage = () => {
    if (task.stage)
      task.phaseTimings![task.stage] =
        (task.phaseTimings![task.stage] ?? 0) + (Date.now() - stageStarted) / 1000;
    stageStarted = Date.now();
  };
  const stage = (name: string, text: string) => {
    recordStage();
    task.stage = name;
    task.stageText = text;
    task.speed = 0;
    task.etaSeconds = null;
    emit(true);
  };
  const run = (args: string[], onTime?: (seconds: number) => void) =>
    new Promise<void>((resolve, reject) => {
      if (task.cancelled) {
        reject(new Error('已取消'));
        return;
      }
      const tool = spawnTool(tools.ffmpeg as string, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        ...args,
        '-progress',
        'pipe:1',
        '-nostats',
      ]);
      children.add(tool.child);
      let pending = '';
      let errors = '';
      tool.child.stdout?.on('data', (data: string) => {
        pending += data;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            onTime?.(Math.max(0, Number(line.slice(12)) / 1e6 || 0));
          }
        }
      });
      tool.child.stderr?.on('data', (data: string) => {
        errors = (errors + data).slice(-2400);
      });
      void tool.done.then((code) => {
        children.delete(tool.child);
        if (task.cancelled) reject(new Error('已取消'));
        else if (code !== 0)
          reject(new Error(`FFmpeg 退出码 ${code}：${errors.trim() || '没有返回错误详情'}`));
        else resolve();
      });
    });

  try {
    stage('checking', '检查分集');
    const infos: MergeInfo[] = [];
    for (let index = 0; index < ordered.length; index++) {
      check();
      const info = await probe(ordered[index]!.path);
      check();
      if (!info || !(info.duration > 0))
        throw new Error(`第 ${ordered[index]!.vid_index} 集无法读取有效视频信息，请重新下载本集`);
      infos.push(info);
      task.checked = index + 1;
      emit();
    }

    if (request.require1080 === true) {
      // 放在建工作目录之前：不达标就什么都不创建，也不在磁盘上留垃圾。
      const gate = checkMinimumQuality(infos, {
        vidIndexes: ordered.map((episode) => episode.vid_index),
        minimum: 1080,
      });
      if (!gate.ok) throw new Error(gate.reason);
    }

    const plan = buildMergePlan(infos, { compatible: request.compatible === true });
    task.totalDuration = plan.totalDuration;
    const normalize =
      plan.videoMode === 'encode' ||
      plan.audioMode === 'encode' ||
      plan.remux ||
      plan.videoContainer === 'mpegts';
    task.method =
      plan.videoMode === 'encode'
        ? '统一视频编码'
        : plan.audioMode === 'encode'
          ? '保留画质，仅统一音频'
          : plan.remux || plan.videoContainer === 'mpegts'
            ? '无损统一封装'
            : '无损快速合并';
    task.codecWarning =
      plan.videoMode === 'encode' ? '分集编码不一致，按各自原分辨率统一为 H.264；原文件保留' : '';
    task.targetBitrate = plan.videoMode === 'encode' ? plan.videoBitrate : null;

    const estimate = plan.videoMode === 'encode' ? plan.estimatedBytes : (task.totalBytes ?? 0) * 1.1;
    const required = estimate * (normalize ? 2.2 : 1.1);
    try {
      const stat = fs.statfsSync(outDir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < required)
        throw new Error(
          `磁盘空间不足：需要约 ${(required / 1073741824).toFixed(1)} GB，可用 ${(free / 1073741824).toFixed(1)} GB`,
        );
    } catch (error) {
      if ((error as Error).message.startsWith('磁盘空间不足')) throw error;
    }
    check();

    temporary = await fs.promises.mkdtemp(path.join(outDir, '.merge-'));
    let files = ordered.map((episode) => episode.path);

    if (normalize) {
      let encoder: string | null = plan.videoMode === 'encode' ? await pickEncoder() : null;
      let hardwareFrames = canUseHardwareFrames(infos, encoder);
      check();
      const extension = plan.videoContainer === 'mpegts' ? 'ts' : 'mp4';
      const targets = ordered.map((_episode, index) =>
        path.join(temporary as string, `${index}.${extension}`),
      );

      const normalizeAll = async (): Promise<string[]> => {
        stage(
          'preparing',
          plan.videoMode === 'encode'
            ? '统一视频编码'
            : plan.audioMode === 'encode'
              ? '统一音频'
              : '无损统一封装',
        );
        const times = ordered.map(() => 0);
        const started = Date.now();
        let next = 0;
        let failure: unknown;
        task.done = 0;
        task.progress = 0;
        task.encoder = encoder ?? 'copy';
        task.decoder = hardwareFrames ? 'videotoolbox' : 'software';
        // 硬件编码开两路就够（再多会抢设备）；软件编码用一路，避免把 CPU 打满。
        const concurrency = encoder && encoder !== 'libx264' ? 2 : 1;
        task.concurrency = concurrency;
        emit(true);
        const worker = async () => {
          while (!failure && next < ordered.length) {
            const index = next++;
            try {
              check();
              const args = [
                ...(hardwareFrames
                  ? ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld']
                  : []),
                '-i',
                ordered[index]!.path,
              ];
              if (plan.audioMode === 'encode' && !infos[index]!.audio)
                args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
              args.push('-map', '0:v:0');
              if (plan.audioMode !== 'none') args.push('-map', infos[index]!.audio ? '0:a:0' : '1:a:0');
              if (plan.videoMode === 'encode') {
                args.push(
                  '-vf',
                  `setsar=1,fps=${plan.fps},settb=1/90000,setpts=PTS-STARTPTS`,
                  '-c:v',
                  String(encoder),
                  ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-threads', '4'] : []),
                  '-b:v',
                  String(plan.videoBitrate),
                  '-maxrate',
                  String(plan.videoBitrate * 1.5),
                  '-bufsize',
                  String(plan.videoBitrate * 3),
                  '-profile:v',
                  'high',
                  ...(hardwareFrames ? [] : ['-pix_fmt', 'yuv420p']),
                  '-bf',
                  '0',
                  '-g',
                  String(Math.round(plan.fps * 2)),
                );
              } else {
                args.push('-c:v', 'copy');
                if (plan.videoContainer === 'mpegts') args.push('-bsf:v', 'hevc_mp4toannexb');
              }
              args.push('-video_track_timescale', '90000');
              if (plan.audioMode === 'encode')
                args.push(
                  '-af',
                  'aresample=48000:async=1:first_pts=0,apad',
                  '-c:a',
                  'aac',
                  '-b:a',
                  String(plan.audioBitrate),
                  '-ar',
                  '48000',
                  '-ac',
                  '2',
                );
              else if (plan.audioMode === 'copy') args.push('-c:a', 'copy');
              else args.push('-an');
              args.push(
                '-t',
                String(infos[index]!.duration),
                '-map_metadata',
                '-1',
                '-f',
                plan.videoContainer === 'mpegts' ? 'mpegts' : 'mp4',
                targets[index]!,
              );
              await run(args, (seconds) => {
                times[index] = Math.min(seconds, infos[index]!.duration);
                const processed = times.reduce((sum, value) => sum + value, 0);
                task.progress = Math.min(89, Math.floor((processed / plan.totalDuration) * 90));
                task.speed = processed / Math.max(0.1, (Date.now() - started) / 1000);
                task.etaSeconds =
                  task.speed > 0 ? Math.max(0, (plan.totalDuration - processed) / task.speed) : null;
                emit();
              });
              times[index] = infos[index]!.duration;
              task.done = (task.done ?? 0) + 1;
              emit(true);
            } catch (error) {
              if (!failure) {
                failure = error;
                stopMergeChildren(task);
              }
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        if (failure) throw failure;
        return targets;
      };

      for (;;) {
        try {
          files = await normalizeAll();
          break;
        } catch (error) {
          check();
          if (!encoder || encoder === 'libx264') throw error;
          // 所有子进程都已退出，整轮重来；绝不混用两套编码器参数。
          for (let index = 0; index < ordered.length; index++) {
            await fs.promises.rm(targets[index]!, { force: true });
          }
          if (hardwareFrames) {
            hardwareFrames = false;
            task.codecWarning = '硬件解码不可用，已切换常规解码；仍使用硬件编码';
          } else {
            task.codecWarning = '硬件编码不可用，已完整切换软件编码；原文件保留';
            encoder = 'libx264';
          }
        }
      }
    }

    check();
    stage('joining', '写入合并文件');
    const temporaryDir = temporary as string;
    const listPath = path.join(temporaryDir, 'list.ffconcat');
    const tmpOutput = path.join(temporaryDir, 'output.mp4');
    fs.writeFileSync(
      listPath,
      `${files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')}\n`,
    );
    const joinedAt = Date.now();
    await run(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        ...(plan.videoTag ? ['-tag:v', plan.videoTag] : []),
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        tmpOutput,
      ],
      (seconds) => {
        task.progress = Math.min(
          97,
          Math.floor((normalize ? 90 : 0) + Math.min(1, seconds / plan.totalDuration) * (normalize ? 7 : 97)),
        );
        task.speed = seconds / Math.max(0.1, (Date.now() - joinedAt) / 1000);
        task.etaSeconds = task.speed ? Math.max(0, (plan.totalDuration - seconds) / task.speed) : null;
        if (!normalize) {
          let sum = 0;
          let done = 0;
          for (const info of infos) {
            sum += info.duration;
            if (sum <= seconds) done += 1;
          }
          task.done = done;
        }
        emit();
      },
    );
    check();
    // 发布时如果目标文件已存在（用户刚新建的），硬链接与独占复制都会失败，不会覆盖它。
    publishFile(tmpOutput, outputPath);
    task.verified = '';
    task.outputBytes = fs.statSync(outputPath).size;
    recordStage();
    task.status = 'completed';
    task.stage = 'completed';
    task.stageText = '合并完成';
    task.progress = 100;
    task.done = ordered.length;
    task.etaSeconds = 0;
    return { path: outputPath, count: ordered.length, bytes: task.outputBytes };
  } finally {
    recordStage();
    if (temporary) {
      try {
        await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        task.cleanupWarning = `临时文件未清理：${temporary}`;
      }
    }
    delete task.children;
    task.elapsedSeconds = 0;
  }
}

/** 取消：杀掉所有还在跑的 ffmpeg（优雅后强杀）。 */
export function stopMergeChildren(task: MergeTask): void {
  const candidates = new Set<any>([...(task.children ?? [])]);
  for (const child of candidates) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 2000);
    timer.unref?.();
    child.once?.('close', () => clearTimeout(timer));
  }
}
