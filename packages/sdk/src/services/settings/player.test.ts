/**
 * 画中画模式设置（迁移自 4.5 `scripts/check-picture-in-picture-mode.cjs` 的设置层断言）。
 *
 * 守两条：枚举只接受 native/custom；非法值必须报错而不是静默退回默认。
 * 悬浮窗尺寸沿用同一套边界，越界同样拒绝。
 */
import { describe, expect, it } from 'vitest';
import { normalizePlayerSettings } from './player.ts';

describe('画中画模式', () => {
  it('接受 native 与 custom，且保留悬浮窗尺寸', () => {
    for (const mode of ['native', 'custom'] as const) {
      const settings = normalizePlayerSettings({
        floating_player_size: { width: 320, height: 500 },
        picture_in_picture_mode: mode,
      });
      expect(settings.picture_in_picture_mode).toBe(mode);
      expect(settings.floating_player_size).toEqual({ width: 320, height: 500 });
    }
  });

  it('缺省为 native（系统画中画）', () => {
    expect(normalizePlayerSettings({}).picture_in_picture_mode).toBe('native');
    expect(normalizePlayerSettings().floating_player_size).toBeUndefined();
  });

  it('非法模式报错，不静默回退', () => {
    expect(() => normalizePlayerSettings({ picture_in_picture_mode: 'invalid' })).toThrow(/画中画/);
    expect(() => normalizePlayerSettings({ picture_in_picture_mode: 'NATIVE' })).toThrow(/画中画/);
    expect(() => normalizePlayerSettings({ picture_in_picture_mode: 1 })).toThrow(/画中画/);
  });

  it('悬浮窗尺寸越界报错', () => {
    expect(() => normalizePlayerSettings({ floating_player_size: { width: 10, height: 500 } })).toThrow(
      /尺寸/,
    );
    expect(() => normalizePlayerSettings({ floating_player_size: { width: 320 } })).toThrow(/尺寸/);
  });
});
