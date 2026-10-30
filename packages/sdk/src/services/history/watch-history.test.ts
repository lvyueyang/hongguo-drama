/**
 * 观看记录与分季（迁移自 4.5 `scripts/check-watch-history*.cjs` 的纯逻辑断言）。
 */
import { describe, expect, it } from 'vitest';
import { listHistory, seasonOf, seasonTitle, sourceOf } from './watch-history.ts';

describe('分季解析', () => {
  it('识别中文季数、阿拉伯数字季与无季', () => {
    expect(seasonTitle('一村人养一个神第二季').season).toBe(2);
    expect(seasonTitle('一村人养一个神 第3季').season).toBe(3);
    expect(seasonTitle('一村人养一个神第十季').season).toBe(10);
    expect(seasonTitle('一村人养一个神').season).toBe(1);
  });

  it('完全免费的剧（无“季”字样）不误判为分季', () => {
    expect(seasonOf({ series_title: '无季剧名' })).toBe(1);
    expect(seasonOf({ series_title: '第一季' })).toBe(1);
  });
});

describe('来源识别', () => {
  it('按前缀区分四个来源', () => {
    expect(sourceOf('7654321098765432109')).toBe('hongguo');
    expect(sourceOf('xifan:abc:def')).toBe('xifan');
    expect(sourceOf('hema:123')).toBe('hema');
    // 自定义源不参与分季家族聚合，sourceOf 对它返回 null（与 4.5 行为一致）
    expect(sourceOf('custom:0b9c1a2e-1111-2222-3333-444455556666')).toBeNull();
  });
});

describe('观看记录列表', () => {
  const series = [
    {
      series_id: '9001',
      series_title: '剧A第一季',
      episodes: [{ vid: '1001', vid_index: 1 }],
      dismissed: false,
    },
  ];

  it('没有播放进度时不出现在记录里', () => {
    expect(listHistory(series as never, {} as never, false)).toHaveLength(0);
  });

  it('有播放进度时按剧聚合，并带上当前集信息', () => {
    const playback = {
      '9001': { vid: '1001', vid_index: 1, currentTime: 30, duration: 100, updatedAt: Date.now() },
    };
    const rows = listHistory(series as never, playback as never, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ series_id: '9001', series_title: '剧A第一季' });
  });
});
