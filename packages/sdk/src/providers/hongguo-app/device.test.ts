/**
 * 匿名设备身份的更新语义（迁移自 4.5 `scripts/check-app-source-recovery.cjs` 的设备部分）。
 *
 * 为什么这些细节重要：设备更新是"上游偶发返空"的唯一恢复手段，但更新过头会污染搜索与账号身份，
 * 所以必须做到「只在该更新时更新一次、并发共享、迟到不覆盖、失败保留旧身份」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 设备身份是模块级单例：每个用例都要拿一份干净模块，否则上一个用例的注册结果会串进来。
async function freshDevice() {
  vi.resetModules();
  const module = await import('./device.ts');
  return {
    getPlaybackDevice: module.getPlaybackDevice,
    registerPlaybackDevice: module.registerPlaybackDevice,
  };
}

interface Identity {
  device_id: string;
  iid: string;
  cdid: string;
}

function identity(seed: number): Identity {
  return {
    device_id: `100000000000000${String(seed).padStart(4, '0')}`,
    iid: `200000000000000${String(seed).padStart(4, '0')}`,
    cdid: `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`,
  };
}

/** 造一个假注册接口：每次调用返回一份新身份。 */
function registrationStub(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const requestJson = vi.fn(async (url: string) => {
    calls.push(url);
    if (options.fail) throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
    const next = identity(calls.length);
    return { code: 0, device_id_str: next.device_id, install_id_str: next.iid, cdid: next.cdid };
  });
  return { requestJson, calls };
}

beforeEach(() => {
  vi.resetModules();
});

describe('匿名设备注册', () => {
  it('拒绝非零业务码或缺少身份字段的响应', async () => {
    const { registerPlaybackDevice } = await freshDevice();
    const requestJson = vi.fn(async () => ({ code: 1, device_id_str: '1', install_id_str: '2' }));
    await expect(registerPlaybackDevice(requestJson as never)).rejects.toMatchObject({
      code: 'DEVICE_REGISTRATION_FAILED',
    });

    const partial = vi.fn(async () => ({ code: 0, device_id_str: '1000000000000001', install_id_str: '' }));
    await expect(registerPlaybackDevice(partial as never)).rejects.toMatchObject({
      code: 'DEVICE_REGISTRATION_FAILED',
    });
  });

  it('注册请求不携带任何 cookie 或账号痕迹', async () => {
    const { registerPlaybackDevice } = await freshDevice();
    const requestJson = vi.fn(async () => {
      return {
        code: 0,
        device_id_str: '1000000000000001',
        install_id_str: '2000000000000001',
        cdid: 'x'.repeat(36),
      };
    });
    await registerPlaybackDevice(requestJson as never);
    const options = (
      requestJson.mock.calls as unknown as Array<[string, { headers: Record<string, string> }]>
    )[0]?.[1] as {
      headers: Record<string, string>;
    };
    expect(options.headers.Cookie).toBeUndefined();
    expect(Object.keys(options.headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });
});

describe('设备更新：只在必要时、且只更新一次', () => {
  it('传入被拒身份时更新一次并返回新身份', async () => {
    const { getPlaybackDevice } = await freshDevice();
    const { requestJson, calls } = registrationStub();
    const first = (await getPlaybackDevice(requestJson as never)) as Identity;
    expect(calls).toHaveLength(1);

    const renewed = (await getPlaybackDevice(requestJson as never, first)) as Identity;
    expect(calls).toHaveLength(2);
    expect(renewed.device_id).not.toBe(first.device_id);
  });

  it('并发上报同一个被拒身份时只更新一次', async () => {
    const { getPlaybackDevice } = await freshDevice();
    const { requestJson, calls } = registrationStub();
    const first = (await getPlaybackDevice(requestJson as never)) as Identity;
    const results = await Promise.all([
      getPlaybackDevice(requestJson as never, first),
      getPlaybackDevice(requestJson as never, first),
      getPlaybackDevice(requestJson as never, first),
    ]);
    expect(calls).toHaveLength(2);
    expect(new Set(results.map((item) => (item as Identity).device_id)).size).toBe(1);
  });

  it('迟到的旧身份上报不会触发第二次更新', async () => {
    const { getPlaybackDevice } = await freshDevice();
    const { requestJson, calls } = registrationStub();
    const first = (await getPlaybackDevice(requestJson as never)) as Identity;
    const renewed = (await getPlaybackDevice(requestJson as never, first)) as Identity;
    const again = (await getPlaybackDevice(requestJson as never, first)) as Identity;
    // 已换新身份，旧身份的迟到失败只应拿到当前身份，不再更新
    expect(again.device_id).toBe(renewed.device_id);
    expect(calls).toHaveLength(2);
  });

  it('冷却期内不重复更新', async () => {
    const { getPlaybackDevice } = await freshDevice();
    const { requestJson, calls } = registrationStub();
    const first = (await getPlaybackDevice(requestJson as never)) as Identity;
    await getPlaybackDevice(requestJson as never, first);
    const renewedCalls = calls.length;
    // 第二次上报"当前身份"仍在冷却窗口内
    const current = (await getPlaybackDevice(requestJson as never)) as Identity;
    await getPlaybackDevice(requestJson as never, current);
    expect(calls.length).toBe(renewedCalls);
  });

  it('更新失败时保留旧身份并抛错（不静默换身份）', async () => {
    const { getPlaybackDevice } = await freshDevice();
    const ok = registrationStub();
    const first = (await getPlaybackDevice(ok.requestJson as never)) as Identity;

    const failing = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
    });
    await expect(getPlaybackDevice(failing as never, first)).rejects.toMatchObject({
      code: 'DEVICE_REGISTRATION_FAILED',
    });
    // 失败后仍能拿到身份（realpath: 继续使用旧的注册结果）
    const after = (await getPlaybackDevice(ok.requestJson as never)) as Identity;
    expect(after.device_id).toBe(first.device_id);
  });
});
