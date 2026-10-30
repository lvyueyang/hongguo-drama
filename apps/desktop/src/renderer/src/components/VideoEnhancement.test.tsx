/**
 * 画质增强（迁移自 4.5 `src/components/VideoEnhancement.jsx`）。
 *
 * 守四条：模式枚举与强度收敛；Anime4K 的环境/尺寸前置检查给出人话原因；
 * 锐化真的改到 video 的 filter；没有 WebGPU 时回退原画并提示。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkAnime4kAvailability,
  ENHANCEMENT_MODES,
  MAX_ANIME4K_PIXELS,
  normalizeEnhancement,
  sharpenKernel,
} from '../lib/video-enhancement.ts';
import VideoEnhancement, { EnhancementControls, useEnhancementSettings } from './VideoEnhancement.tsx';

afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

describe('增强设置归一', () => {
  it('只接受三档模式，非法值回到原画', () => {
    expect(ENHANCEMENT_MODES).toEqual(['original', 'sharpen', 'anime4k']);
    expect(normalizeEnhancement({ mode: 'anime4k' }).mode).toBe('anime4k');
    expect(normalizeEnhancement({ mode: 'nope' }).mode).toBe('original');
    expect(normalizeEnhancement(null).mode).toBe('original');
  });

  it('强度限定 0..100，非法值回到 50', () => {
    expect(normalizeEnhancement({ strength: 130 }).strength).toBe(100);
    expect(normalizeEnhancement({ strength: -20 }).strength).toBe(0);
    expect(normalizeEnhancement({ strength: 'abc' }).strength).toBe(50);
    expect(normalizeEnhancement({}).strength).toBe(50);
  });

  it('锐化核是中心加强、四周取负的 3×3 卷积', () => {
    const kernel = sharpenKernel(50);
    expect(kernel).toHaveLength(9);
    expect(kernel[4]).toBeGreaterThan(1);
    expect(kernel[1]).toBeLessThan(0);
    expect(kernel[0]).toBe(0);
    // 强度越高中心权重越大
    expect(sharpenKernel(100)[4]).toBeGreaterThan(sharpenKernel(10)[4]);
  });
});

describe('Anime4K 前置检查', () => {
  it('没有 WebGPU 时明确说明并建议锐化', () => {
    const result = checkAnime4kAvailability({ hasWebGpu: false, width: 1920, height: 1080 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/WebGPU/);
  });

  it('画面尺寸未就绪时提示稍后重试', () => {
    const result = checkAnime4kAvailability({ hasWebGpu: true, width: 0, height: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/尚未准备好/);
  });

  it('超过 1080p 时拒绝并说明原因（不偷偷降级）', () => {
    const result = checkAnime4kAvailability({ hasWebGpu: true, width: 3840, height: 2160 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/1080p/);
    expect(1920 * 1080).toBe(MAX_ANIME4K_PIXELS);
  });

  it('条件满足时通过', () => {
    expect(checkAnime4kAvailability({ hasWebGpu: true, width: 1280, height: 720 }).ok).toBe(true);
  });
});

describe('增强开关界面', () => {
  it('三档模式可选，切到锐化时才显示强度', () => {
    const update = vi.fn();
    const { rerender } = render(
      <EnhancementControls settings={{ mode: 'original', strength: 50 }} update={update} />,
    );
    const select = screen.getByLabelText('画质增强') as HTMLSelectElement;
    expect(select.value).toBe('original');
    expect(screen.queryByLabelText('锐化强度')).toBeNull();

    fireEvent.change(select, { target: { value: 'sharpen' } });
    expect(update).toHaveBeenCalledWith({ mode: 'sharpen' });

    rerender(<EnhancementControls settings={{ mode: 'sharpen', strength: 50 }} update={update} />);
    const range = screen.getByLabelText('锐化强度') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '80' } });
    expect(update).toHaveBeenCalledWith({ strength: 80 });
  });

  it('Anime4K 档位有"适合动漫、1080p 以下"的说明', () => {
    render(<EnhancementControls settings={{ mode: 'anime4k', strength: 50 }} update={() => {}} />);
    expect(screen.getByText(/适合动漫；支持 1080p 及以下片源/)).toBeTruthy();
    expect(screen.getByText('只增强播放画面，下载文件保持原画。')).toBeTruthy();
  });

  it('设置保存失败时给出可见提示', () => {
    render(<EnhancementControls settings={{ mode: 'sharpen', strength: 50 }} update={() => {}} saveError />);
    expect(screen.getByText(/设置未能保存/)).toBeTruthy();
  });

  it('不可用时禁用控件而不是假装可选', () => {
    render(
      <EnhancementControls
        settings={{ mode: 'sharpen', strength: 50 }}
        update={() => {}}
        available={false}
      />,
    );
    expect((screen.getByLabelText('画质增强') as HTMLSelectElement).disabled).toBe(true);
  });
});

// 组件必须在模块作用域定义：测试里也不允许在函数内定义组件。
function Harness() {
  const enhancement = useEnhancementSettings();
  return <EnhancementControls settings={enhancement.settings} update={enhancement.update} />;
}

describe('设置持久化', () => {
  it('选择写入 localStorage，下次打开沿用', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('画质增强'), { target: { value: 'sharpen' } });
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('hongguo:video-enhancement') ?? '{}').mode).toBe(
        'sharpen',
      ),
    );
  });

  it('存储里的脏数据不会让设置页崩', () => {
    window.localStorage.setItem('hongguo:video-enhancement', '{ not json');
    render(<Harness />);
    expect((screen.getByLabelText('画质增强') as HTMLSelectElement).value).toBe('original');
  });
});

describe('叠加层', () => {
  it('锐化模式改 video 的 filter，关闭后恢复原样', () => {
    const video = document.createElement('video');
    video.style.filter = 'brightness(1.2)';
    const { rerender, unmount } = render(
      <VideoEnhancement video={video} settings={{ mode: 'sharpen', strength: 60 }} />,
    );
    // 浏览器会把 url(#id) 规范成 url("#id")，只断言指向了锐化 filter
    expect(video.style.filter).toContain('video-sharpen-');
    rerender(<VideoEnhancement video={video} settings={{ mode: 'original', strength: 60 }} />);
    expect(video.style.filter).toBe('brightness(1.2)');
    unmount();
  });

  it('原画模式不动 video，也不加任何叠加层', () => {
    const video = document.createElement('video');
    const onStatus = vi.fn();
    const { container } = render(
      <VideoEnhancement video={video} settings={{ mode: 'original', strength: 50 }} onStatus={onStatus} />,
    );
    expect(video.style.filter).toBe('');
    expect(container.querySelector('canvas')).toBeNull();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('没有 WebGPU 时回退原画并说明原因', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
    const onStatus = vi.fn();
    render(
      <VideoEnhancement video={video} settings={{ mode: 'anime4k', strength: 50 }} onStatus={onStatus} />,
    );
    await waitFor(() => expect(onStatus).toHaveBeenCalled());
    expect(String(onStatus.mock.calls[0]?.[0])).toMatch(/WebGPU/);
  });
});
