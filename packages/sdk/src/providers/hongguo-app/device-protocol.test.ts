/**
 * 匿名播放设备注册的线上协议（迁移自 4.5 `src/native/playback-device.test.cjs` 的协议部分）。
 *
 * 已有 `device.test.ts` 压的是「更新语义」（该不该换设备、并发共享、失败保留旧身份）。
 * 这里补的是**报文本身**：加密体、固定匿名手机资料、请求头成套、以及绝不出现在报文里的
 * 东西（cookie / 账号 / 登录态）——这些一旦错了，上游拒绝注册，整条 App 链路都没了。
 */
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REGISTER_URL =
  'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const KDF_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
  'hex',
);

async function freshModule() {
  vi.resetModules();
  return import('./device.ts');
}

/** 按注册报文自己的算法解回去，验证「发出去的确实是这份资料」。 */
function decryptRequest(data: Buffer) {
  expect(data.subarray(0, 6).toString('hex')).toBe('746305100000');
  const random = data.subarray(6, 38);
  const derived = crypto
    .createHash('sha512')
    .update(Buffer.concat([crypto.createHash('sha512').update(random).digest(), KDF_SALT]))
    .digest();
  const decipher = crypto.createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plaintext = Buffer.concat([decipher.update(data.subarray(38)), decipher.final()]);
  const compressed = plaintext.subarray(64);
  expect(plaintext.subarray(0, 64)).toEqual(crypto.createHash('sha512').update(compressed).digest());
  expect(compressed.subarray(0, 3).toString('hex')).toBe('1f8b08');
  return JSON.parse(gunzipSync(compressed).toString('utf8'));
}

function registrationStub() {
  return vi.fn(async () => ({
    code: 0,
    device_id: '7000000000000000001',
    install_id: '7000000000000000002',
  }));
}

beforeEach(() => {
  vi.resetModules();
});

