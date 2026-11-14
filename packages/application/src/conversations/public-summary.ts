import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';

const invalid = () =>
  new DomainError(
    'INVALID_MODEL_OUTPUT',
    '模型公开摘要含疑似受保护内容或无效文本，未保存该片段。',
    422,
  );

/** Validate the accumulated public block before the next delta is persisted or exposed. */
export function assertPublicSummaryText(previous: string, delta: string): void {
  if (previous.length + delta.length > 100_000) throw invalid();
  const combined = previous + delta;
  for (let index = 0; index < combined.length; index++) {
    const unit = combined.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = combined.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw invalid();
  }
  try {
    assertSafeModelInput(combined);
  } catch {
    throw invalid();
  }
}
