import {
  McpServer,
  createMcpHandler,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import {
  idSchema,
  commandIdSchema,
} from '../../../packages/contracts/src/base.js';
import type { Database } from '../../../packages/persistence/src/database.js';
import { currentUser } from '../../../packages/application/src/access/policy.js';
import type { IdentityService } from '../../../packages/application/src/identity/service.js';
import { ProjectService } from '../../../packages/application/src/projects/service.js';
import { OperationService } from '../../../packages/application/src/operations/service.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import { ResultService } from '../../../packages/application/src/results/service.js';
import { registerDomainTools, type DomainMcpServices } from './mcp-domain.js';
import { registerBusinessMcpTools } from './mcp-business.js';
import {
  mountMcpKnowledgeExports,
  mountMcpReportExports,
} from './mcp-knowledge-exports.js';
import { createMcpRequestValidator } from './mcp-request-origin.js';

export const OFFICIAL_MCP_PROTOCOL_VERSION = '2026-07-28';
/** Baseline mount without optional plan/configuration/execution services. */
export const OFFICIAL_MCP_BASE_TOOLS = [
  'ath_projects',
  'ath_operation_status',
  'ath_requirements',
  'ath_requirement_materials',
  'ath_requirement_membership',
  'ath_requirement_state',
  'ath_assets',
  'ath_api_catalog',
  'ath_api_automation',
  'ath_reviews',
  'ath_results',
  'ath_reports',
  'ath_issues',
  'ath_retests',
  'ath_issue_lifecycle',
  'ath_problems',
  'ath_knowledge',
  'ath_knowledge_changes',
  'ath_ui_executions',
] as const;
/** Complete platform inventory; registration still requires its real services. */
export const OFFICIAL_MCP_IMPLEMENTED_TOOLS = [
  ...OFFICIAL_MCP_BASE_TOOLS,
  'ath_api_runs',
  'ath_database_connections',
  'ath_file_transfers',
  'ath_plans',
  'ath_schedules',
  'ath_test_configuration',
] as const;
const operationLookupSchema = z.union([
  z.strictObject({ op: z.literal('command'), commandId: idSchema }),
  z.strictObject({
    op: z.literal('submission'),
    projectId: idSchema,
    submissionId: commandIdSchema,
  }),
  z.strictObject({ op: z.literal('get'), commandId: idSchema }),
  z.strictObject({
    op: z.literal('get'),
    operation: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    key: commandIdSchema,
  }),
]);

function safeFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof ZodError)
    return new DomainError('VALIDATION_ERROR', '输入不符合工具契约。', 400);
  return new DomainError(
    'INTERNAL_ERROR',
    '服务处理失败，请查询原操作状态后再决定是否提交。',
    500,
  );
}
function failureBody(error: unknown, requestId: string) {
  const failure = safeFailure(error);
  return {
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    },
    meta: { requestId },
  };
}
async function toolResult(
  actor: ActorContext,
  work: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const data = z.json().parse(await work());
    const result = { data, meta: { requestId: actor.requestId } };
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error: unknown) {
    const failure = failureBody(error, actor.requestId);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(failure) }],
      structuredContent: failure,
    };
  }
}
async function requireCurrentKey(
  db: Database,
  actor: ActorContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    await currentUser(tx, actor);
    if (actor.entrypoint !== 'official-mcp' || !actor.keyId) {
      throw new DomainError(
        'UNAUTHENTICATED',
        '官方 MCP 需要有效个人 Key。',
        401,
      );
    }
  });
}
export function createOfficialMcpServer(
  db: Database,
  actor: ActorContext,
  services: DomainMcpServices,
): McpServer {
  const projects = new ProjectService(db);
  const operations = new OperationService(db);
  const server = new McpServer(
    { name: 'AITestHub Official MCP', version: '0.1.0' },
    { supportedProtocolVersions: [OFFICIAL_MCP_PROTOCOL_VERSION] },
  );
  server.registerTool(
    'ath_projects',
    {
      description:
        '查询当前个人 Key 有权访问的有效项目，只读list/get；不提供创建或成员管理。',
      inputSchema: z.union([
        z.strictObject({ op: z.literal('list') }),
        z.strictObject({ op: z.literal('get'), projectId: idSchema }),
      ]),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(actor, async () => {
        await requireCurrentKey(db, actor);
        const result = await projects.list(actor);
        if (input.op === 'list') return result;
        const project = result.projects.find(
          (entry) => entry.id === input.projectId,
        );
        if (!project)
          throw new DomainError('NOT_FOUND', '当前项目不存在或不可访问。', 404);
        return { project };
      }),
  );
  server.registerTool(
    'ath_operation_status',
    {
      description:
        'get 查询本人且当前项目仍有权读取的业务 command 状态与原安全回执；未知与他人记录统一不可见。',
      inputSchema: services.files
        ? z.union([
            operationLookupSchema,
            z.strictObject({ op: z.literal('upload'), fileId: idSchema }),
          ])
        : operationLookupSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (
      input:
        | z.infer<typeof operationLookupSchema>
        | { op: 'upload'; fileId: string },
    ) =>
      toolResult(actor, async () => {
        await requireCurrentKey(db, actor);
        if (input.op === 'submission')
          return new ResultService(db).receipt(
            actor,
            input.projectId,
            input.submissionId,
          );
        if (input.op === 'upload') {
          if (!services.files)
            throw new DomainError(
              'DEPENDENCY_UNAVAILABLE',
              '文件服务未挂载。',
              503,
            );
          return services.files.metadata(actor, input.fileId);
        }
        return 'commandId' in input
          ? operations.get(actor, { commandId: input.commandId })
          : operations.get(actor, {
              operation: input.operation,
              key: input.key,
            });
      }),
  );
  registerDomainTools(
    server,
    db,
    actor,
    (work) =>
      toolResult(actor, async () => {
        await requireCurrentKey(db, actor);
        return work();
      }),
    services,
  );
  registerBusinessMcpTools(
    server,
    db,
    actor,
    (work) =>
      toolResult(actor, async () => {
        await requireCurrentKey(db, actor);
        return work();
      }),
    services,
  );
  return server;
}
function bearer(req: Request): string {
  const authorization = req.get('authorization');
  if (
    !authorization ||
    !authorization.startsWith('Bearer ') ||
    authorization.length > 512
  ) {
    throw new DomainError(
      'UNAUTHENTICATED',
      '请配置有效的个人 Key Bearer 认证。',
      401,
    );
  }
  const value = authorization.slice(7);
  if (!value || /\s/.test(value))
    throw new DomainError('UNAUTHENTICATED', '个人 Key 认证格式无效。', 401);
  return value;
}
/** Modern, per-request MCP only. No cookie/session fallback, legacy initialize or shared transport. */
export function mountMcp(
  app: NestExpressApplication,
  db: Database,
  identity: IdentityService,
  services: DomainMcpServices = {},
): void {
  const validateLocalRequest = createMcpRequestValidator(
    process.env.AITESTHUB_PUBLIC_ORIGIN,
  );
  mountMcpKnowledgeExports(app, db, identity, validateLocalRequest);
  mountMcpReportExports(app, db, identity, validateLocalRequest);
  app.use('/mcp', async (req: Request, res: Response) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      validateLocalRequest(req);
      const actor = await identity.authenticate(
        undefined,
        bearer(req),
        requestId,
      );
      await requireCurrentKey(db, actor);
      const handler = createMcpHandler(
        () => createOfficialMcpServer(db, actor, services),
        {
          legacy: 'reject',
          responseMode: 'auto',
          maxRequestBodySize: 1024 * 1024,
          onerror: () => undefined,
        },
      );
      try {
        await toNodeHandler(handler)(req, res, req.body);
      } finally {
        await handler.close();
      }
    } catch (error: unknown) {
      if (res.headersSent || res.writableEnded) return;
      const failure = safeFailure(error);
      if (failure.status === 401)
        res.setHeader('WWW-Authenticate', 'Bearer realm="AITestHub MCP"');
      res.status(failure.status).json(failureBody(error, requestId));
    }
  });
}
