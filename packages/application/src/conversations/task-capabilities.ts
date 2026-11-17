import { z } from 'zod';
import {
  aiTaskExecutionPolicySchema,
  type AiTaskExecutionPolicy,
} from '../../../contracts/src/ai-task-policy.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { conversationRow } from './common.js';

export type AiTaskCapability =
  | 'office'
  | 'businessRead'
  | 'businessWrite'
  | 'externalMcp'
  | 'scheduleManage';

export interface TaskCapabilityContext {
  id: string;
  state: string;
  executionPolicy: AiTaskExecutionPolicy;
  cancelRequestedAt: Date | null;
}

/** Authority comes from the original owned task, never a model/tool policy field. */
export async function assertTaskCapability(
  tx: SqlExecutor,
  actor: ActorContext,
  input: { taskId: string; conversationId: string },
  capability: AiTaskCapability,
  options: { active?: boolean; allowCompleted?: boolean } = {},
): Promise<TaskCapabilityContext> {
  await conversationRow(tx, actor, input.conversationId, false, true);
  const task = (
    await tx.query<{
      id: string;
      state: string;
      execution_policy: unknown;
      cancel_requested_at: Date | null;
    }>(
      'SELECT id,state,execution_policy,cancel_requested_at FROM app.ai_tasks WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
      [
        z.uuid().parse(input.taskId),
        actor.userId,
        z.uuid().parse(input.conversationId),
      ],
    )
  ).rows[0];
  if (!task)
    throw new DomainError('NOT_FOUND', '当前对话任务不存在或不可访问。', 404);
  const policy = aiTaskExecutionPolicySchema.parse(task.execution_policy);
  const officeCapability =
    capability === 'office' || capability === 'businessRead';
  if (
    policy !== 'interactive' &&
    !(policy === 'officeOnly' && officeCapability)
  )
    throw new DomainError(
      'FORBIDDEN',
      '原任务的持久执行策略未开放此能力。',
      403,
    );
  if (
    options.active &&
    (task.cancel_requested_at ||
      (task.state !== 'running' &&
        !(options.allowCompleted && task.state === 'completed')))
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '原任务已停止、取消或不再允许新的执行。',
      422,
    );
  return {
    id: task.id,
    state: task.state,
    executionPolicy: policy,
    cancelRequestedAt: task.cancel_requested_at,
  };
}
