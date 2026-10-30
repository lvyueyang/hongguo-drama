/**
 * 本地播放的能力地址（迁移自 4.5 `scripts/check-media-access.cjs`）。
 *
 * 渲染层拿到的必须是不可猜的随机 id，而不是磁盘路径；CORS 只认应用自身来源。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMediaAccess } from './media-access.ts';

const devUrl = 'http://localhost:5173';

function request(origin: string | null, initiatorOrigin = origin ?? undefined) {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'origin' ? origin : null) },
    initiatorOrigin,
  } as never;
}

describe('media access 能力地址', () => {
  it('同一文件返回稳定 id，且 id 不是路径', () => {
    const media = createMediaAccess(devUrl);
    const file = path.resolve('sample.mp4');
    const url = media.localUrl(file);
    expect(media.localUrl(file)).toBe(url);
    expect(url.startsWith('hongguo-local://f/')).toBe(true);
    expect(url).not.toContain(file);
  });

  it('只按 id 反查，不做路径回退', () => {
    const media = createMediaAccess(devUrl);
    const file = path.resolve('sample.mp4');
    const url = media.localUrl(file);
    expect(media.resolveLocal(url)).toBe(file);

    // 把路径直接编码进 URL 不能命中
    expect(media.resolveLocal(`hongguo-local://f/${Buffer.from(file).toString('base64url')}`)).toBeNull();
    // 带查询参数、换主机名、未知 id 都不命中
    expect(media.resolveLocal(`${url}?path=other`)).toBeNull();
    expect(media.resolveLocal(url.replace('://f/', '://other/'))).toBeNull();
    expect(media.resolveLocal('hongguo-local://f/00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('CORS 只放行应用自身来源', () => {
    const media = createMediaAccess(devUrl);
    expect(media.corsHeaders(request('null'))?.['Access-Control-Allow-Origin']).toBe('null');
    expect(media.corsHeaders(request(devUrl))?.['Access-Control-Allow-Origin']).toBe(devUrl);
    expect(media.corsHeaders(request('https://untrusted.example'))).toBeNull();
  });

  it('origin 与 initiator 不一致时拒绝（防伪造发起方）', () => {
    const media = createMediaAccess(devUrl);
    expect(media.corsHeaders(request('null', 'https://untrusted.example'))).toBeNull();
    expect(media.corsHeaders(request(devUrl, 'null'))).toBeNull();
  });

  it('clear 后 id 立即失效', () => {
    const media = createMediaAccess(devUrl);
    const file = path.resolve('sample.mp4');
    const url = media.localUrl(file);
    media.clear();
    expect(media.resolveLocal(url)).toBeNull();
  });
});
