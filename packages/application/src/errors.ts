import type { ErrorCode } from '../../contracts/src/base.js';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}

export function stale(): never {
  throw new DomainError(
    'STALE_BASE_REVISION',
    '资料已被修改，请刷新比较后重新提交。',
    412,
  );
}

export function forbidden(): never {
  throw new DomainError('FORBIDDEN', '当前账号无权执行此操作。', 403);
}
