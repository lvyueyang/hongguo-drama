/**
 * 清晰度档位选择与降级变体（迁移自 4.5 `scripts/check-download-quality.cjs` 的取源部分）。
 *
 * 规则本体（短边判定、auto 不设下限）在 `shared/src/quality.test.ts` 与
 * `services/media/quality.test.ts` 已有覆盖；这里守的是**取源时的档位决策**：
 *   1) 显式档位按实测宽高判定，标签（1080p/720p）不能作数；
 *   2) 够用就取最小档，同档内 H.264 优先（HEVC 只在没有 H.264 时使用）；
 *   3) auto = 「取能给的最好」，并且不跨档回退到更低分辨率的另一版；
 *   4) 下载允许降级时保留全部更低档，顺序从高到低，绝不悄悄换档。
 */
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ requests: [] as any[] }));

vi.mock('axios', () => ({ default: vi.fn() }));
vi.mock('./device.ts', () => ({
  getPlaybackDevice: async () => ({
    device_id: '7000000000000000001',
    iid: '7000000000000000002',
    cdid: '00000000-0000-4000-8000-000000000003',
  }),
  registerPlaybackDevice: async () => ({}),
}));

const axios = (await import('axios')).default as unknown as ReturnType<typeof vi.fn>;
const { fetchAppPlayUrl } = await import('./ticket.ts');

const media = (name: string) => `https://v3-reading.qznovelvod.com/${name}.mp4`;
const keyHex = '0123456789abcdef0123456789abcdef';

/** 内联片源必须带解密信息；这里给一份合法 spade_a（密钥固定）。 */
function encodedKey(): string {
  const plain = Buffer.from(`0${keyHex}`);
  const raw = Buffer.alloc(34);
  const previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    const pop = i.toString(2).split('1').length - 1;
    raw[i + 1] = ((plain[i]! + 21 + pop) & 255) ^ previous[i & 1]!;
    previous[i & 1] = raw[i + 1]!;
  }
  raw[0] = 48 ^ raw[1]! ^ raw[2]!;
  return raw.toString('base64');
}

const stream = (name: string, width: number, height: number, codecType = 'h264') => ({
  main_url: media(name),
  width,
  height,
  codec_type: codecType,
  definition: '1080p',
  spade_a: encodedKey(),
});

/** 只喂一页内联片源，其余请求一律空响应。 */
function rowsFixture(rows: unknown[]) {
  harness.requests = [];
  axios.mockReset();
  axios.mockImplementation(async (config: any) => {
    harness.requests.push(config);
    if (config.method === 'POST')
      return {
        status: 200,
        headers: {},
        data: JSON.stringify({
          code: 0,
          data: { '11': { video_model: JSON.stringify({ video_list: rows }) } },
        }),
      };
    return { status: 200, headers: {}, data: '{}' };
  });
  return (options?: any) => fetchAppPlayUrl('11', options);
}

