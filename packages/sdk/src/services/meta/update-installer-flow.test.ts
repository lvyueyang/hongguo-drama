/**
 * 应用内更新安装流程（迁移自 4.5 `scripts/check-app-update-installer.cjs`
 * 与 `scripts/check-review-native-2-5.cjs` 的安装重试部分）。
 *
 * 更新会退出应用并替换自身，因此流程里必须守住：
 *   1) feed 固定为本项目仓库，自动下载/自动安装/降级/预发布/差分下载一律关闭；
 *   2) 版本校验不通过（同版、降级、预发布、发布信息变化）绝不下载、绝不安装；
 *   3) 校验和失败、取消、开关关闭、安装忙碌都要能让用户停在原版本；
 *   4) 原生错误只回报可读文案，不把上游诊断（可能带签名地址）泄漏出去；
 *   5) Mac 的原生准备失败后可以**用同一份已校验的下载包**直接重试，且只退出一次。
 */
import { EventEmitter } from 'node:events';
import { MacUpdater } from 'electron-updater/out/MacUpdater';
import { describe, expect, it } from 'vitest';
import { createUpdateInstaller } from './update-installer.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const updater: any = new EventEmitter();
  let enabled = true;
  let blocker = '';
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  let finishCheck: (version?: string) => void = () => {};
  let finishDownload: (error?: Error) => void = () => {};
  const token = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
  };
  updater.setFeedURL = (feed: unknown) => {
    updater.feed = feed;
  };
  updater.checkForUpdates = () => {
    checks++;
    return new Promise((resolve) => {
      finishCheck = (version = '1.81.0') => resolve({ updateInfo: { version }, cancellationToken: token });
    });
  };
  updater.downloadUpdate = (received: unknown) => {
    downloads++;
    expect(received).toBe(token);
    return new Promise((resolve, reject) => {
      finishDownload = (error?: Error) => {
        if (error) {
          updater.emit('error', error);
          reject(error);
        } else {
          updater.emit('update-downloaded', { version: '1.81.0' });
          resolve(['/synthetic/update.zip']);
        }
      };
    });
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const events: any[] = [];
  const controller = createUpdateInstaller({
    updater,
    currentVersion: '1.80.0',
    isEnabled: () => enabled,
    installBlocker: () => blocker,
    emit: (state: any) => events.push(state),
  } as never);
  return {
    updater,
    controller: controller as any,
    events,
    token,
    checked: (version?: string) => finishCheck(version),
    downloaded: (error?: Error) => finishDownload(error),
    counts: () => ({ checks, downloads, installs }),
    enable: (value: boolean) => {
      enabled = value;
    },
    block: (value: string) => {
      blocker = value;
    },
  };
}

/** 用真实的 MacUpdater 原型方法，验证安装器的监听器生命周期与真实现兼容。 */
function macFixture() {
  const f = fixture();
  const native = new EventEmitter() as any;
  let checks = 0;
  let quits = 0;
  f.updater.nativeUpdater = native;
  f.updater.squirrelDownloadedUpdate = false;
  f.updater.autoRunAppAfterInstall = true;
  f.updater.closeServerIfExists = () => {};
  f.updater.handleUpdateDownloaded = (MacUpdater.prototype as any).handleUpdateDownloaded;
  f.updater.quitAndInstall = MacUpdater.prototype.quitAndInstall;
  // 复刻真实 MacUpdater 构造函数注册的监听器。
  native.on('error', (error: Error) => f.updater.emit('error', error));
  native.on('update-downloaded', () => {
    f.updater.squirrelDownloadedUpdate = true;
  });
  native.checkForUpdates = () => {
    checks++;
  };
  native.quitAndInstall = () => {
    quits++;
  };
  return {
    ...f,
    native,
    nativeCounts: () => ({ checks, quits }),
    ready: async () => {
      const pending = f.controller.download('1.81');
      f.checked();
      await tick();
      f.downloaded();
      expect((await pending).success).toBe(true);
    },
  };
}

