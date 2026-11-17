import type { MaintenanceService } from '../../../packages/application/src/recovery/maintenance.js';
import { DomainError } from '../../../packages/application/src/errors.js';

/** A background scheduler has no HTTP request lease. Reuse the same admission and
 * drain accounting as Web writes, so it cannot race the backup snapshot fence. */
export async function runOfficeBackgroundWork(
  maintenance: MaintenanceService,
  work: () => Promise<boolean>,
): Promise<boolean> {
  let admission: Awaited<ReturnType<MaintenanceService['enterRequest']>>;
  try {
    admission = await maintenance.enterRequest(
      'POST',
      '/api/internal/agent-office/tick',
    );
  } catch (error: unknown) {
    if (error instanceof DomainError && error.details?.maintenancePhase)
      return false;
    throw error;
  }
  try {
    return await work();
  } finally {
    await admission.release();
  }
}
