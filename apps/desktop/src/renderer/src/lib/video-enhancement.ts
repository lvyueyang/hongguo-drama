/**
 * 画质增强（迁移自 4.5 `src/videoEnhancement.js`）。
 *
 * 三档：原画 / 锐化（CSS+SVG 卷积）/ Anime4K 2×（WebGPU）。
 * 关键约定与 4.5 一致：
 * - **只增强播放画面，下载文件保持原画**；
 * - Anime4K 限 1080p 及以下（约束显存），超过就明确拒绝而不是偷偷降级；
 * - 任何 GPU 失败都要给出"已恢复原画"的人话提示，并让调用方回退。
 *
 * 纯逻辑（模式归一、锐化核）在本文件顶部，WebGPU 部分靠动态 import，
 * 因此没有 WebGPU 的环境（含测试）也能加载本模块。
 */

export const ENHANCEMENT_MODES = ['original', 'sharpen', 'anime4k'] as const;
export type EnhancementMode = (typeof ENHANCEMENT_MODES)[number];

export interface EnhancementSettings {
  mode: EnhancementMode;
  strength: number;
}

export function normalizeEnhancement(value: unknown): EnhancementSettings {
  const raw = (value ?? {}) as { mode?: unknown; strength?: unknown };
  const strength = Number(raw.strength);
  const mode = ENHANCEMENT_MODES.includes(raw.mode as EnhancementMode)
    ? (raw.mode as EnhancementMode)
    : 'original';
  return {
    mode,
    strength: Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) : 50,
  };
}

/** 3×3 锐化卷积核（中心权重随强度增加，四周取负）。 */
export function sharpenKernel(strength: unknown): number[] {
  const amount = (normalizeEnhancement({ strength }).strength / 100) * 0.7;
  return [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];
}

export const MAX_ANIME4K_PIXELS = 1920 * 1080;

/** Anime4K 的前置条件检查：环境/尺寸不合适时给出可直接展示的原因。 */
export function checkAnime4kAvailability(options: { hasWebGpu: boolean; width: number; height: number }): {
  ok: boolean;
  reason: string;
} {
  if (!options.hasWebGpu) return { ok: false, reason: '此运行环境未开放 WebGPU；已恢复原画，可使用锐化' };
  if (!options.width || !options.height) return { ok: false, reason: '视频画面尚未准备好，请稍后重新启用' };
  if (options.width * options.height > MAX_ANIME4K_PIXELS) {
    return { ok: false, reason: 'Anime4K 暂支持 1080p 及以下片源；已恢复原画' };
  }
  return { ok: true, reason: '' };
}

const DISPLAY_SHADER = `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let p = positions[index];
  return Vertex(vec4f(p, 0, 1), vec2f((p.x + 1) * 0.5, (1 - p.y) * 0.5));
}
@group(0) @binding(0) var imageSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  return vec4f(textureSample(image, imageSampler, input.uv).rgb, 1);
}`;

export interface Anime4kRenderer {
  draw(): Promise<boolean>;
  dispose(): void;
}

/**
 * 建立 Anime4K 渲染器。失败时抛错（调用方负责回退到原画并提示）。
 * 所有 GPU 资源都挂在同一个 device 上，dispose 时一起释放。
 */
export async function createAnime4KRenderer(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options: { signal: AbortSignal; onError(message: string): void },
): Promise<Anime4kRenderer> {
  const gpu = (navigator as { gpu?: GPU }).gpu;
  const availability = checkAnime4kAvailability({
    hasWebGpu: Boolean(gpu),
    width: video.videoWidth,
    height: video.videoHeight,
  });
  if (!availability.ok || !gpu) throw new Error(availability.reason);
  const width = video.videoWidth;
  const height = video.videoHeight;
  const { CNNx2M } = await import('anime4k-webgpu');
  if (options.signal.aborted) throw new Error('已取消');

  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('当前显卡无法启用 WebGPU；已恢复原画，可使用锐化');
  const device = await adapter.requestDevice();

  let disposed = false;
  let context: GPUCanvasContext | null = null;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener('abort', dispose);
    context?.unconfigure();
    device.destroy();
  };
  if (options.signal.aborted) {
    dispose();
    throw new Error('已取消');
  }
  options.signal.addEventListener('abort', dispose, { once: true });

  device.lost.then((info) => {
    if (!disposed) options.onError(`显卡增强已停止（${info.reason}）；已恢复原画`);
  });

  try {
    context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('无法创建增强画面；已恢复原画');
    const input = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const anime = new CNNx2M({ device, inputTexture: input });
    const output = anime.getOutputTexture();
    canvas.width = output.width;
    canvas.height = output.height;
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: DISPLAY_SHADER });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 1, resource: output.createView() },
      ],
    });

    let slowFrames = 0;
    return {
      dispose,
      async draw(): Promise<boolean> {
        if (disposed || video.readyState < 2 || video.seeking) return false;
        if (video.videoWidth !== width || video.videoHeight !== height) {
          throw new Error('片源尺寸发生变化，请重新启用 Anime4K');
        }
        const started = performance.now();
        device.queue.copyExternalImageToTexture({ source: video }, { texture: input }, [width, height]);
        const encoder = device.createCommandEncoder();
        anime.pass(encoder);
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: (context as GPUCanvasContext).getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        slowFrames = performance.now() - started > 150 ? slowFrames + 1 : 0;
        if (slowFrames >= 5) throw new Error('当前设备增强较慢；已恢复原画，可改用锐化');
        return !disposed;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
