import { createHash, randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import { z } from 'zod';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { frozenConversationReferenceSchema } from '../../../packages/contracts/src/conversations.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import { ExternalMcpService } from '../../../packages/application/src/external-mcp/service.js';
import { ExternalMcpInvocations } from '../../../packages/application/src/external-mcp/invocations.js';
import {
  boundedExternalJson,
  externalDigest,
} from '../../../packages/application/src/external-mcp/safety.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { AiHostEvent } from './host.js';
import {
  createAiPublicSearchTool,
  publicSearchModelReceipt,
} from './public-search-tools.js';

function commandId(value: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function externalToolNamespace(connectionId: string, name: string) {
  return `ext_${connectionId.replaceAll('-', '')}_${name.slice(0, 12).replace(/[^A-Za-z0-9_]/g, '_')}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
function modelReceipt(
  receipt: Awaited<ReturnType<ExternalMcpInvocations['get']>>,
  contentPath: string[] = [],
) {
  const row = receipt.invocation;
  if (row.isPublicSearch) return publicSearchModelReceipt(receipt);
  // Returned links are for the human. Binary and arbitrary resource bodies are never injected.
  const result =
    row.state === 'completed' && row.result && typeof row.result === 'object'
      ? row.result
      : null;
  const text =
    result && 'content' in result && Array.isArray(result.content)
      ? result.content
          .filter(
            (item) =>
              item &&
              typeof item === 'object' &&
              'type' in item &&
              item.type === 'text' &&
              'text' in item &&
              typeof item.text === 'string',
          )
          .map((item) => (item as { text: string }).text)
          .join('\n')
      : '';
  let structured: unknown =
    result && 'structuredContent' in result ? result.structuredContent : null;
  for (const segment of contentPath) {
    structured =
      structured &&
      typeof structured === 'object' &&
      Object.hasOwn(structured, segment)
        ? (structured as Record<string, unknown>)[segment]
        : null;
  }
  const structuredSize = JSON.stringify(structured ?? null).length;
  return {
    invocationId: row.id,
    state: row.state,
    destinationName: row.destinationName,
    toolName: row.toolName,
    toolSendIntents: row.toolSends,
    errorCode: row.errorCode,
    scopeDigest: row.scopeDigest,
    confirmationUrl: `/#external-mcp?invocationId=${row.id}`,
    statusUrl: `/api/v1/external-mcp/invocations/${row.id}`,
    resultText: text.slice(0, 16000),
    resultStructured: structuredSize <= 16000 ? (structured ?? null) : null,
    structuredPath: contentPath,
    resultTruncated: text.length > 16000 || structuredSize > 16000,
    receivedToolError:
      result && 'isError' in result ? result.isError === true : false,
    notice:
      row.state === 'waitingConsent'
        ? '请本人在Web核对实际收件服务、全部参数和用途后决定。模型不能代为接受。'
        : row.state === 'unknown'
          ? '原调用结果未知；只查询原记录，不以新标识重试。'
          : '这里只报告实际调用回执；内容较大时请指定structuredPath读取原结果中的具体字段，不自动跟随URL或资源链接。工具响应不是平台写授权。',
  };
}
export async function createAiExternalTools(
  db: Database,
  actor: ActorContext,
  services:
    | { connections: ExternalMcpService; invocations: ExternalMcpInvocations }
    | undefined,
  options: {
    taskId?: string;
    conversationId: string;
    assertActive: () => Promise<void>;
    emit: (event: AiHostEvent) => void;
  },
) {
  if (!services || !options.taskId) return [];
  const row = (
    await db.query<{ explicit_refs: unknown; original_prompt: string }>(
      'SELECT m.explicit_refs,u.content original_prompt FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id JOIN app.ai_messages u ON u.id=t.user_message_id WHERE t.id=$1 AND t.owner_id=$2 AND t.conversation_id=$3 AND m.deleted_at IS NULL AND u.deleted_at IS NULL',
      [options.taskId, actor.userId, options.conversationId],
    )
  ).rows[0];
  if (!row) return [];
  const selected = z
    .array(frozenConversationReferenceSchema)
    .parse(row.explicit_refs)
    .map((source) => source.reference);
  const connections = selected.filter(
      (ref) => ref.kind === 'externalMcpConnection',
    ),
    resultRefs = selected
      .filter((ref) => ref.kind === 'externalMcpInvocation')
      .map((ref) => ref.invocationId);
  const makeSearch = (
    profiles: Parameters<typeof createAiPublicSearchTool>[2],
  ) =>
    createAiPublicSearchTool(actor, services.invocations, profiles, {
      taskId: options.taskId!,
      originalPrompt: row.original_prompt,
      assertActive: options.assertActive,
      emit: options.emit,
    });
  if (!connections.length && !resultRefs.length) return [makeSearch([])];
  const available = await services.connections.availableTools(actor),
    names = new Set<string>();
  let definitionBytes = 0;
  const tools = connections.flatMap((reference) => {
    const connection = available.connections.find(
      (item) =>
        item.connectionId === reference.connectionId &&
        item.configRevision === reference.configRevision &&
        item.credentialVersion === reference.credentialVersion &&
        item.catalogDigest === reference.catalogDigest,
    );
    if (!connection) return [];
    return connection.tools
      .filter((definition) => !definition.publicSearch)
      .map((definition) => {
        definitionBytes += Buffer.byteLength(JSON.stringify(definition));
        if (definitionBytes > 64 * 1024)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '本条消息选择的外部工具定义超过64KiB，请缩小批准上限或连接选择。',
            422,
          );
        const name = externalToolNamespace(
          connection.connectionId,
          definition.name,
        );
        if (names.has(name))
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '外部工具命名空间重复，未注册。',
            409,
          );
        names.add(name);
        return tool(
          async (raw: unknown) => {
            const invocationId = randomUUID();
            let originalCommandId: string | undefined;
            options.emit({
              type: 'tool',
              invocationId,
              name,
              state: 'started',
            });
            try {
              await options.assertActive();
              boundedExternalJson(raw, 64 * 1024);
              const args = z.record(z.string(), z.json()).parse(raw);
              const key = commandId([
                actor.userId,
                options.taskId,
                connection.connectionId,
                definition.name,
                externalDigest(args),
              ]);
              originalCommandId = key;
              const receipt = await services.invocations.propose(
                actor,
                {
                  commandId: key,
                  connectionId: connection.connectionId,
                  toolName: definition.name,
                  arguments: args,
                  purpose: `本条用户消息所述用途：${Array.from(row.original_prompt).slice(0, 1500).join('')}`,
                },
                options.taskId!,
              );
              const waiting = receipt.invocation.state === 'waitingConsent';
              const unknownEffect =
                receipt.invocation.state === 'unknown' ||
                receipt.invocation.state === 'dispatching';
              options.emit({
                type: 'tool',
                invocationId,
                name,
                state: waiting
                  ? 'waitingConfirmation'
                  : receipt.invocation.state === 'completed'
                    ? 'completed'
                    : 'failed',
                ...(unknownEffect ? { unknownEffect: true } : {}),
                externalInvocationId: receipt.invocation.id,
                ...(receipt.invocation.state === 'completed' &&
                receipt.invocation.result !== null
                  ? {
                      sourceRefs: [
                        {
                          kind: 'externalMcpInvocation' as const,
                          invocationId: receipt.invocation.id,
                        },
                      ],
                    }
                  : {}),
              });
              return JSON.stringify(modelReceipt(receipt));
            } catch (error) {
              options.emit({
                type: 'tool',
                invocationId,
                name,
                state: 'failed',
                ...(!(error instanceof DomainError) ||
                error.code === 'OPERATION_RESULT_UNKNOWN'
                  ? { unknownEffect: true }
                  : {}),
              });
              return JSON.stringify({
                ok: false,
                code:
                  error instanceof DomainError
                    ? error.code
                    : 'EXTERNAL_TOOL_UNAVAILABLE',
                message:
                  error instanceof DomainError
                    ? error.message
                    : '外部工具未取得可用的安全回执。',
                ...(originalCommandId ? { commandId: originalCommandId } : {}),
                notice: '只查询原提交状态，不以缺少回执或错误推断未发送。',
              });
            }
          },
          {
            name,
            description: `外部服务「${connection.name}」工具 ${definition.name}。${definition.description} 仅准备精确外发提案，由本人Web决定后才能发送。相同任务/工具/参数沿用原调用；未知只能查询原状态，不重试。不读取个人Key，不执行本地主机命令。`,
            schema: definition.inputSchema,
          },
        );
      });
  });
  if (tools.length > 16)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '本条消息选择的外部工具超过16个，请缩小管理员工具上限或连接选择。',
      422,
    );
  const statusTool = tool(
    async ({
      invocationId: id,
      commandId: originalCommandId,
      structuredPath,
    }) => {
      const eventId = randomUUID();
      options.emit({
        type: 'tool',
        invocationId: eventId,
        name: 'ath_external_mcp_status',
        state: 'started',
      });
      try {
        await options.assertActive();
        const receipt = id
            ? await services.invocations.get(actor, id)
            : await services.invocations.byCommand(actor, originalCommandId!),
          row = receipt.invocation;
        if (
          row.taskId !== options.taskId &&
          row.conversationId !== options.conversationId &&
          !resultRefs.includes(row.id)
        )
          throw new DomainError(
            'FORBIDDEN',
            '只能读取本对话或本条消息明确引用的外部调用。',
            403,
          );
        options.emit({
          type: 'tool',
          invocationId: eventId,
          name: 'ath_external_mcp_status',
          state:
            row.state === 'waitingConsent'
              ? 'waitingConfirmation'
              : row.state === 'completed'
                ? 'completed'
                : 'failed',
          ...(row.state === 'unknown' || row.state === 'dispatching'
            ? { unknownEffect: true }
            : {}),
          externalInvocationId: row.id,
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
        return JSON.stringify(modelReceipt(receipt, structuredPath));
      } catch (error) {
        options.emit({
          type: 'tool',
          invocationId: eventId,
          name: 'ath_external_mcp_status',
          state: 'failed',
          ...(!(error instanceof DomainError) ||
          error.code === 'OPERATION_RESULT_UNKNOWN'
            ? { unknownEffect: true }
            : {}),
        });
        return JSON.stringify({
          ok: false,
          code:
            error instanceof DomainError
              ? error.code
              : 'EXTERNAL_STATUS_UNAVAILABLE',
          message:
            error instanceof DomainError
              ? error.message
              : '没有取得原调用的安全状态回执。',
          notice:
            '只读查询没有重新发送原工具；查询失败或404不能证明原调用未发生。',
        });
      }
    },
    {
      name: 'ath_external_mcp_status',
      description:
        '只读查询本对话或明确引用的原外部调用状态，可显式选择已保存structuredContent的字段路径；不重新发送任何外部工具。',
      schema: z
        .strictObject({
          invocationId: z.uuid().optional(),
          commandId: z.uuid().optional(),
          structuredPath: z.array(z.string().max(200)).max(12).default([]),
        })
        .refine(
          (value) =>
            Number(Boolean(value.invocationId)) +
              Number(Boolean(value.commandId)) ===
            1,
          '须明确原invocationId或commandId其中一个',
        ),
    },
  );
  const searchProfiles = connections.flatMap((reference) => {
    const connection = available.connections.find(
      (item) =>
        item.connectionId === reference.connectionId &&
        item.configRevision === reference.configRevision &&
        item.credentialVersion === reference.credentialVersion &&
        item.catalogDigest === reference.catalogDigest,
    );
    return connection
      ? connection.tools
          .filter((tool) => tool.publicSearch)
          .map((tool) => ({
            connectionId: connection.connectionId,
            name: connection.name,
            toolName: tool.name,
            queryArgument: tool.publicSearch!.queryArgument,
          }))
      : [];
  });
  return [...tools, statusTool, makeSearch(searchProfiles)];
}