describe('显式档位', () => {
  it('允许降级时保留全部更低档，按分辨率从高到低', async () => {
    const fetch = rowsFixture([
      stream('360', 360, 640),
      stream('720', 720, 1280),
      stream('1080', 1080, 1920),
      stream('480', 480, 854),
    ]);
    const result = await fetch({ quality: '1080p', allowLowerQuality: true });
    expect(result.variants.map((item: any) => item.url)).toEqual(['1080', '720', '480', '360'].map(media));
    expect(result.variants[1].quality).toBe('720p');
    // 首选仍是最高档。
    expect(result.url).toBe(media('1080'));
  });

  it('只有更低档可用时如实给出该档，不伪称 1080p', async () => {
    const result = await rowsFixture([stream('480', 480, 854)])({
      quality: '1080p',
      allowLowerQuality: true,
    });
    expect(result.quality).toBe('480p');
    expect(result.url).toBe(media('480'));
  });

  it('假 1080p 标签不能冒充：只有 720 像素就失败', async () => {
    await expect(rowsFixture([stream('fake', 720, 1280)])()).resolves.toBeTruthy();
    const fetch = rowsFixture([stream('fake', 720, 1280)]);
    await expect(fetch({ quality: '1080p' })).rejects.toThrow(/1080p/);
  });

  it('按实测尺寸判断，并如实回报宽高', async () => {
    const result = await rowsFixture([stream('fake', 720, 1280), stream('true', 1080, 1920, 'hevc')])({
      quality: '1080p',
    });
    expect(result.url).toBe(media('true'));
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.quality).toBe('1080p');
  });

  it('720p 取「够用的最小档」，同档内 H.264 优先', async () => {
    const avc = {
      main_url: media('avc'),
      video_meta: { codec_type: 'h264', vwidth: 720, vheight: 1280 },
      spade_a: encodedKey(),
    };
    const result = await rowsFixture([stream('high', 1080, 1920), stream('hevc', 720, 1280, 'hevc'), avc])({
      quality: '720p',
    });
    expect(result.url).toBe(media('avc'));

    // 只有更高档时用更高的那一路（不能因为「没有正好 720」就失败）。
    const higher = await rowsFixture([stream('high', 1440, 2560)])({ quality: '1080p' });
    expect(higher.url).toBe(media('high'));
  });

  it('没有可用地址或不支持的编码在显式档位下失败', async () => {
    for (const rows of [
      // 有行但没有可用地址
      [{ spade_a: encodedKey() }],
      [stream('bad', 1080, 1920, 'bytevc2')],
      // 既没有实测尺寸也没有标签
      [{ main_url: media('nolabel'), codec_type: 'h264', spade_a: encodedKey() }],
    ]) {
      await expect(rowsFixture(rows)({ quality: '1080p' })).rejects.toThrow(/1080p/);
    }
  });

  // 与 4.5 的行为差异（见迁移报告，未改源码）：4.5 的 meetsDownloadQuality 只认实测宽高，
  // 尺寸未知的行会被拒；5.0 的短边判定在缺宽高时回退到 row.pixels，而取源层把
  // 「1080p」这类标签喂给了 pixels，于是尺寸未知也能通过 1080p 档位。
  it('尺寸未知但标签写着 1080p：5.0 目前信任标签', async () => {
    const result = await rowsFixture([stream('unknown', 0, 0)])({ quality: '1080p' });
    expect(result.url).toBe(media('unknown'));
    expect(result.quality).toBe('1080p');
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

describe('auto', () => {
  it('H.264 优先，且接受缺尺寸的旧数据', async () => {
    const rows = [
      stream('high', 1080, 1920, 'hevc'),
      { main_url: media('low'), codec_type: 'h264', quality_desc: '720P', spade_a: encodedKey() },
    ];
    for (const options of [undefined, { quality: 'auto' }]) {
      const result = await rowsFixture(rows)(options);
      expect(result.url).toBe(media('low'));
      expect(result.quality).toBe('720P');
    }
  });

  it('标签缺失或夸大时按实际尺寸挑，且不跨档保留更低版本', async () => {
    for (const label of ['1080p', '']) {
      const result = await rowsFixture([
        { ...stream('low', 360, 640), definition: label },
        { ...stream('high', 1920, 1080), definition: '720p' },
      ])();
      expect(result.url, label).toBe(media('high'));
      expect(result.variants.map((item: any) => item.url)).toEqual([media('high')]);
    }
  });

  it('video_meta 里的尺寸同样参与判定', async () => {
    const result = await rowsFixture([
      {
        main_url: media('low'),
        video_meta: { codec_type: 'h264', vwidth: 360, vheight: 640 },
        spade_a: encodedKey(),
      },
      {
        main_url: media('high'),
        video_meta: { codec_type: 'h264', vwidth: 1080, vheight: 1920 },
        spade_a: encodedKey(),
      },
    ])();
    expect(result.url).toBe(media('high'));
  });

  it('脏清晰度按 auto 处理（4.5 的拒绝已前移到契约层）', async () => {
    const rows = [stream('one', 1080, 1920)];
    const auto = await rowsFixture(rows)();
    const dirty = await rowsFixture(rows)({ quality: '4k' });
    expect(dirty.url).toBe(auto.url);
  });
});
