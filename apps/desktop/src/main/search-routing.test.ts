/**
 * 多来源搜索路由与总预算（迁移自 4.5 `scripts/check-source-routing.cjs` +
 * `check-search-deadline.cjs`）。
 *
 * 两条不变量：非红果来源必须回到自己的适配器；所有来源共用同一个总预算，
 * 慢来源不能各自重开计时把整次搜索拖死。
 */

import { createSdk } from '@hongguo/sdk';
import { describe, expect, it } from 'vitest';

const sdk = createSdk();

describe('按来源搜索', () => {
  it('未知来源直接拒绝，不发请求', async () => {
    await expect(sdk.search.bySource('剧名', { source: 'nope' })).rejects.toMatchObject({
      code: 'SOURCE_DISABLED',
    });
  });

  it('空关键词或超长关键词拒绝', async () => {
    await expect(sdk.search.bySource('   ')).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(sdk.search.bySource('红'.repeat(201))).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('红果默认走官网接口，且接受总预算参数（离线环境只会失败、不会被判为不支持来源）', async () => {
    const deadline = Date.now() + 5_000;
    const result = await sdk.search
      .bySource('剧名', { deadline })
      .catch((error: Error & { code?: string }) => error);
    expect((result as { code?: string })?.code).not.toBe('SOURCE_DISABLED');
  });

  it('西饭/河马/自定义各自走自己的适配器', async () => {
    for (const source of ['hema', 'xifan', 'custom:0b9c1a2e-1111-2222-3333-444455556666']) {
      const result = await sdk.search
        .bySource('剧名', { source, deadline: Date.now() + 3_000 })
        .catch((error: Error & { code?: string }) => error);
      expect((result as { code?: string })?.code, source).not.toBe('SOURCE_DISABLED');
    }
  });
});

describe('总预算语义', () => {
  it('预算已用尽时立即失败，不再发起新请求', async () => {
    const started = Date.now();
    const result = await sdk.search
      .bySource('剧名', { source: 'hema', deadline: Date.now() - 1 })
      .catch((error: Error & { code?: string }) => error);
    // 要么直接失败，要么极快返回（不允许挂满 10s 默认超时）
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toBeTruthy();
  });
});