describe('下载与安装的显式契约', () => {
  it('固定 feed 与关闭自动行为；下载完成不安装', async () => {
    const f = fixture();
    expect(f.updater.autoDownload).toBe(false);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    expect(f.updater.allowDowngrade).toBe(false);
    expect(f.updater.allowPrerelease).toBe(false);
    expect(f.updater.disableWebInstaller).toBe(true);
    expect(f.updater.disableDifferentialDownload).toBe(true);
    expect(f.updater.feed).toEqual({ provider: 'github', owner: 'jackotom', repo: 'hongguo-drama' });
    expect(f.controller.install().success).toBe(false);

    const first = f.controller.download('1.81');
    const duplicate = f.controller.download('1.81');
    expect(f.counts().checks).toBe(1);
    f.checked();
    await tick();
    expect(f.counts().downloads).toBe(1);
    f.updater.emit('download-progress', { percent: 46.7 });
    expect(f.controller.getState().percent).toBe(46);
    f.downloaded();
    expect((await first).success).toBe(true);
    expect((await duplicate).success).toBe(true);
    expect(f.controller.getState().status).toBe('downloaded');
    expect(f.counts().installs, '下载完成本身不能触发安装').toBe(0);
  });

  it('安装忙碌时拒绝，双击只安装一次，原生错误不泄漏诊断', async () => {
    const f = fixture();
    const pending = f.controller.download('1.81');
    f.checked();
    await tick();
    f.downloaded();
    await pending;

    f.block('请先暂停下载');
    expect(f.controller.install().success).toBe(false);
    expect(f.controller.getState().status).toBe('downloaded');
    expect(f.counts().installs).toBe(0);

    f.block('');
    expect(f.controller.install().success).toBe(true);
    expect(f.controller.install().success, '双击不能安装两次').toBe(false);
    await tick();
    expect(f.counts().installs).toBe(1);

    f.updater.emit('error', Error('PRIVATE_NATIVE_DIAGNOSTIC'));
    expect(f.controller.getState().status).toBe('error');
    expect(f.controller.getState().error).not.toContain('PRIVATE_NATIVE_DIAGNOSTIC');
  });
});

describe('版本与完整性校验', () => {
  it('同版、降级、预发布与发布信息变化都不能安装', async () => {
    for (const version of ['1.80.0', '1.79.0', '1.82.0', '1.81.0-beta.1']) {
      const f = fixture();
      const pending = f.controller.download('1.81');
      f.checked(version);
      expect((await pending).success, version).toBe(false);
      expect(f.counts().downloads).toBe(0);
    }
  });

  it('校验和失败不能安装，且错误里不带上游原文', async () => {
    const f = fixture();
    const pending = f.controller.download('1.81');
    f.checked();
    await tick();
    f.downloaded(Error('sha512 mismatch: PRIVATE_URL'));
    expect((await pending).success).toBe(false);
    expect(f.controller.install().success).toBe(false);
    expect(f.counts().installs).toBe(0);
    expect(JSON.stringify(f.events)).not.toContain('PRIVATE_URL');
  });

  it('安装失败后保留已校验的下载包，可直接重试安装而不重新下载', async () => {
    const f = fixture();
    const download = f.controller.download('1.81');
    f.checked();
    await tick();
    f.downloaded();
    await download;

    f.controller.install();
    await tick();
    f.updater.emit('error', Error('install failed'));
    expect(f.controller.install().success, '原生安装失败后应允许直接重试').toBe(true);
    await tick();
    expect(f.counts().installs).toBe(2);
    expect(f.counts().downloads).toBe(1);
    f.controller.cancel();
    expect(f.controller.install().success).toBe(false);
  });
});

