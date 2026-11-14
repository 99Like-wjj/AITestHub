import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { recoveryFencesReady } from './fences.js';

/** An acceptance fence proves only this owner's old submission, never a task, private purpose or result. */
export async function rejectMissingAcceptedReceipt(
  tx: SqlExecutor,
  actor: ActorContext,
  operation: string,
  key: string,
  requireProjectScope = false,
): Promise<void> {
  await currentUser(tx, actor);
  if (!(await recoveryFencesReady(tx))) return;
  const fence = (
    await tx.query<{ project_id: string | null }>(
      'SELECT project_id FROM app.recovery_operation_fences WHERE actor_id=$1 AND operation=$2 AND key=$3',
      [actor.userId, operation, key],
    )
  ).rows[0];
  if (!fence || (requireProjectScope && fence.project_id === null)) return;
  if (fence.project_id)
    await requireProject(tx, actor, fence.project_id, 'project.read');
  throw new DomainError(
    'OPERATION_RESULT_UNKNOWN',
    '该账号原提交已有受理控制记录，当前查询范围没有完整业务回执；未再次发起，请先核对原执行。',
    409,
  );
}
