import type { Database } from '../../../persistence/src/database.js';
import type { ControlJournal } from '../recovery/control-journal.js';
import { securityStateSchema } from '../recovery/security-state.js';
import { DomainError } from '../errors.js';

/** Startup/operator read only: schema migration never silently creates a replacement control head. */
export async function assertModelProtocolCheckpoint(
  db: Database,
  controls: ControlJournal,
) {
  const installed = (
    await db.query<{ checksum: string }>(
      "SELECT checksum FROM app.schema_migrations WHERE version='0035_model_protocols.sql'",
    )
  ).rows[0];
  if (!installed) return { modelSchema: 1 as const };
  const latest = await controls.latest(),
    state = securityStateSchema.parse(latest.state),
    marker = state.migrations.find(
      (row) => row.version === '0035_model_protocols.sql',
    );
  const current = (
    await db.query<{
      platform_id: string;
      control_sequence: string;
      state_digest: string | null;
    }>(
      'SELECT platform_id,control_sequence::text,state_digest FROM app.recovery_control_state WHERE singleton',
    )
  ).rows[0];
  if (
    !marker ||
    marker.checksum !== installed.checksum ||
    !latest.head.committed ||
    latest.head.pending ||
    !current ||
    current.platform_id !== latest.head.platformId ||
    BigInt(current.control_sequence) !==
      BigInt(latest.head.committed.sequence) ||
    current.state_digest !== latest.head.committed.stateDigest
  )
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '35结构升级尚无匹配的独立认证控制checkpoint；请由可信运维显式完成，不会默认旧映射。',
      503,
    );
  return {
    modelSchema: 2 as const,
    controlSequence: latest.head.committed.sequence,
    stateDigest: latest.head.committed.stateDigest,
  };
}
