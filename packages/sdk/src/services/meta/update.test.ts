/**
 * 应用内更新（迁移自 4.5 `scripts/check-app-update.cjs`）。
 *
 * 守四条：草稿/预发布不提示；只有更高版本才算可用；跳转地址永远是本项目的发布页
 * （不信远端给的任何链接）；更新总开关关闭时不发请求。
 */
import { describe, expect, it, vi } from 'vitest';
import { availableRelease, updatesEnabled } from './update.ts';
import { createUpdateInstaller } from './update-installer.ts';

describe('版本判定', () => {
  it('更高版本才算可用', () => {
    expect(availableRelease({ tag_name: 'v1.2.1' }, '1.2.0')?.version).toBe('1.2.1');
    expect(availableRelease({ tag_name: 'v2.0.0' }, '1.2.0')?.version).toBe('2.0');
  });

  it('相同或更低版本都不提示', () => {
    expect(availableRelease({ tag_name: 'v1.2.0' }, '1.2.0')).toBeNull();
    expect(availableRelease({ tag_name: 'v1.1.9' }, '1.2.0')).toBeNull();
    expect(availableRelease({ tag_name: 'v1.2.0' }, '1.2.1')).toBeNull();
  });

  it('草稿与预发布一律忽略', () => {
    expect(availableRelease({ tag_name: 'v9.0.0', draft: true }, '1.2.0')).toBeNull();
    expect(availableRelease({ tag_name: 'v9.0.0', prerelease: true }, '1.2.0')).toBeNull();
  });

  it('版本号无法解析时不提示（不猜）', () => {
    expect(availableRelease({ tag_name: 'nightly' }, '1.2.0')).toBeNull();
    expect(availableRelease({ tag_name: 'v1.2.1' }, 'unknown')).toBeNull();
    expect(availableRelease(null, '1.2.0')).toBeNull();
  });

  it('跳转地址永远指向本项目发布页，忽略远端给的链接', () => {
    const release = availableRelease(
      {
        tag_name: 'v1.2.1',
        html_url: 'https://evil.invalid/payload',
        assets: [{ browser_download_url: 'https://evil.invalid/app.dmg' }],
      },
      '1.2.0',
    );
    expect(release?.url).toBe('https://github.com/jackotom/hongguo-drama/releases/tag/v1.2.1');
    expect(release?.url).not.toContain('evil.invalid');
  });
});

describe('更新总开关', () => {
  it('默认开启，显式 false 才关闭', () => {
    expect(updatesEnabled({})).toBe(true);
    expect(updatesEnabled(undefined)).toBe(true);
    expect(updatesEnabled({ app_updates_enabled: true })).toBe(true);
    expect(updatesEnabled({ app_updates_enabled: false })).toBe(false);
  });
});

describe('不支持的安装形态', () => {
  function makeInstaller(overrides: Record<string, unknown> = {}) {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const updater = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => ({})),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
    };
    const emit = vi.fn();
    const installer = createUpdateInstaller({
      updater,
      currentVersion: '1.2.0',
      isEnabled: () => true,
      installBlocker: () => '',
      emit,
      ...overrides,
    } as never);
    return { installer, updater };
  }

  it('开发运行：状态标记不支持并写清原因', () => {
    const { installer } = makeInstaller({
      supported: false,
      supportedReason: '开发运行时不会自动更新，请使用打包版本。',
    });
    const state = installer.getState() as { supported: boolean; reason: string };
    expect(state.supported).toBe(false);
    expect(state.reason).toMatch(/开发运行/);
  });

  it('开发运行时下载与安装都直接失败，不触达网络', async () => {
    const { installer, updater } = makeInstaller({
      supported: false,
      supportedReason: '开发运行时不会自动更新，请使用打包版本。',
    });
    const download = (await installer.download('2.0')) as { success: boolean; error: string };
    expect(download.success).toBe(false);
    expect(download.error).toMatch(/开发运行/);
    const install = installer.install() as { success: boolean };
    expect(install.success).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('打包运行时默认支持', () => {
    const { installer } = makeInstaller();
    expect((installer.getState() as { supported: boolean }).supported).toBe(true);
  });
});
