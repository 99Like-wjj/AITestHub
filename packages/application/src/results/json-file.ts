import { DomainError } from '../errors.js';
import { assertSafeResultContent } from './safety.js';
import { parseStrictJsonText } from '../../../contracts/src/safe-json.js';
const hardByteLimit = 16 * 1024 * 1024;
const invalid = () =>
  new DomainError(
    'VALIDATION_ERROR',
    '结果文件须为无重复字段、结构受限且已脱敏的完整UTF-8 JSON。',
    400,
  );
/** Check the original bytes and decoded structure without retaining or echoing rejected content. */
export function parseSafeResultJson(
  bytes: Uint8Array,
  maxBytes = hardByteLimit,
): unknown {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    bytes.byteLength > Math.min(maxBytes, hardByteLimit)
  )
    throw invalid();
  try {
    // Windows UTF-8 BOM remains accepted; the caller verifies the original byte SHA.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assertSafeResultContent(text);
    const parsed = parseStrictJsonText(text);
    assertSafeResultContent(parsed);
    return parsed;
  } catch {
    throw invalid();
  }
}
