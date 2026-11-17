import { createHash, randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { z } from 'zod';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { externalToolNameSchema } from '../../../packages/contracts/src/external-mcp.js';
import { publicSearchResultSchema } from '../../../packages/contracts/src/public-search.js';
import type { ExternalMcpInvocations } from '../../../packages/application/src/external-mcp/invocations.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { externalDigest } from '../../../packages/application/src/external-mcp/safety.js';
import type { AiHostEvent } from './host.js';

export interface SelectedPublicSearch {
  connectionId: string;
  name: string;
  toolName: string;
  queryArgument: string;
}
const short = (value: string, limit: number) =>
  value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
function key(value: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function publicSearchModelReceipt(
  receipt: Awaited<ReturnType<ExternalMcpInvocations['get']>>,
) {
  const row = receipt.invocation;
  const parsed = publicSearchResultSchema.safeParse(
    row.result && typeof row.result === 'object' && 'publicSearch' in row.result
      ? row.result.publicSearch
      : null,
  );
  return {
    invocationId: row.id,
    state: row.state,
    publicQuery: row.publicQuery ?? null,
    toolSendIntents: row.toolSends,
    errorCode: row.errorCode,
    interaction: 'inline-external-consent',
    statusPath: `/api/v1/external-mcp/invocations/${row.id}`,
    ...(row.state === 'completed' && parsed.success
      ? {
          search: {
            ...parsed.data,
            sources: parsed.data.sources.slice(0, 5).map((source) => ({
              ...source,
              title: short(source.title, 200),
              snippet: short(source.snippet, 600),
            })),
            truncated: parsed.data.truncated || parsed.data.sources.length > 5,
          },
        }
      : {}),
    notice:
      row.state === 'waitingConsent'
        ? '请用户在本条回复的搜索确认卡核对唯一实际搜索词、接收方和用途，并确认仅通用公开信息后点击执行或取消；不要跳转其他页面，未发出搜索。'
        : row.state === 'completed' && parsed.success
          ? '只返回搜索服务提供的条目与摘要，未抓取链接。引用必须使用这些实际来源；未命中不等于不存在。'
          : '尚无当前可用来源。未知/已发送状态只查询原记录，不重新发起，也不伪造检索结果。',
  };
}
export function createAiPublicSearchTool(
  actor: ActorContext,
  invocations: ExternalMcpInvocations,
  profiles: SelectedPublicSearch[],
  options: {
    taskId: string;
    originalPrompt: string;
    assertActive: () => Promise<void>;
    emit: (event: AiHostEvent) => void;
  },
) {
  return tool(
    async (input) => {
      const invocationId = randomUUID();
      options.emit({
        type: 'tool',
        invocationId,
        name: 'ath_public_search',
        state: 'started',
      });
      let commandId: string | undefined;
      try {
        await options.assertActive();
        const candidates = profiles.filter(
          (profile) =>
            (!input.connectionId ||
              profile.connectionId === input.connectionId) &&
            (!input.toolName || profile.toolName === input.toolName),
        );
        if (candidates.length !== 1)
          throw new DomainError(
            'DEPENDENCY_UNAVAILABLE',
            profiles.length
              ? '请从本条消息明确选择的连接中指定唯一公开搜索工具，不会自动改选服务。'
              : '当前未配置或未明确选择已检查的公开搜索连接；没有发出联网请求。',
            503,
          );
        const selected = candidates[0]!,
          args = { [selected.queryArgument]: input.query };
        commandId = key([
          actor.userId,
          options.taskId,
          selected.connectionId,
          selected.toolName,
          externalDigest(args),
        ]);
        const receipt = await invocations.propose(
            actor,
            {
              commandId,
              connectionId: selected.connectionId,
              toolName: selected.toolName,
              arguments: args,
              purpose: `公开检索；实际仅发送搜索词。本条用户用途：${Array.from(options.originalPrompt).slice(0, 1400).join('')}`,
            },
            options.taskId,
          ),
          row = receipt.invocation;
        options.emit({
          type: 'tool',
          invocationId,
          name: 'ath_public_search',
          state:
            row.state === 'waitingConsent'
              ? 'waitingConfirmation'
              : row.state === 'completed'
                ? 'completed'
                : 'failed',
          externalInvocationId: row.id,
          ...(row.state === 'unknown' || row.state === 'dispatching'
            ? { unknownEffect: true }
            : {}),
          ...(row.state === 'completed' && row.result !== null
            ? {
                sourceRefs: [
                  {
                    kind: 'externalMcpInvocation' as const,
                    invocationId: row.id,
                  },
                ],
              }
            : {}),
        });
        return JSON.stringify(publicSearchModelReceipt(receipt));
      } catch (error) {
        options.emit({
          type: 'tool',
          invocationId,
          name: 'ath_public_search',
          state: 'failed',
          ...(!(error instanceof DomainError) ||
          error.code === 'OPERATION_RESULT_UNKNOWN'
            ? { unknownEffect: true }
            : {}),
        });
        return JSON.stringify({
          ok: false,
          code:
            error instanceof DomainError ? error.code : 'SEARCH_UNAVAILABLE',
          message:
            error instanceof DomainError
              ? error.message
              : '公开检索没有得到可用的安全回执。',
          ...(commandId ? { commandId } : {}),
          notice: '只查询原提交状态，不以缺少回执或错误推断未发送。',
        });
      }
    },
    {
      name: 'ath_public_search',
      description: `公开联网检索专用入口。先把原需求提炼为通用公开问题；仅发送唯一query，不接收项目全文、私聊、附件、账号凭据、代码长段或任意URL参数。实际搜索词必须由本人Web核对确认后才发；提供真实来源条目，不自动抓取链接。未配置时如实说明，不编造结果。所选搜索工具：${
        profiles
          .slice(0, 8)
          .map(
            (profile) =>
              `${profile.name}: ${profile.connectionId}/${profile.toolName}`,
          )
          .join('; ') || '无'
      }`,
      schema: z.strictObject({
        query: z.string().min(1).max(500),
        connectionId: z.uuid().optional(),
        toolName: externalToolNameSchema.optional(),
      }),
    },
  );
}
