import { z } from 'zod';
import { testConfigurationDtoSchema } from '../../../contracts/src/test-configuration.js';
import { apiExecutionScopeSchema } from '../../../contracts/src/api-execution.js';
import type { QueryResultRow } from 'pg';
import type { ActorContext } from '../../../contracts/src/identity.js';

const opaqueRef = z.uuid();
export const frozenConfigurationSchema = z.strictObject({
  environment: testConfigurationDtoSchema,
  bindings: z.array(
    z.strictObject({
      purpose: testConfigurationDtoSchema,
      binding: testConfigurationDtoSchema,
      account: testConfigurationDtoSchema,
      accountCredentialRef: opaqueRef,
      profile: testConfigurationDtoSchema.nullable(),
      profileCredentialRef: opaqueRef.nullable(),
    }),
  ),
  connections: z.array(
    testConfigurationDtoSchema.safeExtend({ credentialRef: opaqueRef }),
  ),
  profiles: z.array(
    testConfigurationDtoSchema.safeExtend({
      credentialRef: opaqueRef.nullable(),
    }),
  ),
});
export type FrozenConfiguration = z.infer<typeof frozenConfigurationSchema>;
export interface ExecutionRunRow extends QueryResultRow {
  id: string;
  run_snapshot_id: string;
  delivery_status: string;
  cleanup_state: string;
  created_at: Date;
  project_id: string;
  kind: 'API' | 'UI';
  state: string;
  created_by: string;
  scope_snapshot: unknown;
  scope_digest: string;
  internal_configuration: unknown;
  stop_requested_at: Date | null;
  source: string;
  origin_key_id: string | null;
}
export interface GrantRow extends QueryResultRow {
  id: string;
  run_id: string;
  worker_instance_id: string;
  fence: number;
  expires_at: Date;
  revoked_at: Date | null;
}
export const parseScope = (row: ExecutionRunRow) =>
  apiExecutionScopeSchema.parse(row.scope_snapshot);
export function runActor(row: ExecutionRunRow): ActorContext {
  return {
    userId: row.created_by,
    entrypoint: 'worker',
    requestId: row.id,
    ...(row.origin_key_id ? { keyId: row.origin_key_id } : {}),
  };
}
export function configurationFor(
  row: ExecutionRunRow,
  caseId: string | null,
): FrozenConfiguration {
  const internal = z
    .strictObject({
      cases: z.array(
        z.strictObject({
          caseId: z.uuid().nullable(),
          configuration: frozenConfigurationSchema,
        }),
      ),
    })
    .parse(row.internal_configuration);
  const selected = internal.cases.find((entry) => entry.caseId === caseId);
  if (!selected) throw new Error('Frozen run configuration is missing');
  return selected.configuration;
}
