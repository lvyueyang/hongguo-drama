/**
 * 账号会话（迁移自 4.5 `src/native/account-session.test.cjs`）。
 *
 * 三件事必须钉死：
 * 1. **凭证不出内存**：cookie 只能进加密文件与 HTTPS 请求头，绝不进渲染层返回值；
 * 2. **缓存资料先给界面**：上次登录的昵称要在会话校验之前就能显示，不能让用户在启动时干等；
 * 3. **观看记录保留精度**：19 位编号按字符串传递、封面换成可显示的格式、按更新时间倒序去重。
 * 网络与落盘都是替身；资料目录用临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preserveLargeJsonIntegers } from '../hongguo-app/ticket.ts';
import {
  createAccountService,
  parseHistory,
  parsePassportProfile,
  parseQr,
  safeMessage,
  secureSessionStore,
} from './account.ts';

const IDENTITY = {
  device_id: '7000000000000000001',
  iid: '7000000000000000002',
  cdid: '00000000-0000-4000-8000-000000000003',
};

/** 与真实 safeStorage 一样「只能通过它自己解密」，明文永远不会落地。 */
function fakeEncryption() {
  const key = Buffer.from('hongguo-account-fixture');
  const transform = (value: Buffer) =>
    Buffer.from(value).map((byte, index) => byte ^ key[index % key.length]);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => transform(Buffer.from(value, 'utf8')),
    // Buffer.prototype.map 返回 Uint8Array，要包回 Buffer 才能按 utf8 解码
    decryptString: ((value: Buffer) => Buffer.from(transform(value)).toString('utf8')) as never,
  };
}

const response = (data: unknown) => ({
  status: 200,
  headers: {},
  data: typeof data === 'string' ? data : JSON.stringify(data),
});
const webPayload = (data: unknown) => response({ message: 'success', data });

const storageRow = (overrides: Record<string, unknown> = {}) => ({
  book_id: '1001',
  book_id_str: '1001',
  book_name: '春日来信',
  thumb_url: 'https://p9-reading-sign.fqnovelpic.com/novel-pic/cover~tplv-shrink:1200:0.heic?x=1',
  vid: '9001',
  vid_index: 3,
  current_play_position: 45000,
  duration: 90000,
  episode_cnt: 24,
  read_timestamp_ms: 1700000000000,
  ...overrides,
});

// account.ts 会打印扫码进度日志：测试里静音，避免淹没失败信息。
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