describe('注册报文：请求形态', () => {
  it('固定地址、二进制请求体、成套请求头，且不带任何账号痕迹', async () => {
    const { getPlaybackDevice } = await freshModule();
    const requestJson = registrationStub();
    const identity = (await getPlaybackDevice(requestJson as never)) as {
      device_id: string;
      iid: string;
      cdid: string;
    };
    const [url, options, deadline, signal] = (requestJson.mock.calls as unknown as any[][])[0] as [
      string,
      any,
      number,
      AbortSignal,
    ];
    expect(url).toBe(REGISTER_URL);
    expect(options.method).toBe('POST');
    expect(Buffer.isBuffer(options.data)).toBe(true);
    expect(deadline).toBeGreaterThan(Date.now());
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(options.headers['Content-Type']).toBe('application/octet-stream;tt-data=a');
    expect(options.headers['log-encode-type']).toBe('gzip');
    expect(options.headers['x-ss-dp']).toBe('8662');
    expect(options.headers['x-neptune']).toBe('-8|50:51:59:30:40:47:49:39');
    expect(options.headers['x-ss-stub']).toBe(
      crypto.createHash('md5').update(options.data).digest('hex').toUpperCase(),
    );
    expect(options.headers['User-Agent']).toBe(
      'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)',
    );
    for (const name of Object.keys(options.headers)) {
      expect(name, name).not.toMatch(
        /^(?:cookie|authorization|x-gorgon|x-ladon|x-argus|x-medusa|x-khronos)$/i,
      );
    }

    const payload = decryptRequest(options.data as Buffer);
    expect(payload.magic_tag).toBe('ss_app_log');
    expect(payload._gen_time).toBe(Number(options.headers['x-ss-req-ticket']));
    const header = payload.header;
    expect(header).toMatchObject({
      os: 'Android',
      os_version: '16',
      os_api: 36,
      device_model: '25053RT47C',
      device_brand: 'Redmi',
      device_manufacturer: 'Redmi',
      density_dpi: 520,
      display_density: 'mdpi',
      rom: 'eng.root.20231116.160340',
      rom_version: 'W528JS release-keys',
      resolution: '1280x2772',
      version_code: 73932,
      manifest_version_code: 73932,
      update_version_code: 73932,
      cdid: identity.cdid,
      custom: {
        account_region_src: 'fallback',
        account_region: 'cn',
        host_bit: 64,
        dragon_device_type: 'phone',
      },
    });
    expect(header.apk_first_install_time).toBe(payload._gen_time);
    expect(header.device_id).toBeUndefined();
    expect(header.install_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(
      /"(?:account|account_id|user_id|uid|sessionid|session_id|device_token|access_token|refresh_token|cookie|cookies|authorization|password|phone_number)":/i,
    );
  });

  it('身份是冻结的三字段对象，cdid 是本次注册的设备号', async () => {
    const { getPlaybackDevice } = await freshModule();
    const identity = (await getPlaybackDevice(registrationStub() as never)) as any;
    expect(Object.keys(identity).sort()).toEqual(['cdid', 'device_id', 'iid']);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity.cdid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('注册结果：编号校验', () => {
  it('接受正的数字字符串与安全整数，_str 优先且不丢精度', async () => {
    for (const [response, device, install] of [
      [{ device_id: 123, install_id: Number.MAX_SAFE_INTEGER }, '123', String(Number.MAX_SAFE_INTEGER)],
      [
        {
          device_id_str: '9007199254740993',
          install_id_str: '9007199254741993',
          device_id: 1,
          install_id: 2,
        },
        '9007199254740993',
        '9007199254741993',
      ],
      [{ device_id: '1'.repeat(30), install_id: '2'.repeat(30) }, '1'.repeat(30), '2'.repeat(30)],
      [{ device_id_str: '', device_id: '123', install_id_str: null, install_id: 456 }, '123', '456'],
    ] as const) {
      // 注册结果是模块级单例：每行都要一份干净模块，否则会读到上一行的身份。
      const { getPlaybackDevice } = await freshModule();
      const identity = (await getPlaybackDevice(async () => ({ ...response }))) as never as any;
      expect(identity.device_id).toBe(device);
      expect(identity.iid).toBe(install);
    }
  });

  it('零值、不安全整数、畸形或缺失编号一律失败，且不会因为失败而反复注册', async () => {
    const { getPlaybackDevice } = await freshModule();
    for (const value of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '',
      '0',
      '000',
      '1e3',
      ' 123',
      '1'.repeat(31),
      true,
      {},
      undefined,
    ]) {
      for (const name of ['device_id', 'install_id']) {
        const module = await freshModule();
        let calls = 0;
        const requestJson = async () => {
          calls += 1;
          return { device_id: '7000000000000000001', install_id: '7000000000000000002', [name]: value };
        };
        const first = module.getPlaybackDevice(requestJson as never);
        await expect(first).rejects.toMatchObject({ code: 'DEVICE_REGISTRATION_FAILED' });
        expect(module.getPlaybackDevice(requestJson as never)).toBe(first);
        expect(calls, `${name}=${String(value)}`).toBe(1);
      }
    }
    const { getPlaybackDevice: freshDevice } = await freshModule();
    await expect(freshDevice((async () => null) as never)).rejects.toMatchObject({
      code: 'DEVICE_REGISTRATION_FAILED',
    });
  });

  it('业务码非零时即便带着编号也要失败', async () => {
    for (const status of [{ code: 1 }, { Code: 1 }]) {
      const { getPlaybackDevice: register } = await freshModule();
      await expect(
        register((async () => ({
          ...status,
          device_id: '7000000000000000001',
          install_id: '7000000000000000002',
          message: 'PRIVATE_RESPONSE_SENTINEL',
        })) as never),
      ).rejects.toMatchObject({
        code: 'DEVICE_REGISTRATION_FAILED',
        message: '匿名播放设备注册失败，请重启应用后重试',
      });
    }
  });

  it('失败信息里不带上游原文、响应体或异常链', async () => {
    const { getPlaybackDevice } = await freshModule();
    const unsafe = Object.assign(new Error('PRIVATE_RESPONSE_SENTINEL'), {
      code: 'ETIMEDOUT',
      response: { device_token: 'PRIVATE_RESPONSE_SENTINEL' },
    });
    const error = await getPlaybackDevice((async () => {
      throw unsafe;
    }) as never).catch((caught) => caught);
    expect(error.code).toBe('DEVICE_REGISTRATION_FAILED');
    expect(error.message).toBe('匿名播放设备注册失败，请重启应用后重试');
    expect(Object.keys(error)).toEqual(['code']);
    expect(error.cause).toBeUndefined();
    expect(String(error.stack) + JSON.stringify(error)).not.toMatch(/PRIVATE_RESPONSE_SENTINEL/);
  });
});
