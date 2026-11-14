import { projectRequirementReceiptView } from '../../../contracts/src/domain.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { commandIdSchema, idSchema } from '../../../contracts/src/base.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import {
  missingOperationFence,
  recordOperationFence,
  executionOperationNeedsFence,
  executionOperationStartsTask,
  recoveryFencesReady,
} from '../recovery/fences.js';
import { assertTaskCapacity } from '../recovery/capacity.js';
import { sanitizeSourceLinkFields } from '../../../contracts/src/source-links.js';

const operationSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/);
const jsonSchema = z.json();

/** Canonical UTF-8 JSON: sorted object keys, preserved array order and explicit nulls. */
export function canonicalJson(input: unknown): string {
  const json = jsonSchema.parse(input);
  const canonical = (value: z.infer<typeof jsonSchema>): string => {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(',')}}`;
  };
  return canonical(json);
}

/** Reuse the exact persisted digest for narrow recovery reads. */
export function operationRequestHash(
  input: unknown,
  projectId?: string,
): string {
  return createHash('sha256')
    .update(canonicalJson({ input, projectId: projectId ?? null }))
    .digest('hex');
}

export type OperationLookup =
  { commandId: string } | { operation: string; key: string };
interface CommandRow {
  response_redacted_at?: Date | null;
  id: string;
  operation: string;
  key: string;
  request_hash: string;
  response: unknown;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  project_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// Official MCP has business operation status only, never private chats or management commands.
const officialBusinessRoots = new Set([
  'requirement',
  'requirements',
  'asset',
  'assets',
  'review',
  'reviews',
  'plan',
  'plans',
  'api-run',
  'api-runs',
  'schedule',
  'schedules',
  'test-configuration',
  'database-connections',
  'ui-execution',
  'ui-executions',
  'file',
  'files',
  'result',
  'results',
  'report',
  'reports',
  'problem',
  'problems',
  'issue',
  'issues',
  'retest',
  'retests',
  'knowledge',
]);

export class OperationService {
  constructor(readonly db: Pick<Database, 'query' | 'transaction'>) {}

  /**
   * Executes only transactional platform writes. Never place network/model/file side effects in work.
   * Work must return a safe transport DTO: no plaintext credentials or private data outside its scope.
   * A failed transaction has no committed command or write; no retry is performed here.
   */
  async execute<T>(
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
    authorize: (tx: SqlExecutor) => Promise<void>,
    work: (tx: SqlExecutor) => Promise<T>,
    projectId?: string,
  ): Promise<T> {
    operationSchema.parse(operation);
    commandIdSchema.parse(key);
    if (projectId !== undefined) idSchema.parse(projectId);
    const hash = operationRequestHash(input, projectId);
    return this.db.transaction(async (tx) => {
      // Both checks precede any replay, so a stale actor/key/membership cannot recover an old response.
      await currentUser(tx, actor);
      await authorize(tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        canonicalJson([actor.userId, operation, key]),
      ]);
      const prior = (
        await tx.query<CommandRow>(
          'SELECT * FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3 FOR UPDATE',
          [actor.userId, operation, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '同一提交标识已用于不同内容，请查询原回执或使用新标识。',
            409,
          );
        }
        if (prior.response_redacted_at)
          throw new DomainError(
            'NOT_FOUND',
            '原对象已永久删除，回执正文不再可读；不会据此重建。',
            404,
          );
        if (prior.status !== 'completed') {
          throw new DomainError(
            'OPERATION_RESULT_UNKNOWN',
            '此操作尚无确定完成回执，请先查询原操作状态。',
            409,
          );
        }
        // JSON storage is the transport boundary. T is supplied by the same application operation.
        return projectRequirementReceiptView(
          operation,
          sanitizeSourceLinkFields(prior.response),
        ) as T;
      }
      await missingOperationFence(tx, actor.userId, operation, key, hash);
      if (executionOperationStartsTask(operation)) await assertTaskCapacity(tx);
      const command = (
        await tx.query<{ id: string }>(
          'INSERT INTO app.commands(actor_id,operation,key,request_hash,project_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [actor.userId, operation, key, hash, projectId ?? null],
        )
      ).rows[0];
      if (!command) throw new Error('Command insert returned no row');
      const response = await work(tx);
      // JSON validation prevents undefined, unsupported values and accidental non-DTO objects.
      const serialized = canonicalJson(response);
      await tx.query(
        `UPDATE app.commands SET response=$2::jsonb,status='completed',updated_at=clock_timestamp() WHERE id=$1`,
        [command.id, serialized],
      );
      if (executionOperationNeedsFence(operation))
        await recordOperationFence(tx, {
          actorId: actor.userId,
          operation,
          key,
          requestHash: hash,
          commandId: command.id,
          projectId: projectId ?? null,
        });
      return response;
    });
  }

  async get(actor: ActorContext, lookup: OperationLookup) {
    if ('commandId' in lookup) idSchema.parse(lookup.commandId);
    else {
      operationSchema.parse(lookup.operation);
      commandIdSchema.parse(lookup.key);
    }
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const query =
        'commandId' in lookup
          ? await tx.query<CommandRow>(
              'SELECT * FROM app.commands WHERE id=$1 AND actor_id=$2',
              [lookup.commandId, actor.userId],
            )
          : await tx.query<CommandRow>(
              'SELECT * FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
              [actor.userId, lookup.operation, lookup.key],
            );
      let command = query.rows[0];
      const notFound = () =>
        new DomainError('NOT_FOUND', '没有此账号当前可访问的操作记录。', 404);
      if (!command && (await recoveryFencesReady(tx))) {
        const fence = (
          'commandId' in lookup
            ? await tx.query<{
                command_id: string;
                operation: string;
                key: string;
                project_id: string | null;
                created_at: Date;
              }>(
                'SELECT command_id,operation,key,project_id,created_at FROM app.recovery_operation_fences WHERE command_id=$1 AND actor_id=$2',
                [lookup.commandId, actor.userId],
              )
            : await tx.query<{
                command_id: string;
                operation: string;
                key: string;
                project_id: string | null;
                created_at: Date;
              }>(
                'SELECT command_id,operation,key,project_id,created_at FROM app.recovery_operation_fences WHERE actor_id=$1 AND operation=$2 AND key=$3',
                [actor.userId, lookup.operation, lookup.key],
              )
        ).rows[0];
        if (fence)
          command = {
            id: fence.command_id,
            operation: fence.operation,
            key: fence.key,
            request_hash: '',
            response: null,
            status: 'unknown',
            project_id: fence.project_id,
            created_at: fence.created_at,
            updated_at: fence.created_at,
          };
      }
      if (!command) throw notFound();
      if (actor.entrypoint === 'official-mcp') {
        const root = command.operation.split('.')[0];
        if (
          !command.project_id ||
          root === undefined ||
          !officialBusinessRoots.has(root)
        )
          throw notFound();
      }
      if (command.project_id) {
        try {
          await requireProject(tx, actor, command.project_id, 'project.read');
          const root = command.operation.split('.')[0];
          if (
            root === 'test-configuration' ||
            root === 'database-connections'
          ) {
            const view = z
              .object({
                configuration: z.object({
                  content: z.object({ kind: z.string() }),
                }),
              })
              .safeParse(command.response);
            if (!view.success) throw notFound();
            const member = await requireProject(
              tx,
              actor,
              command.project_id,
              view.data.configuration.content.kind === 'databaseConnection'
                ? 'database-connections.metadata.read'
                : 'test-configuration.read',
            );
            if (
              !member.isAdmin &&
              !member.roles.includes('tester') &&
              !member.roles.includes('developer')
            )
              throw notFound();
          }
        } catch (error: unknown) {
          if (error instanceof DomainError && error.code === 'FORBIDDEN')
            throw notFound();
          throw error;
        }
      }
      if (command.response_redacted_at)
        throw new DomainError(
          'NOT_FOUND',
          '原对象已永久删除，回执正文不再可读；删除结果请查询窄删除回执。',
          404,
        );
      return {
        command: {
          id: command.id,
          operation: command.operation,
          status: command.status,
          projectId: command.project_id,
          response: projectRequirementReceiptView(
            command.operation,
            sanitizeSourceLinkFields(command.response),
          ),
          createdAt: command.created_at.toISOString(),
          updatedAt: command.updated_at.toISOString(),
        },
      };
    });
  }
}
