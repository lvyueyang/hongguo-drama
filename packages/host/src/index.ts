/**
 * 宿主能力接口：SDK 与主进程只依赖这里的抽象，不直接依赖 Electron。
 *
 * 这样做的两个直接收益（见 docs/refactor-plan.md）：
 * - 测试可以注入 host-fake，不再需要每个脚本自己手写假 Electron；
 * - SDK 可以在纯 Node（CLI/脚本）下复用。
 */

export type Platform = 'darwin' | 'win32' | 'linux';

export interface AppInfo {
  name: string;
  version: string;
  platform: Platform;
  architecture: string;
}

export interface Logger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface FileSystem {
  exists(file: string): boolean;
  readText(file: string): string;
  readBuffer(file: string): Buffer;
  writeText(file: string, content: string, options?: { mode?: number }): void;
  remove(file: string): void;
  ensureDir(dir: string): void;
  list(dir: string): string[];
  stat(file: string): { size: number; mtimeMs: number };
}

export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SecretStore {
  /** 系统安全存储是否可用；不可用时宿主降级为「仅本次运行」并提示用户。 */
  canEncrypt(): boolean;
  save(blob: Buffer): void;
  load(): Buffer | null;
  clear(): void;
}

/** 媒体请求出口：Electron 用 net（复用系统代理与会话），纯 Node 用 axios/fetch。 */
export interface HttpTransport {
  request(
    url: string,
    options: Record<string, unknown>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface FfmpegTools {
  ffmpeg(): string | null;
  ffprobe(): string | null;
  /** 内置 FFmpeg 没有 HTTP 传输能力，HLS 必须先在宿主侧落盘。 */
  supportsHttp: boolean;
}

export interface WindowControls {
  setTitle(title: string): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setAlwaysOnTop(value: boolean): void;
  setLayout(layout: 'landscape' | 'portrait'): void;
  openExternal(url: string): Promise<void>;
}

export interface HostServices {
  app(): AppInfo;
  /** 交给系统浏览器打开外部链接（导航守卫判定为 external 时调用） */
  openExternal(url: string): Promise<void>;
  userDataDir(): string;
  downloadsDir(): string;
  temporaryDir(): string;
  logger(): Logger;
  fs(): FileSystem;
  clock(): Clock;
  secretStore(): SecretStore;
  /** 媒体/目录请求出口；可能为 undefined（纯 Node 环境下由 SDK 回退 axios）。 */
  netTransport?(): unknown;
  /** 内置 ffmpeg/ffprobe 路径（打包后在 resources/bin）。 */
  ffmpeg(): FfmpegTools | null;
  /** 仅在具备真实窗口时存在。 */
  windows?: WindowControls;
}
export * from './proxy.ts';
export * from './tools.ts';
