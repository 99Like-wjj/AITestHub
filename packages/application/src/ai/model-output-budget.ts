import { maximumNativeModelOutputTokens } from '../../../model-adapters/src/index.js';
import { modelOutputContextIssue } from '../../../contracts/src/model-protocol.js';
import { DomainError } from '../errors.js';

/** Explicit model limit for chat; auxiliary callers may retain their separate approved purpose budget. */
export function resolveModelOutputBudget(
  model: { maxOutput: number | null; contextLimit: number | null },
  purposeMaximum?: number,
): number {
  if (
    (model.maxOutput !== null &&
      (!Number.isSafeInteger(model.maxOutput) || model.maxOutput < 1)) ||
    (model.contextLimit !== null &&
      (!Number.isSafeInteger(model.contextLimit) || model.contextLimit < 1)) ||
    (purposeMaximum !== undefined &&
      (!Number.isSafeInteger(purposeMaximum) || purposeMaximum < 1))
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '模型输出或上下文预算必须为有效正安全整数；未发送请求。',
      422,
    );
  const configured = model.maxOutput ?? 4096;
  const budget =
    purposeMaximum === undefined
      ? configured
      : Math.min(configured, purposeMaximum);
  if (budget > maximumNativeModelOutputTokens)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      `当前输出预算超过原生协议适配器的${maximumNativeModelOutputTokens}上限；请明确调整配置，未静默截断或发送。`,
      422,
    );
  const issue = modelOutputContextIssue(budget, model.contextLimit);
  if (issue) throw new DomainError('PRECONDITIONS_MISSING', issue, 422);
  return budget;
}
