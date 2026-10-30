/**
 * HLS 暂存与输出空间（迁移自 4.5 `scripts/check-hls-space.cjs`）。
 *
 * 5.0 的实现要点没变：暂存与输出放在同一设备，多个 HLS 任务共享一份剩余空间预算
 * （`DISK_RESERVE` + 各自排队中的写入 + 未写完的 MP4），失败要清掉暂存文件。
 * 本机没有可用的「小磁盘」，所以只把 `fs.statfsSync` 换成可控剩余空间，
 * 传输用注入的 `request`（手工 Readable），FFmpeg 用真子进程的 shell 替身。
 *
 * 守四条：输出要预留空间；并发任务不能重复花掉同一份预留；
 * FFmpeg 前后要复核；转换中空间变紧要杀子进程并释放预留。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MiB = 1024 * 1024;
const RESERVE = 512 * MiB;
const disk = vi.hoisted(() => ({ freeBytes: 1e15 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statfsSync = () => ({ bsize: 1, bavail: disk.freeBytes, blocks: 0, bfree: 0 });
  return { ...actual, default: { ...actual, statfsSync }, statfsSync };
});

const { remuxHls } = await import('./hls.ts');

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n';

interface Segment {
  /** 手工推送的响应体；不调用 release 就一直挂在传输中 */
  stream: Readable;
  release(bytes: number): void;
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-hls-space-'));
  dirs.push(dir);
  return dir;
}

/**
 * 真子进程的 FFmpeg 替身：产物路径来自最后一个绝对参数，启动时落一个
 * `<产物>.started` 标记，便于按任务断言「有没有起过 FFmpeg」。
 * block 版用 `exec sleep`：SIGTERM 直接作用于 sleep，不会留孤儿进程吊住 stderr 管道。
 */
function fakeFfmpeg(dir: string, options: { block?: boolean } = {}): string {
  const body = [
    'out=""',
    'for arg in "$@"; do case "$arg" in /*) out="$arg";; esac; done',
    '[ -z "$out" ] && exit 2',
    'touch "$out.started"',
    options.block ? 'exec sleep 10' : 'printf \'hls-output\' > "$out"',
    '',
  ].join('\n');
  const file = path.join(dir, 'ffmpeg');
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const started = (dir: string, name: string) => fs.existsSync(path.join(dir, `${name}.mp4.started`));

/** 清单与分片都用给定的字节数，便于控制预留的规模。 */
function staged(segmentBytes = 7): { request: (url: string) => Promise<unknown> } {
  return {
    request: async (url: string) => {
      const isPlaylist = url.endsWith('.m3u8');
      return {
        status: 200,
        headers: {},
        url,
        data: Readable.from([isPlaylist ? Buffer.from(playlist) : Buffer.alloc(segmentBytes, 1)]),
      };
    },
  };
}

/** 播放清单正常、分片卡住的传输；release 之后分片才到达。 */
function stallingRequest(): { request: (url: string) => Promise<unknown>; segment: Segment } {
  const stream = new Readable({ read() {} });
  const segment: Segment = {
    stream,
    release(bytes: number) {
      stream.push(Buffer.alloc(bytes));
      stream.push(null);
    },
  };
  return {
    segment,
    request: async (url: string) => ({
      status: 200,
      headers: {},
      url,
      data: url.endsWith('.m3u8') ? Readable.from([Buffer.from(playlist)]) : stream,
    }),
  };
}

function run(
  dir: string,
  name: string,
  ffmpeg: string,
  request: (url: string) => Promise<unknown>,
  options: Record<string, unknown> = {},
) {
  return remuxHls({
    url: 'https://fixture.example/media.m3u8',
    output: path.join(dir, `${name}.mp4`),
    ffmpeg,
    request: request as never,
    ...options,
  } as never);
}

afterEach(() => {
  disk.freeBytes = 1e15;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('空间预留', () => {
  it('暂存要为输出预留空间：只剩 512MiB 时在起 FFmpeg 之前就停手', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    disk.freeBytes = RESERVE + MiB / 2;
    await expect(run(dir, 'large', ffmpeg, staged(MiB).request)).rejects.toThrow(/空间不足/);
    expect(started(dir, 'large'), '空间不够不能起 FFmpeg').toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.hongguo-hls-'))).toEqual([]);
  });

  it('空间够用时正常重封装（预留是有限的，不是「磁盘必须很大」）', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    disk.freeBytes = RESERVE + 4 * MiB;
    await run(dir, 'small', ffmpeg, staged(MiB).request);
    expect(fs.readFileSync(path.join(dir, 'small.mp4')).toString()).toBe('hls-output');
    expect(started(dir, 'small')).toBe(true);
  });

  it('并发任务共享同一份剩余空间预算，第二个不起 FFmpeg', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    disk.freeBytes = RESERVE + 4 * MiB;
    const stalling = stallingRequest();
    const first = run(dir, 'first', ffmpeg, stalling.request);
    // 等第一个任务挂到分片传输上（此时它已占住自己的预留）。
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = run(dir, 'second', ffmpeg, staged(2 * MiB).request);
    await expect(second).rejects.toThrow(/空间不足/);
    expect(started(dir, 'second'), '被拒的任务不能起 FFmpeg').toBe(false);
    expect(fs.existsSync(path.join(dir, 'second.mp4'))).toBe(false);

    stalling.segment.release(MiB);
    await first;
    expect(fs.readFileSync(path.join(dir, 'first.mp4')).toString()).toBe('hls-output');
    expect(started(dir, 'first')).toBe(true);
  });
});

