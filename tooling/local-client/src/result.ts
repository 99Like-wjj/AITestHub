import { z } from 'zod';
import type { ResultPort } from './ports.js';
import { LocalClientError, platformFailure } from './errors.js';
import { assertSafe, canonical } from './safety.js';

const bodySchema = z.union([
  z.strictObject({
    data: z.json(),
    meta: z.object({ requestId: z.string().min(1) }).passthrough(),
  }),
  z.strictObject({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
        recovery: z.string().optional(),
      })
      .strict(),
    meta: z.object({ requestId: z.string().min(1) }).passthrough(),
  }),
]);
export class OfficialResultPort implements ResultPort {
  assertSafe(value: unknown): void {
    assertSafe(value);
  }
  read(raw: unknown): unknown {
    try {
      return this.unwrap(raw);
    } catch (error) {
      if (error instanceof LocalClientError) {
        if (error.certainty === 'notDispatched')
          throw new LocalClientError(
            error.code,
            'unknown',
            '已收到无法安全确认的回执；不能据此判断写未发生。',
          );
        throw error;
      }
      throw new LocalClientError(
        'INVALID_MCP_ENVELOPE',
        'unknown',
        '回执无法可靠解析；查询原操作。',
      );
    }
  }
  private unwrap(raw: unknown): unknown {
    // This entry is the actual AITestHub official wrapper, not arbitrary external MCP output.
    assertSafe(raw);
    const parsed = z
      .object({
        content: z
          .array(
            z
              .object({ type: z.literal('text'), text: z.string() })
              .passthrough(),
          )
          .length(1),
        structuredContent: z.unknown(),
        isError: z.boolean().optional(),
      })
      .passthrough()
      .safeParse(raw);
    if (!parsed.success)
      throw new LocalClientError(
        'INVALID_MCP_ENVELOPE',
        'unknown',
        '官方MCP回执结构不完整，不能推断写结果。',
      );
    const body = bodySchema.safeParse(parsed.data.structuredContent);
    if (!body.success)
      throw new LocalClientError(
        'INVALID_PLATFORM_ENVELOPE',
        'unknown',
        '缺少官方data/error及meta，不能推断写结果。',
      );
    let text: unknown;
    try {
      text = JSON.parse(parsed.data.content[0]!.text);
    } catch {
      throw new LocalClientError(
        'INVALID_MCP_ENVELOPE',
        'unknown',
        '文本回执不是对应的官方JSON。',
      );
    }
    if (canonical(text) !== canonical(parsed.data.structuredContent))
      throw new LocalClientError(
        'MCP_ENVELOPE_MISMATCH',
        'unknown',
        '文本与结构化回执不一致；仅查原回执。',
      );
    if ('error' in body.data) throw platformFailure(body.data.error.code);
    if (parsed.data.isError === true)
      throw new LocalClientError(
        'INVALID_PLATFORM_ENVELOPE',
        'unknown',
        '错误标记与业务回执矛盾。',
      );
    return body.data.data;
  }
}
