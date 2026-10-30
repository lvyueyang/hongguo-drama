/**
 * 官网目录 SSR 解析（迁移自 4.5 `scripts/check-catalog.cjs`）。
 * 这里验证解析器本身：标记识别、花括号配对（含字符串内的花括号）、异常输入。
 */
import { describe, expect, it } from 'vitest';
import { publicMetadata, readRouterData } from './catalog.ts';

describe('readRouterData：解析 SSR 内嵌数据', () => {
  it('解析 window._ROUTER_DATA，并正确跨过字符串里的花括号', () => {
    const page =
      '<script>window._ROUTER_DATA = {"loaderData":{"detail":{"title":"含 } 与 { 的标题","total":80}}};</script>';
    const data = readRouterData(page) as {
      loaderData?: { detail?: { title?: string; total?: number } };
    };
    expect(data.loaderData?.detail?.title).toBe('含 } 与 { 的标题');
    expect(data.loaderData?.detail?.total).toBe(80);
  });

  it('解析不带 window. 前缀的赋值形式', () => {
    const page = '<script>_ROUTER_DATA = {"a":{"b":1}};</script>';
    const data = readRouterData(page) as { a?: { b?: number } };
    expect(data.a?.b).toBe(1);
  });

  it('页面没有目录数据时给出可读错误，而不是静默返回空', () => {
    expect(() => readRouterData('<html><body>空页面</body></html>')).toThrow(/目录数据/);
  });

  it('数据被截断时不返回半成品', () => {
    expect(() => readRouterData('<script>window._ROUTER_DATA = {"a":{"b":')).toThrow();
  });
});

describe('publicMetadata：完结状态与集数标签', () => {
  it('“全182集 / 已完结”判为 completed', () => {
    expect(publicMetadata({ episode_right_text: '全182集' }).completion_status).toBe('completed');
    expect(publicMetadata({ episode_right_text: '已完结' }).completion_status).toBe('completed');
  });

  it('“更新至30集”判为 ongoing', () => {
    expect(publicMetadata({ episode_right_text: '更新至30集' }).completion_status).toBe('ongoing');
  });

  it('缺失或异常标签不编造状态，标签长度受限', () => {
    expect(publicMetadata({})).toMatchObject({ episode_label: '' });
    const long = publicMetadata({ episode_right_text: '全'.repeat(200) });
    expect(String(long.episode_label).length).toBeLessThanOrEqual(80);
  });
});