let dirs: string[] = [];
function tempSession(content?: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-cases-'));
  dirs.push(root);
  const filePath = path.join(root, 'account-session.bin');
  if (content) secureSessionStore({ filePath, safeStorage: fakeEncryption() }).save(content);
  return { root, filePath };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('观看记录解析', () => {
  it('保留当前 APP 行：标题、集数、可显示封面与秒级进度', () => {
    const rows = parseHistory({
      message: 'SUCCESS',
      data: {
        data_list: [
          storageRow(),
          { book_id: '1002', book_name: '旧剧', vid: '9002', vid_index: 1, read_timestamp_ms: 1800000000000 },
          { book_id: 'bad', vid: '9003' },
          { book_id: '1003', book_name: '已删除', vid: '9004', is_delete: true },
        ],
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].series_id).toBe('1002');
    const kept = rows.find((row) => row.series_id === '1001') as any;
    expect(kept.currentTime).toBe(45);
    expect(kept.duration).toBe(90);
    expect(kept.series_title).toBe('春日来信');
    expect(kept.total).toBe(24);
    expect(kept.cover).toBe('https://p3-novel.byteimg.com/novel-pic/cover~tplv-shrink:320:0.webp');
  });

  it('同一部剧只留最新一条，且列表按更新时间倒序', () => {
    const rows = parseHistory({
      message: 'SUCCESS',
      data: {
        data_list: [
          storageRow({ vid: '9001', read_timestamp_ms: 1700000000000 }),
          storageRow({ vid: '9002', read_timestamp_ms: 1800000000000 }),
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].episode_id).toBe('9002');
  });

  it('记录格式变化时报错，而不是返回空列表', () => {
    expect(() => parseHistory({ message: 'SUCCESS', data: {} })).toThrow(/格式已变化/);
    expect(() => parseHistory(null as never)).toThrow(/格式异常/);
  });

  it('19 位分集编号按字符串保留，不被 JSON 数字精度截断', () => {
    const raw = '{"vid":7390123456789012345,"other":7390123456789012345}';
    const preserved = preserveLargeJsonIntegers(raw, ['vid']) as string;
    expect(JSON.parse(preserved).vid).toBe('7390123456789012345');
    expect(typeof JSON.parse(preserved).other).toBe('number');
  });
});

describe('二维码与账号资料', () => {
  it('二维码直接给出可渲染的 data URL，不暴露 cookie', () => {
    const qr = parseQr({
      message: 'success',
      data: { token: 'fixture-token', qrcode: 'iVBORw0KGgo=', expire_time: 180 },
    });
    expect(qr.token).toBe('fixture-token');
    expect(qr.image).toMatch(/^data:image\/png;base64,/);
    expect(qr.expiresIn).toBe(180);
    expect(JSON.stringify(qr)).not.toMatch(/cookie|session/i);
  });

  it('账号编号非法时拒绝，昵称为空时兜底成「红果用户」', () => {
    // 这三个函数吃的是 webJson 已经解析好的 JSON，不是 HTTP 响应外壳。
    expect(
      parsePassportProfile({ message: 'success', data: { user_id_str: '42', name: '<b>测试</b>账号' } }),
    ).toEqual({
      id: '42',
      nickname: '测试账号',
    });
    expect(parsePassportProfile({ message: 'success', data: { user_id_str: '42' } }).nickname).toBe(
      '红果用户',
    );
    for (const data of [{}, { user_id_str: '0' }, { user_id_str: 'abc' }]) {
      expect(() => parsePassportProfile({ message: 'success', data })).toThrow();
    }
  });

  it('错误文案里不出现地址与 cookie 值', () => {
    const message = safeMessage(
      new Error('GET https://passport.example/x?sessionid=private-session failed: sessionid=private-session'),
    );
    expect(message).not.toMatch(/https?:\/\//);
    expect(message).not.toMatch(/private-session/);
    expect(message).toMatch(/\[地址\]/);
  });
});

describe('会话文件：只在加密可用时读写', () => {
  it('落盘的字节里没有原始 cookie，读回来与写入一致，清除后文件消失', () => {
    const { filePath } = tempSession();
    const store = secureSessionStore({ filePath, safeStorage: fakeEncryption() });
    const session = {
      cookie: 'sessionid=private-fixture',
      deviceId: '1',
      installId: '2',
      cdid: '00000000-0000-4000-8000-000000000003',
    };
    store.save(session);
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('private-fixture');
    expect(store.load()).toEqual(session);
    store.clear();
    expect(fs.existsSync(filePath)).toBe(false);
    store.clear();
  });

  it('系统安全存储不可用时拒绝读写，而不是退化成明文', () => {
    const { filePath } = tempSession();
    const unavailable = { isEncryptionAvailable: () => false } as never;
    expect(() => secureSessionStore({ filePath, safeStorage: unavailable }).save({ cookie: 'a=b' })).toThrow(
      /安全存储不可用/,
    );
    expect(fs.existsSync(filePath)).toBe(false);
    secureSessionStore({ filePath, safeStorage: fakeEncryption() }).save({ cookie: 'a=b' });
    expect(() => secureSessionStore({ filePath, safeStorage: unavailable }).load()).toThrow(/安全存储不可用/);
  });
});

describe('恢复登录态', () => {
  it('先返回缓存资料，后台校验完成后才更新（不让用户在启动时干等）', async () => {
    const { filePath } = tempSession({
      cookie: 'sessionid=private-fixture',
      deviceId: IDENTITY.device_id,
      installId: IDENTITY.iid,
      cdid: IDENTITY.cdid,
      profile: { id: '42', nickname: '缓存账号' },
    });
    let finishVerification!: (value: unknown) => void;
    let verified = false;
    const service = createAccountService({
      filePath,
      safeStorage: fakeEncryption(),
      webRequest: () => {
        verified = true;
        return new Promise((resolve, reject) => {
          finishVerification = resolve;
          // 校验失败不能抹掉缓存资料（只有明确的会话过期才清）
          setTimeout(() => reject(new Error('temporary network failure')), 0);
        });
      },
    } as never);
    const status = await service.status();
    expect(status.signedIn).toBe(true);
    expect(status.account.nickname).toBe('缓存账号');
    expect(verified).toBe(true);
    finishVerification(webPayload({ user_id_str: '42', name: '新昵称' }));
  });

  it('明确会话过期时清掉本地登录态并通知宿主', async () => {
    const { filePath } = tempSession({
      cookie: 'sessionid=private-fixture',
      deviceId: IDENTITY.device_id,
      installId: IDENTITY.iid,
      cdid: IDENTITY.cdid,
      profile: { id: '42', nickname: '缓存账号' },
    });
    const onAccountExpired = vi.fn();
    const service = createAccountService({
      filePath,
      safeStorage: fakeEncryption(),
      webRequest: async () => response({ message: 'FAIL', data: { description: '登录态未通过验证' } }),
      onAccountExpired,
    } as never);
    expect((await service.status()).signedIn).toBe(true);
    await vi.waitFor(() => expect(onAccountExpired).toHaveBeenCalledTimes(1));
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('没有会话文件时是未登录而不是报错', async () => {
    const { filePath } = tempSession();
    const service = createAccountService({ filePath, safeStorage: fakeEncryption() } as never);
    expect(await service.status()).toEqual({ success: true, signedIn: false, account: null });
    expect(await service.history()).toEqual({ success: true, signedIn: false, account: null, results: [] });
    expect(await service.refreshHistory()).toEqual({
      success: true,
      signedIn: false,
      account: null,
      results: [],
    });
    expect(service.row('1001')).toBeNull();
  });
});

describe('扫码登录全流程', () => {
  it('验证账号、载入 APP 历史，且凭证不出现在返回值里', async () => {
    const { filePath } = tempSession();
    const webCalls: Array<{ url: string; cookie: string }> = [];
    const accountCalls: Array<{ url: string; options: any }> = [];
    let activeVerifications = 0;
    let peakVerifications = 0;
    const enter = () => {
      activeVerifications += 1;
      peakVerifications = Math.max(peakVerifications, activeVerifications);
    };
    const leave = () => {
      activeVerifications -= 1;
    };

    const webRequest = async (url: string, options: any) => {
      webCalls.push({ url, cookie: options.headers.Cookie || '' });
      if (url.includes('/passport/web/get_qrcode/')) {
        return {
          status: 200,
          headers: { 'set-cookie': ['passport_csrf_token=csrf-fixture; Path=/; Secure'] },
          data: JSON.stringify({
            message: 'SUCCESS',
            data: { token: 'login-token', qrcode: 'iVBORw0KGgo=', expire_time: 180 },
          }),
        };
      }
      if (url.includes('/passport/web/check_qrconnect/')) {
        return response({
          message: 'SUCCESS',
          data: { status: '3', redirect_url: '/passport/web/redirect' },
        });
      }
      if (url.includes('/passport/web/redirect')) {
        return {
          status: 200,
          headers: { 'set-cookie': ['sessionid=private-session; Path=/; Secure'] },
          data: 'ok',
        };
      }
      if (url.includes('/passport/account/info/v2/')) {
        enter();
        await new Promise((resolve) => setTimeout(resolve, 30));
        leave();
        return response({ message: 'SUCCESS', data: { user_id_str: '42', name: '测试账号' } });
      }
      throw new Error(`Unexpected website request: ${url}`);
    };
    const accountRequest = async (url: string, options: any) => {
      accountCalls.push({ url, options });
      expect(options.preserveLargeIntegerFields).toEqual(['vid', 'video_id', 'item_id']);
      if (url.includes('/reading/bookapi/read_history/list/v1/')) {
        return {
          code: 0,
          data: { data_list: [storageRow({ cover: undefined, thumb_url: 'https://img.example/test.jpg' })] },
        };
      }
      throw new Error(`Unexpected account request: ${url}`);
    };
    const service = createAccountService({
      filePath,
      safeStorage: fakeEncryption(),
      webRequest,
      accountRequest,
      identityRequest: async () => {
        enter();
        await new Promise((resolve) => setTimeout(resolve, 30));
        leave();
        return IDENTITY;
      },
    } as never);

    const started = await service.startLogin();
    expect(started.success).toBe(true);
    expect(started.image).toMatch(/^data:image\/png;base64,/);

    const signedIn = (await service.pollLogin(started.loginId)) as any;
    expect(signedIn.status).toBe('signed-in');
    expect(signedIn.account.nickname).toBe('测试账号');
    expect(JSON.stringify(signedIn)).not.toMatch(/private-session|private-fixture|login-token/);

    const history = await service.history({ refresh: true });
    expect(history.results).toHaveLength(1);
    expect((service.row('1001') as any).episode_id).toBe('9001');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('private-session');
    expect(webCalls.some((call) => call.cookie.includes('passport_csrf_token=csrf-fixture'))).toBe(true);
    expect(
      webCalls.some(
        (call) =>
          call.url.includes('/passport/account/info/v2/') &&
          call.cookie.includes('sessionid=private-session'),
      ),
    ).toBe(true);
    // 设备身份与账号验证是并行的，不是串行等两次往返
    expect(peakVerifications).toBe(2);
    expect(accountCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('扫码状态：未确认是 pending、超时或扫码失效是 expired，过期后不接受轮询', async () => {
    const { filePath } = tempSession();
    let status = '1';
    let clock = 1_700_000_000_000;
    const service = createAccountService({
      filePath,
      safeStorage: fakeEncryption(),
      now: () => clock,
      webRequest: async (url: string) => {
        if (url.includes('/passport/web/get_qrcode/'))
          return webPayload({ token: 'token', qrcode: 'iVBORw0KGgo=', expire_time: 180 });
        return webPayload({ status });
      },
      identityRequest: async () => IDENTITY,
    } as never);
    const started = await service.startLogin();
    expect(await service.pollLogin(started.loginId)).toMatchObject({ status: 'pending' });
    status = '5';
    expect(await service.pollLogin(started.loginId)).toMatchObject({ status: 'expired' });
    await expect(service.pollLogin(started.loginId)).rejects.toThrow(/扫码会话已失效/);

    const again = await service.startLogin();
    clock += 181_000;
    expect(await service.pollLogin(again.loginId)).toMatchObject({ status: 'expired' });
    const third = await service.startLogin();
    expect(service.cancelLogin(third.loginId)).toEqual({ success: true });
    await expect(service.pollLogin(third.loginId)).rejects.toThrow(/扫码会话已失效/);
  });

  it('加密不可用时登录仍成功，但明确告知只保留到应用退出', async () => {
    const { filePath } = tempSession();
    const service = createAccountService({
      filePath,
      safeStorage: { isEncryptionAvailable: () => false },
      webRequest: async (url: string) => {
        if (url.includes('/passport/web/get_qrcode/')) {
          return {
            status: 200,
            headers: { 'set-cookie': ['passport_csrf_token=csrf; Path=/'] },
            data: JSON.stringify({
              message: 'SUCCESS',
              data: { token: 'token', qrcode: 'iVBORw0KGgo=', expire_time: 180 },
            }),
          };
        }
        if (url.includes('/passport/web/check_qrconnect/')) {
          return response({
            message: 'SUCCESS',
            data: { status: '3', redirect_url: '/passport/web/redirect' },
          });
        }
        if (url.includes('/passport/web/redirect')) {
          return {
            status: 200,
            headers: { 'set-cookie': ['sessionid=private-session; Path=/'] },
            data: 'ok',
          };
        }
        return webPayload({ user_id_str: '42', name: '测试账号' });
      },
      identityRequest: async () => IDENTITY,
    } as never);
    const started = await service.startLogin();
    const signedIn = (await service.pollLogin(started.loginId)) as any;
    expect(signedIn.status).toBe('signed-in');
    expect(signedIn.storageWarning).toMatch(/只保留到应用退出/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
