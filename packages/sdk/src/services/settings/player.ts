/**
 * 播放器设置校验（迁移自 4.5 `main.js: applyEditableSettings` 的画中画部分）。
 *
 * 4.5 允许 `picture_in_picture_mode` 取 `native`（系统画中画）或 `custom`（应用自己的悬浮窗）。
 * 非法值必须**明确报错**，不能静默退回默认——静默回退会让用户以为设置生效了。
 *
 * 这里的枚举与 `@hongguo/contract` 的同名 schema 保持一致（SDK 不依赖 contract，
 * 依赖方向是 contract → sdk；两处同步改动需一起 review）。
 */
import { z } from 'zod';

export const pictureInPictureModeSchema = z.enum(['native', 'custom']);
export type PictureInPictureMode = z.infer<typeof pictureInPictureModeSchema>;

export const floatingSizeSchema = z.object({
  width: z.number().int().min(180).max(900),
  height: z.number().int().min(240).max(1600),
});

export interface PlayerSettingsInput {
  picture_in_picture_mode?: unknown;
  floating_player_size?: unknown;
}

export interface PlayerSettings {
  picture_in_picture_mode: PictureInPictureMode;
  floating_player_size?: { width: number; height: number };
}

export function normalizePlayerSettings(input: PlayerSettingsInput = {}): PlayerSettings {
  const result: PlayerSettings = { picture_in_picture_mode: 'native' };
  if (input?.picture_in_picture_mode !== undefined) {
    const parsed = pictureInPictureModeSchema.safeParse(input.picture_in_picture_mode);
    if (!parsed.success) {
      throw new Error('画中画模式只能是 native（系统画中画）或 custom（悬浮小窗）');
    }
    result.picture_in_picture_mode = parsed.data;
  }
  if (input?.floating_player_size !== undefined) {
    const parsed = floatingSizeSchema.safeParse(input.floating_player_size);
    if (!parsed.success) throw new Error('悬浮窗尺寸超出允许范围');
    result.floating_player_size = parsed.data;
  }
  return result;
}
