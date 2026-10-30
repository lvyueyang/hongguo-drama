/**
 * 统一错误码。SDK 对外只暴露这些值，避免上游 provider 的原始码泄漏。
 */
export const ErrorCodes = {
  INPUT_INVALID: 'INPUT_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  LOCKED: 'LOCKED',
  PREVIEW_ONLY: 'PREVIEW_ONLY',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  NO_COMPATIBLE_VARIANT: 'NO_COMPATIBLE_VARIANT',
  SECURITY_BLOCKED: 'SECURITY_BLOCKED',
  TIMEOUT: 'TIMEOUT',
  CANCELED: 'CANCELED',
  UPSTREAM_SCHEMA: 'UPSTREAM_SCHEMA',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  ACCOUNT_REQUIRED: 'ACCOUNT_REQUIRED',
  ACCOUNT_EXPIRED: 'ACCOUNT_EXPIRED',
  EPISODE_CHANGED: 'EPISODE_CHANGED',
  MEDIA_INCOMPLETE: 'MEDIA_INCOMPLETE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class SdkError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    this.cause = cause;
  }
}

/** 把任意异常收敛为 SdkError，保留既有 code（若已符合枚举）。 */
export function toSdkError(error: unknown, fallback: ErrorCode = ErrorCodes.UNKNOWN): SdkError {
  if (error instanceof SdkError) return error;
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  const raw = (error as { code?: unknown } | null)?.code;
  const code =
    typeof raw === 'string' && (Object.values(ErrorCodes) as string[]).includes(raw)
      ? (raw as ErrorCode)
      : fallback;
  return new SdkError(code, message || '未知错误', error);
}

export type Result<T> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error: { code: ErrorCode; message: string }; meta?: Record<string, unknown> };

export function ok<T>(data: T, meta?: Record<string, unknown>): Result<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

export function fail<T = never>(code: ErrorCode, message: string, meta?: Record<string, unknown>): Result<T> {
  const body = { ok: false as const, error: { code, message } };
  return meta ? { ...body, meta } : body;
}

/** 执行并收敛为 Result，不向外抛。 */
export async function attempt<T>(run: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (error) {
    const normalized = toSdkError(error);
    return fail(normalized.code, normalized.message);
  }
}

/** 脱敏：抹掉 URL 与常见会话参数，用于错误信息外露。 */
export function safeMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return (text || fallback)
    .replace(/https?:\/\/\S+/gi, '[地址]')
    .replace(/(?:sessionid|sid_tt|passport_csrf_token|sessionid_ss)=[^;\s&]+/gi, '$1=[已隐藏]')
    .slice(0, 200);
}
