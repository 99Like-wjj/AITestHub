import type { ClientFailure } from './ports.js';

export class LocalClientError extends Error implements ClientFailure {
  readonly name = 'LocalClientError';
  constructor(
    readonly code: string,
    readonly certainty: ClientFailure['certainty'],
    message: string,
    identity?: { fileId?: string; localFileId?: string },
  ) {
    super(message);
    if (identity?.fileId !== undefined) this.fileId = identity.fileId;
    if (identity?.localFileId !== undefined)
      this.localFileId = identity.localFileId;
  }
  readonly fileId?: string;
  readonly localFileId?: string;
}
const knownFailed = new Set([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'STALE_BASE_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'BUSINESS_CONFLICT',
  'PRECONDITIONS_MISSING',
  'FILE_TOO_LARGE',
  'FILE_HASH_MISMATCH',
  'FILE_NOT_READY',
  'UNSUPPORTED_OPERATION',
  'UNSUPPORTED_SCHEMA_VERSION',
  'KEY_REVOKED',
  'DEPENDENCY_NOT_CONFIGURED',
]);
export function platformFailure(code: unknown): LocalClientError {
  const safe =
    typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)
      ? code
      : 'INVALID_PLATFORM_FAILURE';
  return new LocalClientError(
    safe,
    knownFailed.has(safe) ? 'knownFailed' : 'unknown',
    '平台返回错误；保留原操作身份并按实际确定性处理。',
  );
}
export const localFailure = (code: string, message: string) =>
  new LocalClientError(code, 'notDispatched', message);
