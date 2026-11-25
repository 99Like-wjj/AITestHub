import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import {
  createBusinessRegistry,
  type BusinessServices,
} from '../../../packages/application/src/tool-registry/business.js';
import { ReportService } from '../../../packages/application/src/reports/service.js';
import { ResultService } from '../../../packages/application/src/results/service.js';
import { registerReportReads } from '../../../packages/application/src/tool-registry/report-reading.js';
import { ActionIntents } from '../../../packages/application/src/tool-registry/action-intents.js';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { mcpActionIntentReplySchema } from '../../../packages/contracts/src/action-intents.js';

type SecureCall = (work: () => Promise<unknown>) => Promise<CallToolResult>;
export function registerBusinessMcpTools(
  server: McpServer,
  db: Database,
  actor: ActorContext,
  call: SecureCall,
  services: BusinessServices,
): void {
  const registry = createBusinessRegistry(db, services);
  registerReportReads(
    registry,
    new ReportService(db),
    new ResultService(db),
    false,
  );
  const confirmations = new ActionIntents(db, registry);
  for (const tool of registry.tools.values()) {
    if (tool.internalOnly) continue;
    server.registerTool(
      tool.name,
      {
        description: registry.description(tool, 'official-mcp'),
        inputSchema: registry.schema(tool, 'official-mcp'),
        annotations: {
          readOnlyHint:
            tool.name !== 'ath_reports' &&
            [...tool.operations.values()].every(
              (operation) => operation.access === 'read',
            ),
          destructiveHint: tool.name === 'ath_requirement_state',
          idempotentHint: tool.name !== 'ath_reports',
          openWorldHint:
            tool.name === 'ath_api_runs' ||
            Boolean(
              services.auxiliary &&
              ['ath_requirements', 'ath_assets', 'ath_issues'].includes(
                tool.name,
              ),
            ),
        },
      },
      async (raw) =>
        call(async () => {
          const prepared = await registry.prepare(actor, tool.name, raw);
          if (!prepared.confirmation) return prepared.execute();
          const pending = await confirmations.propose(actor, prepared);
          if (pending.status !== 'waitingConfirmation')
            return { status: pending.status, confirmation: pending };
          const locator = pending.id.slice(0, 8);
          return {
            status: 'waitingConfirmation',
            confirmation: pending,
            changeScope: pending.proposal.scope,
            instruction:
              '在发起操作的本地 AI 对话中用自然语言展示变更对象、范围和后续结果。使用提案的展示字段和执行结果摘要。只在用户明确回复确认或取消后，将该条用户原话、提案 ID、版本和摘要交给 ath_action_intents reply。保留原提案和原 Key。',
            confirmReply: '确认 ' + locator,
            cancelReply: '取消 ' + locator,
          };
        }),
    );
  }
  server.registerTool(
    'ath_action_intents',
    {
      description:
        '查看原 MCP 提案，或转交本地对话用户对该提案的最新确认/取消原话。先向人展示变更范围，再提交真实回复。',
      inputSchema: z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('get'), id: idSchema }),
        z.strictObject({
          op: z.literal('reply'),
          input: mcpActionIntentReplySchema,
        }),
      ]),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (args) =>
      call(() =>
        args.op === 'get'
          ? confirmations.getMcp(actor, args.id)
          : confirmations.replyViaMcp(actor, args.input),
      ),
  );
}
