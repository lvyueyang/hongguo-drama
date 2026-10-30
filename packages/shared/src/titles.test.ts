import { describe, expect, it } from 'vitest';
import { rankSearchResults } from './titles.ts';

describe('rankSearchResults', () => {
  it('全角标点与空格不影响标题命中', () => {
    const rows = rankSearchResults(
      [
        { series_id: '1', series_title: '言出法随，诸天万界', source: 'hongguo' },
        {
          series_id: '2',
          series_title: '无关剧名',
          series_intro: '言出法随，诸天万界的由来',
          source: 'hongguo',
        },
      ],
      '言出法随 诸天万界',
    );
    expect(rows[0]?.series_id).toBe('1');
    expect(rows[0]?.relevance).toBe(0);
    expect(rows[1]?.relevance).toBe(2);
  });

  it('按 source+series_id 去重并丢弃缺字段的行', () => {
    const rows = rankSearchResults(
      [
        { series_id: '9', series_title: '同名剧', source: 'xifan' },
        { series_id: '9', series_title: '同名剧', source: 'xifan' },
        { series_title: '没有 id' },
      ],
      '同名',
    );
    expect(rows).toHaveLength(1);
  });

  it('上新结果的短标题反向命中也算标题命中', () => {
    const rows = rankSearchResults(
      [
        { series_id: '3', series_title: '一村人养一个神', source: 'hongguo', new_release: true },
        { series_id: '4', series_title: '别的东西', source: 'hongguo' },
      ],
      '一村人养一个神第一季',
    );
    expect(rows[0]?.series_id).toBe('3');
    expect(rows[0]?.relevance).toBe(1);
  });
});
