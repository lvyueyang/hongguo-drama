/**
 * 真实素材验收（一次性脚本，不进 CI）：用 SDK 走「搜索 → 分集 → 取流 → 解密 → 校验 → 发布」。
 * 遵守 AGENTS.md：随机真实短剧、独立下载目录、全程不播放（因此无声音）、不打印签名地址与密钥。
 *
 * 运行：node tooling/acceptance/real-download.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from '../../packages/host-fake/src/index.ts';
import { createSdk, downloadEpisode, probeMedia, resolveMediaTools } from '../../packages/sdk/src/index.ts';

// 用真实文件系统的宿主替身，保证临时目录落在系统临时区
const host = createFakeHost();
host.fs = () => ({
  ...createFakeHost().fs(),
  ensureDir: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
  exists: (file: string) => fs.existsSync(file),
  readText: (file: string) => fs.readFileSync(file, 'utf8'),
  readBuffer: (file: string) => fs.readFileSync(file),
  writeText: (file: string, content: string) => fs.writeFileSync(file, content),
  remove: (file: string) => fs.rmSync(file, { force: true }),
  stat: (file: string) => ({ size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }),
  list: (dir: string) => fs.readdirSync(dir),
});

const sdk = createSdk();
const tools = resolveMediaTools(host, { devLookup: false });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-acceptance-'));

function log(step: string, detail: string): void {
  console.log(`[${step}] ${detail}`);
}

try {
  log('tools', `ffmpeg=${tools.ffmpegPath ? 'ok' : '缺失'} ffprobe=${tools.ffprobePath ? 'ok' : '缺失'}`);

  // 1) 搜索联想（真实接口）
  const suggestions = await sdk.suggest('一村人');
  const drama = suggestions.find((item) => item.wordType === 'short_play_name' && item.series);
  if (!drama?.series) throw new Error('联想没有返回剧集');
  log('suggest', `${suggestions.length} 条；选中《${drama.series.title}》共 ${drama.series.episodeCount} 集`);

  // 2) 分集列表
  const series = (await sdk.series.episodes(drama.series.seriesId)) as {
    series_title?: string;
    episodes?: Array<{ vid: string; vid_index: number; locked?: boolean }>;
  };
  const episodes = series.episodes ?? [];
  const playable = episodes.filter((episode) => !episode.locked);
  if (!playable.length) throw new Error('没有可播放分集');
  // 随机选一集（避开第一集，减少命中官网 SEO 预览的可能）
  const target =
    playable[Math.min(playable.length - 1, 1 + Math.floor(Math.random() * Math.max(1, playable.length - 1)))];
  log('episodes', `${episodes.length} 集，随机选第 ${target.vid_index} 集`);

  // 3) 取流
  const playInfo = (await sdk.playback.sources(target.vid, drama.series.seriesId, { quality: 'auto' })) as {
    url?: string;
    contentKey?: string | null;
    spadeA?: string | null;
    codec?: string;
    source?: string;
    error?: string;
  };
  if (!playInfo?.url) throw new Error(playInfo?.error ?? '取流失败');
  log(
    'playback',
    `source=${playInfo.source} codec=${playInfo.codec || '-'} 加密=${playInfo.spadeA ? 'spade_a' : playInfo.contentKey ? 'content_key' : '无'}`,
  );

  // 4) 下载 + 解密 + 校验 + 发布（不播放，避免任何声音）
  const outputPath = path.join(root, `ep${target.vid_index}.mp4`);
  const result = await downloadEpisode({
    playInfo: playInfo as never,
    outputPath,
    quality: 'auto',
    tools,
    host: host as never,
    onProgress: (progress) => {
      if (progress.receivedBytes % (1024 * 1024) < 64 * 1024) {
        log('progress', `${Math.round(progress.receivedBytes / 1024)} KiB`);
      }
    },
  });
  const size = fs.statSync(outputPath).size;
  const info = await probeMedia(outputPath, tools);
  log('downloaded', `${size} 字节 → ${outputPath}`);
  log(
    'probed',
    `${info.w}×${info.h} codec=${info.codec} 时长=${info.duration.toFixed(2)}s 音频=${info.audio ? '有' : '无'}`,
  );
  log('result', `actualQuality=${result.actualQuality} notice=${result.qualityNotice || '(无)'}`);

  // 本轮验收产物清理（只删本轮临时目录）
  fs.rmSync(root, { recursive: true, force: true });
  log('cleanup', '已删除本轮临时目录');
  console.log('ACCEPTANCE_OK');
} catch (error) {
  console.error('ACCEPTANCE_FAIL', (error as Error).message);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
