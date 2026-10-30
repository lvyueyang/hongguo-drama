/**
 * 真实素材合并验收（一次性脚本）：下载相邻两集 → 合并 → 探测产物。
 * 遵守 AGENTS.md：随机真实短剧、独立目录、不播放（无声音）、不记录签名地址与密钥。
 *
 * 运行：node tooling/acceptance/real-merge.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost } from '../../packages/host-fake/src/index.ts';
import {
  createSdk,
  defaultOutputPath,
  downloadEpisode,
  mergeSeries,
  probeMedia,
  resolveMediaTools,
} from '../../packages/sdk/src/index.ts';

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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-merge-'));
const log = (step: string, detail: string): void => console.log(`[${step}] ${detail}`);

try {
  const suggestions = await sdk.suggest('修仙');
  const drama = suggestions.find((item) => item.wordType === 'short_play_name' && item.series);
  if (!drama?.series) throw new Error('联想没有返回剧集');
  const series = (await sdk.series.episodes(drama.series.seriesId)) as {
    series_title?: string;
    episodes?: Array<{ vid: string; vid_index: number; locked?: boolean }>;
  };
  const first = Math.max(1, Math.floor(Math.random() * 10));
  const picked = (series.episodes ?? [])
    .filter((episode) => !episode.locked && episode.vid_index >= first && episode.vid_index <= first + 1)
    .slice(0, 2);
  if (picked.length < 2) throw new Error('可选的相邻两集不足');
  log(
    'pick',
    `《${series.series_title ?? drama.series.title}》第 ${picked.map((e) => e.vid_index).join('、')} 集`,
  );

  const files: Array<{ path: string; vid_index: number }> = [];
  for (const episode of picked) {
    const playInfo = (await sdk.playback.sources(episode.vid, drama.series.seriesId, {
      quality: 'auto',
    })) as never;
    const outputPath = path.join(root, `ep${episode.vid_index}.mp4`);
    const result = await downloadEpisode({
      playInfo,
      outputPath,
      quality: 'auto',
      tools,
      host: host as never,
    });
    files.push({ path: outputPath, vid_index: episode.vid_index });
    log(
      'download',
      `第 ${episode.vid_index} 集 ${result.actualQuality} ${fs.statSync(outputPath).size} 字节`,
    );
  }

  const outputPath = defaultOutputPath(root, series.series_title ?? drama.series.title);
  const task: Record<string, unknown> = {
    id: 'acceptance-merge',
    status: 'running',
    startTime: Date.now(),
    cancelled: false,
  };
  const merged = await mergeSeries({
    task: task as never,
    episodes: files,
    outDir: root,
    outputPath,
    tools,
    onProgress: () => {},
  });
  const info = await probeMedia(merged.path, tools);
  log('merged', `${fs.statSync(merged.path).size} 字节 → ${path.basename(merged.path)}`);
  log(
    'probed',
    `${info.w}×${info.h} codec=${info.codec} 时长=${info.duration.toFixed(2)}s 音频=${info.audio ? '有' : '无'}`,
  );
  log('segments', `输入两集合计 ${files.length} 段，产物时长应接近两集之和`);

  fs.rmSync(root, { recursive: true, force: true });
  log('cleanup', '已删除本轮临时目录');
  console.log('MERGE_ACCEPTANCE_OK');
} catch (error) {
  console.error('MERGE_ACCEPTANCE_FAIL', (error as Error).message);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
