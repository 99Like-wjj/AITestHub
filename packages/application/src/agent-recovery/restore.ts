import type { SqlExecutor } from '../../../persistence/src/database.js';
import {
  reapplyAgentMemoryControl,
  type AgentMemoryControl,
} from '../agent-memory/recovery.js';

/** Database-only recovery. Never contacts or reattaches any source runtime/profile. */
export async function invalidateRestoredAgentExecution(
  tx: SqlExecutor,
  memory: AgentMemoryControl | undefined,
) {
  const present = async (table: string) =>
    (
      await tx.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL present',
        ['app.' + table],
      )
    ).rows[0]?.present ?? false;
  if (await present('agent_schedules')) {
    await tx.query(
      "UPDATE app.agent_schedules SET state='paused',next_point=NULL,next_decision_at=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE state IN ('active','paused')",
    );
    await tx.query(
      "UPDATE app.agent_schedule_occurrences SET state=CASE WHEN state='claimed' THEN 'cancelled' ELSE 'unknown' END,error_code='RESTORED_NOT_REPLAYED',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE state IN ('claimed','dispatching','enqueued')",
    );
  }
  if (await present('agent_calculation_runs'))
    await tx.query(
      "UPDATE app.agent_calculation_runs SET state='unknown',cancel_requested=true,error_code='RESTORED_NOT_REPLAYED',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE state IN ('prepared','running','publishing')",
    );
  if (await present('agent_context_archives'))
    await tx.query('DELETE FROM app.agent_context_archives');
  if (await present('agent_task_plans'))
    await tx.query(
      "UPDATE app.agent_task_plans SET source_stamp='restored-invalid:'||md5(source_stamp),row_version=row_version+1",
    );
  if (await present('agent_retrieval_indexes'))
    await tx.query('DELETE FROM app.agent_retrieval_indexes');
  return reapplyAgentMemoryControl(tx, memory);
}
