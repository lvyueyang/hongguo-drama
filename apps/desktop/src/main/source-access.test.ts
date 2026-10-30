/**
 * 停用来源的收尾计划（迁移自 4.5 `check-custom-media-integration.cjs` 的停用部分）。
 * 不变量：停用来源只影响它自己；已下载的文件绝不被删。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { disabledSourceIds, planDisabledSources, sourceIdOfVid } from './source-access.ts';

const A = 'a066a170-46e7-47aa-9c87-6364d8483e87';
const B = 'b066a170-46e7-47aa-9c87-6364d8483e87';
const source = (id: string, enabled = true) => ({ id, enabled });

describe('sourceIdOfVid', () => {
  it('只认自定义来源前缀，大小写归一', () => {
    expect(sourceIdOfVid(`custom:${A}:1:0:0`)).toBe(A);
    expect(sourceIdOfVid(`custom:${A.toUpperCase()}:1`)).toBe(A);
    expect(sourceIdOfVid('hema:1:2')).toBeNull();
    expect(sourceIdOfVid('1234567')).toBeNull();
    expect(sourceIdOfVid(undefined)).toBeNull();
  });
});

describe('disabledSourceIds', () => {
  it('被删掉与被设成 disabled 都算停用', () => {
    expect(disabledSourceIds([source(A), source(B)], [source(B)])).toEqual([A]);
    expect(disabledSourceIds([source(A)], [source(A, false)])).toEqual([A]);
  });

  it('新增、改 URL、本来就是停用的都不算「这次被停用」', () => {
    expect(disabledSourceIds([source(A)], [source(A), source(B)])).toEqual([]);
    expect(disabledSourceIds([source(A, false)], [source(A, false)])).toEqual([]);
    expect(disabledSourceIds([], [source(A)])).toEqual([]);
    expect(disabledSourceIds(undefined, [])).toEqual([]);
  });
});

describe('planDisabledSources', () => {
  const tasks = [
    { id: 'running', vid: `custom:${A}:1:0:0`, status: 'downloading' },
    { id: 'pending', vid: `custom:${A}:1:0:1`, status: 'pending' },
    { id: 'failed', vid: `custom:${A}:1:0:2`, status: 'failed' },
    { id: 'done', vid: `custom:${A}:1:0:3`, status: 'completed' },
    { id: 'paused', vid: `custom:${A}:1:0:4`, status: 'stopped' },
    { id: 'other-source', vid: `custom:${B}:1:0:0`, status: 'downloading' },
    { id: 'hongguo', vid: '1234567', status: 'downloading' },
  ];

  it('停掉该来源里未完成的任务，已完成的成品与其它来源不动', () => {
    const plan = planDisabledSources([source(A), source(B)], [source(B)], tasks);
    expect(plan.disabledIds).toEqual([A]);
    expect(plan.stoppedTaskIds).toEqual(['running', 'pending', 'failed']);
  });

  it('清会话与缓存、让适配器放弃在飞请求（否则停用只对新请求生效）', () => {
    const plan = planDisabledSources([source(A)], [source(A, false)], tasks);
    expect(plan).toMatchObject({ clearSessions: true, clearCache: true, cancelRequests: true });
  });

  it('没有来源被停用时什么都不做', () => {
    expect(planDisabledSources([source(A)], [source(A)], tasks)).toEqual({
      disabledIds: [],
      stoppedTaskIds: [],
      clearSessions: false,
      clearCache: false,
      cancelRequests: false,
    });
    expect(planDisabledSources(undefined, undefined, tasks).stoppedTaskIds).toEqual([]);
  });

  it('没有任务时也给出一致的计划（只有清理动作）', () => {
    expect(planDisabledSources([source(A)], [], []).stoppedTaskIds).toEqual([]);
    expect(planDisabledSources([source(A)], [], []).clearCache).toBe(true);
  });
});

describe('主进程接线（源码断言）', () => {
  it('设置保存后按计划停下来源任务、清会话与缓存、放弃在飞请求', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/src/main/index.ts'), 'utf8');
    expect(source).toContain('planDisabledSources');
    expect(source).toContain('queue.pause');
    expect(source).toContain('sessions.clear()');
    expect(source).toContain('playbackCache.clear()');
    expect(source).toContain('cancelRequests');
    // 只在 IPC 入口包一层，内部写设置不走这段收尾
    expect(source).toMatch(/saveSettings: \(next: Record<string, unknown>\)/);
  });
});
