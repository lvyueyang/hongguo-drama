/**
 * CENC 解密 worker（恢复 4.5 用 worker_threads 的两条能力：让出事件循环、可取消）。
 *
 * 为什么必须独立进程/线程：单集 1080p 是十几 MB，逐样本 AES-CTR 在主线程上跑会把窗口卡住，
 * 而且主线程忙时连"取消"IPC 都收不到。这里把纯计算搬进 worker，主线程只等结果。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { decryptMp4Buffer, decryptMp4File } from '@hongguo/sdk';

interface Payload {
  srcPath?: string;
  dstPath?: string;
  buffer?: ArrayBuffer | Uint8Array;
  key: ArrayLike<number>;
}

function run(): void {
  try {
    const payload = workerData as Payload;
    const key = Buffer.from(payload.key);
    if (payload.srcPath && payload.dstPath) {
      decryptMp4File(payload.srcPath, payload.dstPath, key as never);
      parentPort?.postMessage({ done: true });
      return;
    }
    const input = payload.buffer;
    if (!input) throw new Error('缺少待解密数据');
    const buffer = Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input));
    const output = decryptMp4Buffer(buffer, key as never) as Buffer;
    // 用 Transferable 回传，避免大对象结构化克隆。
    const copy = new Uint8Array(output.length);
    copy.set(output);
    parentPort?.postMessage({ buffer: copy.buffer }, [copy.buffer]);
  } catch (error) {
    parentPort?.postMessage({ error: (error as Error).message });
  }
}

run();