describe('复核与中断', () => {
  it('暂存期间空间变紧：不再进入 FFmpeg，并清掉暂存文件', async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    disk.freeBytes = RESERVE + 8 * MiB;
    const stalling = stallingRequest();
    const pending = run(dir, 'changed', ffmpeg, stalling.request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    disk.freeBytes = RESERVE + 256 * 1024;
    stalling.segment.release(MiB / 4);
    await expect(pending).rejects.toThrow(/空间不足/);
    expect(started(dir, 'changed')).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.hongguo-hls-'))).toEqual([]);
  });

  it('转换中空间变紧会杀掉子进程、释放预留，之后新任务仍能跑', { timeout: 60_000 }, async () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir, { block: true });
    disk.freeBytes = RESERVE + 8 * MiB;

    const timers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void) => {
      timers.push(handler);
      return 0 as never;
    }) as never);

    const pending = run(dir, 'running', ffmpeg, staged(MiB).request);
    // 先把拒绝收进变量：中途断言失败时不能留下未处理的 rejection。
    const caught = pending.then(
      () => null,
      (error: Error) => error,
    );
    // 全量并行时 shell 启动可能慢到几秒，等待预算给足（正常几百毫秒就绪）。
    for (let i = 0; i < 4_000 && !started(dir, 'running'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(started(dir, 'running'), 'FFmpeg 应该已经启动').toBe(true);
    expect(timers.length, '转换期间要持续监控剩余空间').toBeGreaterThan(0);

    disk.freeBytes = RESERVE + 512 * 1024;
    for (const timer of timers) timer();
    const error = await caught;
    expect(error?.message ?? '').toMatch(/空间不足/);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.hongguo-hls-'))).toEqual([]);

    // 预留已释放：空间恢复后新任务能正常完成。
    disk.freeBytes = RESERVE + 8 * MiB;
    await run(dir, 'next', fakeFfmpeg(dir), staged(MiB).request);
    expect(fs.readFileSync(path.join(dir, 'next.mp4')).toString()).toBe('hls-output');
  });
});

describe('FFmpeg 替身自检', () => {
  it('替身脚本可执行，不会污染真实文件', () => {
    const dir = tempDir();
    const ffmpeg = fakeFfmpeg(dir);
    const result = spawnSync(ffmpeg, ['-v', 'error', path.join(dir, 'out.mp4')]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out.mp4')).toString()).toBe('hls-output');
  });
});
