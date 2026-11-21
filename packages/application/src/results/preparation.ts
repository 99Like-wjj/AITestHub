import { reportExecutionScopeSchema } from '../../../contracts/src/ui-archives.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { forbidden } from '../errors.js';
import { readRun } from '../ui-executions/service.js';
import { missingFiles } from './evidence.js';
import {
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
} from './delivery-state.js';

export async function missingUiFiles(
  db: Pick<Database, 'transaction'>,
  actor: ActorContext,
  projectId: string,
  runId: string,
) {
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'results.submit');
    const run = await readRun(tx, projectId, runId);
    if (run.kind !== 'UI' || run.created_by !== actor.userId) forbidden();
    const gate = await uiDeliveryGate(tx, run.id),
      missing = gate.versioned
        ? await deliveryMissingFiles(tx, run.id)
        : await missingFiles(tx, run.id);
    const count = gate.versioned
      ? Number(
          (
            await tx.query<{ count: string }>(
              'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
              [run.id],
            )
          ).rows[0]?.count ?? '0',
        )
      : 0;
    return {
      runId,
      missingFileIds: missing,
      deliveryStatus:
        projectUiDelivery(
          gate,
          count,
          reportExecutionScopeSchema.parse(run.scope_snapshot).items.length,
          missing.length,
        ) ?? run.delivery_status,
    };
  });
}