describe('开关与取消', () => {
  it('开关关闭时不检查、不下载；检查中取消后迟到结果不能安装', async () => {
    const disabled = fixture();
    disabled.enable(false);
    expect((await disabled.controller.download('1.81')).success).toBe(false);
    expect(disabled.counts().checks).toBe(0);

    const cancelled = fixture();
    const operation = cancelled.controller.download('1.81');
    cancelled.enable(false);
    cancelled.controller.cancel();
    cancelled.checked();
    expect((await operation).success).toBe(false);
    expect(cancelled.counts().downloads).toBe(0);
    expect(cancelled.controller.getState().status).toBe('idle');

    const inFlight = fixture();
    const downloading = inFlight.controller.download('1.81');
    inFlight.checked();
    await tick();
    inFlight.enable(false);
    inFlight.controller.cancel();
    expect(inFlight.token.cancelled).toBe(true);
    inFlight.downloaded();
    expect((await downloading).success).toBe(false);
    expect(inFlight.controller.getState().status).toBe('idle');
    expect(inFlight.controller.install().success).toBe(false);
  });

  it('手动取消返回 idle；迟到事件不能把重试标记成就绪', async () => {
    const f = fixture();
    const oldDownload = f.controller.download('1.81');
    f.checked();
    await tick();
    expect(f.controller.cancel()?.success).toBe(true);
    expect(f.token.cancelled).toBe(true);

    const retry = f.controller.download('1.81');
    f.updater.emit('download-progress', { percent: 99 });
    f.updater.emit('update-downloaded', { version: '1.81.0' });
    expect(f.controller.getState().status).toBe('idle');
    expect(f.controller.install().success).toBe(false);
    expect(f.counts().checks, '重试要等上一次 updater 工作排空').toBe(1);

    f.downloaded(Error('cancelled'));
    expect((await oldDownload).success).toBe(false);
    await tick();
    expect(f.counts().checks, '取消过的工作必须放行新的下载').toBe(2);
    f.checked();
    await tick();
    f.updater.emit('update-downloaded', { version: '1.81.0' });
    expect(f.controller.getState().status, '迟到事件本身不能代表就绪').toBe('downloading');
    expect(f.controller.install().success).toBe(false);
    f.downloaded();
    expect((await retry).success).toBe(true);
    expect(f.controller.getState().status).toBe('downloaded');
  });

  it('取消排队中的重试后不会再启动它', async () => {
    const f = fixture();
    const checking = f.controller.download('1.81');
    f.controller.cancel();
    const queuedRetry = f.controller.download('1.81');
    f.controller.cancel();
    f.checked();
    expect((await checking).success).toBe(false);
    await tick();
    expect(f.counts().checks).toBe(1);
    expect((await queuedRetry).success).toBe(false);
    expect(f.token.cancelled).toBe(true);
  });
});

describe('Mac 原生准备', () => {
  it('等原生签名校验完成后只退出一次，失败可重试', async () => {
    const mac = macFixture();
    await mac.ready();
    mac.controller.install();
    await tick();
    expect(mac.nativeCounts().quits, '必须先等原生校验').toBe(0);
    mac.native.emit('error', Error('native preparation failed'));
    expect(mac.controller.getState().status).toBe('error');

    await mac.ready();
    mac.controller.install();
    await tick();
    mac.native.emit('update-downloaded');
    expect(mac.nativeCounts().checks).toBe(2);
    expect(mac.nativeCounts().quits, '重试原生准备只能退出一次').toBe(1);
    expect(mac.counts().downloads, '安装重试不再下载，复用已校验的包').toBe(1);
  });

  it('原生就绪时复核忙碌状态、取消与同步错误都不能退出', async () => {
    const busy = macFixture();
    await busy.ready();
    busy.controller.install();
    await tick();
    busy.block('正在保存设置');
    busy.native.emit('update-downloaded');
    expect(busy.nativeCounts().quits, '原生就绪要重新检查未完成的工作').toBe(0);
    expect(busy.controller.getState().status).toBe('downloaded');
    busy.block('');
    busy.controller.install();
    await tick();
    expect(busy.nativeCounts().checks, '已校验过的更新不必再次准备').toBe(1);
    expect(busy.nativeCounts().quits).toBe(1);

    const cancelled = macFixture();
    await cancelled.ready();
    cancelled.controller.install();
    await tick();
    cancelled.enable(false);
    cancelled.controller.cancel();
    cancelled.native.emit('update-downloaded');
    expect(cancelled.nativeCounts().quits, '取消后迟到的原生就绪不能安装').toBe(0);
    expect(cancelled.controller.getState().status).toBe('idle');

    const throwing = macFixture();
    await throwing.ready();
    throwing.native.checkForUpdates = () => {
      throw Error('native preparation unavailable');
    };
    throwing.controller.install();
    await tick();
    throwing.native.emit('update-downloaded');
    expect(throwing.controller.getState().status).toBe('error');
    expect(throwing.nativeCounts().quits, '同步失败必须撤销延迟安装').toBe(0);

    // 同步失败后可以重新安装（不需要重新下载）。
    throwing.native.checkForUpdates = () => {};
    expect(throwing.controller.install().success, '同步准备失败必须可重试').toBe(true);
    await tick();
    throwing.native.emit('update-downloaded');
    expect(throwing.nativeCounts().quits).toBe(1);
    expect(throwing.counts().downloads).toBe(1);
  });
});

describe('同步检查失败', () => {
  it('不会把已完成的下载操作锁死', async () => {
    const f = fixture();
    let checks = 0;
    f.updater.checkForUpdates = () => {
      checks++;
      throw Error('synchronous check failure');
    };
    expect((await f.controller.download('1.81')).success).toBe(false);
    expect((await f.controller.download('1.81')).success).toBe(false);
    expect(checks).toBe(2);
  });
});
