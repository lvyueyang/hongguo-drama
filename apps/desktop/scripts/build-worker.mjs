/**
 * 单独打包解密 worker。
 *
 * 为什么不放进 electron-vite 的 multi-entry：Rolldown 在「同一模块被两个入口
 * 以不同符号集共享」时会 panic（Symbol ... is not in any chunk）。
 * worker 只有一个入口、依赖很少，用 esbuild 单独打一份最省事也最稳定。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// 必须落在 out/main 之外：electron-vite 每次构建都会清空 out/main、out/preload、out/renderer，
// 放在里面会被下一次构建（或 dev 重启）无声删掉，运行时就成了「解密线程脚本不存在」。
const outfile = path.join(root, 'out/workers/decrypt-worker.js');

mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/main/workers/decrypt-worker.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // worker 里没有 electron，也没有需要外置的原生模块。
  external: [],
  logLevel: 'info',
});
console.log(`[worker] 已产出 ${path.relative(root, outfile)}`);
