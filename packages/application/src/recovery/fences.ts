import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
const executionOperations = new Set([
  'api-runs.queue',
  'api-runs.debug-draft',
  'conversations.send',
  'auxiliary.submit',
  'retests.start-api',
  'retests.api-start',
  'schedules.create',
  'schedules.revise',
  'schedules.resume',
  'schedules.copy',
  'ui-executions.declare-end',
  'ui-executions.declare-resume',
]);
export function executionOperationNeedsFence(operation: string) {
  return (
    executionOperations.has(operation) ||
    /^ui-executions\.claim\.[a-f0-9-]{36}$/.test(operation)
  );
}
export function executionOperationStartsTask(operation: string) {
  return (
    [
      'api-runs.queue',
      'api-runs.debug-draft',
      'conversations.send',
      'retests.start-api',
      'retests.api-start',
      'auxiliary.submit',
    ].includes(operation) ||
    /^ui-executions\.claim\.[a-f0-9-]{36}$/.test(operation)
  );
}
export async function recoveryFencesReady(transaction: SqlExecutor) {
  return Boolean(
    (
      await transaction.query<{ ready: boolean }>(
        "SELECT to_regclass('app.recovery_operation_fences') IS NOT NULL ready",
      )
    ).rows[0]?.ready,
  );
}
export async function missingOperationFence(
  transaction: SqlExecutor,
  actorId: string,
  operation: string,
  key: string,
  hash: string,
) {
  if (
    !(
      executionOperationNeedsFence(operation) ||
      operation.startsWith('requirements.')
    ) ||
    !(await recoveryFencesReady(transaction))
  )
    return;
  const row = (
    await transaction.query<{ request_hash: string }>(
      'SELECT request_hash FROM app.recovery_operation_fences WHERE actor_id=$1 AND operation=$2 AND key=$3',
      [actorId, operation, key],
    )
  ).rows[0];
  if (row)
    throw new DomainError(
      row.request_hash === hash
        ? 'OPERATION_RESULT_UNKNOWN'
        : 'IDEMPOTENCY_CONFLICT',
      row.request_hash === hash
        ? '原提交已有受理控制记录，但此备份没有原业务回执；未自动重新发起，请先核对原执行。'
        : '原提交标识已用于不同内容，恢复后也不能复用。',
      409,
    );
}
export async function recordOperationFence(
  transaction: SqlExecutor,
  value: {
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
    commandId: string;
    projectId: string | null;
  },
) {
  if (!(await recoveryFencesReady(transaction))) return;
  const existing = (
    await transaction.query<{ request_hash: string }>(
      'SELECT request_hash FROM app.recovery_operation_fences WHERE actor_id=$1 AND operation=$2 AND key=$3',
      [value.actorId, value.operation, value.key],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== value.requestHash)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '该提交标识的恢复控制摘要不一致。',
        409,
      );
    return;
  }
  await transaction.query(
    'INSERT INTO app.recovery_operation_fences(actor_id,operation,key,request_hash,command_id,project_id) VALUES($1,$2,$3,$4,$5,$6)',
    [
      value.actorId,
      value.operation,
      value.key,
      value.requestHash,
      value.commandId,
      value.projectId,
    ],
  );
  transaction.noteSecurityControlChange?.({
    action: 'execution.accepted-fenced',
    objectId: value.commandId,
    projectId: value.projectId,
  });
}
export async function recordDispatchFence(
  transaction: SqlExecutor,
  value: {
    id: string;
    namespace: 'api' | 'model' | 'auxiliary';
    actorId: string | null;
    projectId: string | null;
    sourceId: string;
    runItemId?: string;
    phase?: string;
    stepId?: string;
    requestHash?: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (!(await recoveryFencesReady(transaction))) return;
  const metadata = z
    .strictObject({
      planId: z.uuid().nullable().optional(),
      caseId: z.uuid().nullable().optional(),
      modelServiceId: z.uuid().optional(),
      modelConfigRevision: z.number().int().positive().optional(),
      modelEntryId: z.uuid().optional(),
      modelProtocol: z
        .enum(['chatCompletions', 'responses', 'anthropicMessages'])
        .optional(),
      modelId: z.string().max(200).optional(),
      source: z.enum(['chat', 'auxiliary', 'background']).optional(),
      purpose: z.string().max(50).optional(),
      executionOrigin: z.string().max(50).optional(),
    })
    .parse(value.metadata ?? {});
  const requestHash =
    value.requestHash ??
    createHash('sha256')
      .update(
        JSON.stringify({
          id: value.id,
          namespace: value.namespace,
          sourceId: value.sourceId,
          metadata,
        }),
      )
      .digest('hex');
  await transaction.query(
    'INSERT INTO app.recovery_dispatch_fences(id,namespace,actor_id,project_id,source_id,run_item_id,phase,step_id,request_hash,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      value.id,
      value.namespace,
      value.actorId,
      value.projectId,
      value.sourceId,
      value.runItemId ?? null,
      value.phase ?? null,
      value.stepId ?? null,
      requestHash,
      JSON.stringify(metadata),
    ],
  );
  transaction.noteSecurityControlChange?.({
    action: `dispatch.${value.namespace}-fenced`,
    objectId: value.id,
    projectId: value.projectId,
  });
}
export async function hasDispatchFence(
  transaction: SqlExecutor,
  namespace: 'api' | 'model' | 'auxiliary',
  sourceId: string,
  runItemId?: string,
  phase?: string,
  stepId?: string,
) {
  if (!(await recoveryFencesReady(transaction))) return false;
  return Boolean(
    (
      await transaction.query(
        'SELECT 1 FROM app.recovery_dispatch_fences WHERE namespace=$1 AND source_id=$2 AND ($3::uuid IS NULL OR run_item_id=$3) AND ($4::text IS NULL OR phase=$4) AND ($5::text IS NULL OR step_id=$5) LIMIT 1',
        [namespace, sourceId, runItemId ?? null, phase ?? null, stepId ?? null],
      )
    ).rowCount,
  );
}
