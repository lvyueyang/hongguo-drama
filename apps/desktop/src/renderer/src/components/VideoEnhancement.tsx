/**
 * 画质增强（迁移自 4.5 `src/components/VideoEnhancement.jsx`）。
 *
 * 交互与提示语沿用 4.5：三档模式、锐化强度可调、Anime4K 注明"适合动漫、1080p 以下"，
 * 失败必须说"已恢复原画"而不是静默黑屏。
 */

import { Card, CardContent, CardHeader, CardTitle } from '@hongguo/ui';
import { useEffect, useId, useRef, useState } from 'react';
import {
  checkAnime4kAvailability,
  createAnime4KRenderer,
  ENHANCEMENT_MODES,
  type EnhancementMode,
  type EnhancementSettings,
  normalizeEnhancement,
  sharpenKernel,
} from '../lib/video-enhancement.ts';

const STORAGE_KEY = 'hongguo:video-enhancement';
export const ENHANCEMENT_LABELS: Record<EnhancementMode, string> = {
  original: '原画',
  sharpen: '锐化',
  anime4k: 'Anime4K 2×',
};

/** 增强设置（渲染层本地保存：只影响播放画面，不涉及账号与下载）。 */
export function useEnhancementSettings(): {
  settings: EnhancementSettings;
  update(patch: Partial<EnhancementSettings>): void;
  saveError: boolean;
} {
  const [settings, setSettings] = useState<EnhancementSettings>(() => {
    try {
      return normalizeEnhancement(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
    } catch {
      return normalizeEnhancement(null);
    }
  });
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }, [settings]);
  return {
    settings,
    update: (patch) => setSettings((current) => normalizeEnhancement({ ...current, ...patch })),
    saveError,
  };
}

export function EnhancementControls({
  settings,
  update,
  available = true,
  saveError = false,
  status = '',
}: {
  settings: EnhancementSettings;
  update(patch: Partial<EnhancementSettings>): void;
  available?: boolean;
  saveError?: boolean;
  status?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>画质增强</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center justify-between gap-2 text-[var(--font-size-label)]">
          <span className="text-secondary-text">模式</span>
          <select
            aria-label="画质增强"
            className="h-8 rounded-[var(--radius-control)] border border-border-subtle bg-surface px-2"
            value={settings.mode}
            disabled={!available}
            onChange={(event) => update({ mode: event.target.value as EnhancementMode })}
          >
            {ENHANCEMENT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {ENHANCEMENT_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        {settings.mode === 'sharpen' && (
          <label className="flex items-center justify-between gap-2 text-[var(--font-size-label)]">
            <span className="text-secondary-text">锐化强度</span>
            <input
              aria-label="锐化强度"
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.strength}
              disabled={!available}
              onChange={(event) => update({ strength: Number(event.target.value) })}
            />
            <output className="w-10 text-right">{settings.strength}%</output>
          </label>
        )}
        <p className="text-[var(--font-size-caption)] text-muted">只增强播放画面，下载文件保持原画。</p>
        {settings.mode === 'anime4k' && (
          <p className="text-[var(--font-size-caption)] text-muted">
            适合动漫；支持 1080p 及以下片源，真人画面可能偏平滑。
          </p>
        )}
        {status && (
          <p className="text-[var(--font-size-caption)] text-secondary-text" role="status">
            {status}
          </p>
        )}
        {saveError && (
          <p className="text-[var(--font-size-caption)] text-secondary-text" role="status">
            设置未能保存，下次打开可能恢复默认。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 把增强效果套到 `<video>` 上：锐化用 SVG 卷积 filter，Anime4K 用叠加的 WebGPU canvas。
 * 失败一律回退原画并给出原因。
 */
export default function VideoEnhancement({
  video,
  settings,
  available = true,
  onStatus,
}: {
  video: HTMLVideoElement | null;
  settings: EnhancementSettings;
  available?: boolean;
  onStatus?(message: string): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const filterId = `video-sharpen-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    if (!video || !available || settings.mode === 'original') return;
    const original = video.style.filter;
    if (settings.mode === 'sharpen') {
      video.style.filter = `url(#${filterId})`;
      onStatus?.('锐化已开启');
      return () => {
        video.style.filter = original;
      };
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let renderer: { draw(): Promise<boolean>; dispose(): void } | null = null;
    let frame = 0;
    const availability = checkAnime4kAvailability({
      hasWebGpu: Boolean((navigator as { gpu?: unknown }).gpu),
      width: video.videoWidth,
      height: video.videoHeight,
    });
    if (!availability.ok) {
      onStatus?.(availability.reason);
      return;
    }
    void createAnime4KRenderer(video, canvas, {
      signal: controller.signal,
      onError: (message) => onStatus?.(message),
    })
      .then((created) => {
        renderer = created;
        canvas.style.visibility = 'visible';
        onStatus?.('Anime4K 已开启');
        const loop = (): void => {
          if (!renderer) return;
          void renderer
            .draw()
            .then(() => {
              frame = requestAnimationFrame(loop);
            })
            .catch((error: Error) => {
              onStatus?.(`${error.message}`);
              renderer?.dispose();
              renderer = null;
              canvas.style.visibility = 'hidden';
            });
        };
        frame = requestAnimationFrame(loop);
      })
      .catch((error: Error) => onStatus?.(error.message));
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
      renderer?.dispose();
      canvas.style.visibility = 'hidden';
    };
  }, [video, settings.mode, available, filterId, onStatus]);

  return (
    <>
      <svg aria-hidden="true" className="absolute h-0 w-0">
        <filter id={filterId}>
          <feConvolveMatrix
            order="3"
            preserveAlpha="true"
            kernelMatrix={sharpenKernel(settings.strength).join(' ')}
          />
        </filter>
      </svg>
      {settings.mode === 'anime4k' && (
        // 增强画面纯装饰，不接收焦点也不进无障碍树
        <canvas
          ref={canvasRef}
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ visibility: 'hidden' }}
        />
      )}
    </>
  );
}
