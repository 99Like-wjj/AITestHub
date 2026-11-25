import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
  type CallToolResult,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';
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
import { DomainError } from '../../../packages/application/src/errors.js';

type SecureCall = (work: () => Promise<unknown>) => Promise<CallToolResult>;
const confirmationSchema = z.strictObject({ confirm: z.boolean() });
// MCP elicitation's restricted wire schema disallows additionalProperties. Keep strict
// response validation separate from the representable form request schema.
const confirmationFormSchema = z.object({ confirm: z.boolean() });

/** Modern 2026 MRTR form elicitation. No push-style elicitInput or legacy initialize. */
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
      async (
        raw,
        ctx: ServerContext,
      ): Promise<CallToolResult | InputRequiredResult> => {
        let roundTrip: InputRequiredResult | undefined;
        const result = await call(async () => {
          const prepared = await registry.prepare(actor, tool.name, raw);
          if (!prepared.confirmation) return prepared.execute();
          const pending = await confirmations.propose(actor, prepared);
          if (pending.status !== 'waitingConfirmation')
            return { confirmation: pending };
          const capabilities = z
            .object({
              'io.modelcontextprotocol/clientCapabilities': z.object({
                elicitation: z.record(z.string(), z.unknown()).optional(),
              }),
            })
            .safeParse(ctx.mcpReq.envelope);
          const supported = capabilities.success
            ? capabilities.data['io.modelcontextprotocol/clientCapabilities']
                .elicitation
            : undefined;
          const hasForm =
            supported !== undefined &&
            ('form' in supported || Object.keys(supported).length === 0);
          if (
            !hasForm ||
            ['ath_platform_admin', 'ath_project_members'].includes(tool.name)
          )
            return {
              status: 'waitingConfirmation',
              confirmation: pending,
              reason: 'CLIENT_FORM_ELICITATION_UNAVAILABLE',
              compatibility:
                '此客户端未声明标准表单交互能力；没有将Key或模型文字当成人已确认。',
              confirmationPath: '/?athIntent=' + pending.id,
              objectLinks: pending.proposal.links,
            };
          const key = `confirm-${pending.id}`;
          const response = inputResponse(ctx.mcpReq.inputResponses, key);
          const accepted = acceptedContent(
            ctx.mcpReq.inputResponses,
            key,
            confirmationSchema,
          );
          // requestState is only a database correlation ID. Current actor + stored argument/scope digest
          // are rechecked; no client-supplied state is used as authorization or as an alternate command.
          if (response.kind !== 'missing') {
            if (ctx.mcpReq.requestState() !== pending.id)
              throw new DomainError(
                'BUSINESS_CONFLICT',
                '确认响应没有关联本次精确提案。',
                409,
              );
            if (
              response.kind === 'elicit' &&
              (response.action === 'decline' ||
                response.action === 'cancel' ||
                accepted?.confirm === false)
            )
              return confirmations.resolveForm(actor, pending.id, {
                revision: pending.revision,
                scopeDigest: pending.scopeDigest,
                decision: 'cancel',
              });
            if (accepted?.confirm === true)
              return confirmations.resolveForm(actor, pending.id, {
                revision: pending.revision,
                scopeDigest: pending.scopeDigest,
                decision: 'execute',
              });
            throw new DomainError(
              'VALIDATION_ERROR',
              '客户端确认响应不符合表单契约，没有执行。',
              400,
            );
          }
          roundTrip = inputRequired({
            requestState: pending.id,
            inputRequests: {
              [key]: inputRequired.elicit({
                mode: 'form',
                message: `${pending.proposal.summary}\n项目 ${pending.projectId ?? ''}\n精确范围 ${JSON.stringify(pending.proposal.scope)}\n摘要 ${pending.scopeDigest}\n是否确认执行？`,
                requestedSchema: confirmationFormSchema,
              }),
            },
          });
          return { status: 'waitingConfirmation' };
        });
        return roundTrip ?? result;
      },
    );
  }
}
