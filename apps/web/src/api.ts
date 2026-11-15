import type { z } from 'zod';
import {
  announceIdentityChange,
  identityContextEpoch,
  currentIdentityOwner,
  identityRecheckPending,
} from './identity-context';
import {
  makeIdentityCommand,
  retainIdentityCommand,
  resolveIdentityCommand,
  uncertainIdentityCommand,
} from './identity-commands';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryAfter: string | null = null,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isUncertainMutationError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.status === 0 ||
      error.status >= 500 ||
      error.code === 'OPERATION_RESULT_UNKNOWN')
  );
}

function errorObject(value: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
  details?: Record<string, unknown>;
} {
  if (typeof value !== 'object' || value === null || !('error' in value))
    return {};
  const error = value.error;
  if (typeof error !== 'object' || error === null) return {};
  const meta =
    'meta' in value && typeof value.meta === 'object' && value.meta !== null
      ? value.meta
      : null;
  return {
    ...('details' in error &&
    typeof error.details === 'object' &&
    error.details !== null &&
    !Array.isArray(error.details)
      ? { details: Object.fromEntries(Object.entries(error.details)) }
      : {}),
    ...('code' in error && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
    ...('message' in error && typeof error.message === 'string'
      ? { message: error.message }
      : {}),
    ...('requestId' in error && typeof error.requestId === 'string'
      ? { requestId: error.requestId }
      : meta && 'requestId' in meta && typeof meta.requestId === 'string'
        ? { requestId: meta.requestId }
        : {}),
  };
}

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  rawBody?: Blob;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export function api<T>(
  path: string,
  options: ApiOptions,
  schema: z.ZodType<T>,
): Promise<T>;
export function api(path: string, options?: ApiOptions): Promise<unknown>;
export async function api(
  path: string,
  options: ApiOptions = {},
  schema?: z.ZodType,
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const startingIdentity = identityContextEpoch();
  if (
    method !== 'GET' &&
    !path.startsWith('/auth/') &&
    identityRecheckPending()
  )
    throw new ApiError(
      '正在核对当前身份，本次操作尚未发出，请稍后再明确提交。',
      409,
      'IDENTITY_RECHECK_PENDING',
    );
  const originalCommand = makeIdentityCommand(
    currentIdentityOwner(),
    path,
    method,
    options.body,
  );
  if (originalCommand && !retainIdentityCommand(originalCommand))
    throw new ApiError(
      '原提交待核对或浏览器恢复记录不可用，本次未发送；请先核对原回执或恢复本地存储。',
      409,
      'ORIGINAL_COMMAND_UNRESOLVED',
    );
  const changesIdentity =
    method === 'POST' &&
    [
      '/auth/login',
      '/auth/logout',
      '/auth/reset-password',
      '/me/password',
    ].includes(path);
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? (options.rawBody ? 180_000 : 30_000),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method === 'GET' ? {} : { 'X-ATH-CSRF': '1' }),
        ...(options.rawBody === undefined
          ? {}
          : { 'Content-Type': 'application/octet-stream' }),
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
      signal,
    });
  } catch (error) {
    if (originalCommand) uncertainIdentityCommand(originalCommand);
    if (changesIdentity) announceIdentityChange();
    if (
      options.signal?.aborted &&
      error instanceof DOMException &&
      error.name === 'AbortError'
    )
      throw error;
    throw new ApiError(
      method === 'GET'
        ? '无法连接服务。请检查本地服务后重新加载。'
        : '未收到操作回执。操作结果尚未确认，请先刷新查看当前状态，避免重复提交。',
      0,
      'NETWORK_UNCONFIRMED',
    );
  }
  const responseStatus = response.status;
  if (changesIdentity && (response.ok || responseStatus >= 500))
    announceIdentityChange();
  let value: unknown;
  if (responseStatus !== 204) {
    try {
      value = await response.json();
    } catch {
      if (response.ok) {
        if (originalCommand) uncertainIdentityCommand(originalCommand);
        throw new ApiError(
          method === 'GET'
            ? '服务响应未完整读取，请重新加载。'
            : '操作回执未完整读取，结果尚未确认，请先刷新查看当前状态。',
          0,
          'RESPONSE_UNCONFIRMED',
        );
      }
    }
  }
  if (!changesIdentity && startingIdentity !== identityContextEpoch()) {
    if (originalCommand) uncertainIdentityCommand(originalCommand);
    throw new ApiError(
      method === 'GET'
        ? '当前身份已变化，旧读取结果未采用。'
        : '当前身份已变化，原操作可能已被受理。请切回原身份核对原命令，不重复提交。',
      method === 'GET' ? 409 : 0,
      'IDENTITY_CONTEXT_CHANGED',
    );
  }
  if (!response.ok) {
    const error = errorObject(value);
    if (
      responseStatus === 401 &&
      !options.signal?.aborted &&
      !path.startsWith('/auth/') &&
      path !== '/me'
    ) {
      window.dispatchEvent(new Event('aitesthub:session-expired'));
    }
    const failure = new ApiError(
      error.message ?? `请求未完成（HTTP ${responseStatus}）`,
      responseStatus,
      error.code ?? 'HTTP_ERROR',
      error.requestId,
      response.headers?.get('Retry-After') ?? null,
      error.details,
    );
    if (originalCommand) {
      if (isUncertainMutationError(failure))
        uncertainIdentityCommand(originalCommand);
      else resolveIdentityCommand(originalCommand);
    }
    throw failure;
  }
  if (schema) {
    const result = schema.safeParse(value);
    if (!result.success) {
      if (originalCommand) uncertainIdentityCommand(originalCommand);
      throw new ApiError(
        '服务返回内容与当前契约不匹配，请刷新后查看服务版本。',
        502,
        'RESPONSE_SCHEMA_MISMATCH',
      );
    }
    if (originalCommand) resolveIdentityCommand(originalCommand);
    return result.data;
  }
  if (originalCommand) resolveIdentityCommand(originalCommand);
  return value;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ''}`;
  return error instanceof Error
    ? error.message
    : '操作未完成，请重新加载后查看状态。';
}
