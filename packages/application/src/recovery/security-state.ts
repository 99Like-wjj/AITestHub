import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accountRemovalReceiptSchema } from '../../../contracts/src/identity.js';
import { validateModelControlStateV2 } from '../configuration/security-state-v2.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { canonicalJson } from '../operations/service.js';
import { revocationPredicate } from '../schedules/repository.js';
import {
  agentMemoryControlSchema,
  captureAgentMemoryControl,
} from '../agent-memory/recovery.js';
const rows = z.array(z.record(z.string(), z.json()));
/** Private operational state: ciphertext/password hashes stay encrypted in the external control store, never a DTO/tool response. */
export const securityStateSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.security-state.v1'),
    capturedAt: z.iso.datetime(),
    platformMasterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    migrations: z.array(
      z.strictObject({
        version: z.string(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    users: rows,
    projects: rows,
    members: rows,
    secrets: rows,
    modelServices: rows,
    modelGrants: rows,
    modelRevisions: rows,
    modelEntries: rows.optional(),
    modelLegacyBindings: rows.optional(),
    modelEntryVerifications: rows.optional(),
    auxiliaryConfiguration: rows,
    testConfigurations: rows,
    testConfigurationRevisions: rows,
    privacyDeletions: rows,
    revokedScheduleIds: z.array(z.uuid()),
    operationFences: rows,
    dispatchFences: rows,
    modelCalls: rows,
    requirementDeletions: rows.optional(),
    accountRemovals: rows.optional(),
    automaticAuxiliaryIntents: rows.optional(),
    agentMemory: agentMemoryControlSchema.optional(),
    external: z.strictObject({
      available: z.boolean(),
      services: rows,
      grants: rows,
      revisions: rows,
      connections: rows,
      dispatchFences: rows,
    }),
  })
  .superRefine((state, context) => {
    if (
      state.migrations.some(
        (row) => row.version === '0045_agent_recovery.sql',
      ) &&
      !state.agentMemory
    )
      context.addIssue({
        code: 'custom',
        path: ['agentMemory'],
        message:
          'Agent memory recovery metadata is required after migration 45.',
      });
    if (!validateModelControlStateV2(state))
      context.addIssue({
        code: 'custom',
        path: ['modelEntries'],
        message: 'Model protocol security state is incomplete or inconsistent.',
      });
    // Historical pre-36 controls remain readable; controls produced under 36 must
    // contain explicit tombstones and original receipts, rather than defaulting
    // missing removal information back to an active/visible account.
    if (
      !state.migrations.some(
        (migration) => migration.version === '0036_account_removal.sql',
      )
    )
      return;
    const invalid = (path: (string | number)[]) =>
      context.addIssue({
        code: 'custom',
        message:
          'Account removal security state is incomplete or inconsistent.',
        path,
      });
    if (!state.accountRemovals) invalid(['accountRemovals']);
    const users = new Map(state.users.map((user) => [user.id, user]));
    const receipts = new Map(
      (state.accountRemovals ?? []).map((record) => [record.user_id, record]),
    );
    for (const [index, user] of state.users.entries()) {
      if (
        !Object.hasOwn(user, 'removed_at') ||
        !Object.hasOwn(user, 'removed_by') ||
        (user.removed_at === null) !== (user.removed_by === null)
      )
        invalid(['users', index]);
      if (
        user.removed_at !== null &&
        (typeof user.removed_at !== 'string' ||
          !Number.isFinite(Date.parse(user.removed_at)) ||
          !z.uuid().safeParse(user.removed_by).success ||
          !users.has(user.removed_by) ||
          user.active !== false ||
          !receipts.has(user.id))
      )
        invalid(['users', index]);
    }
    for (const [index, record] of (state.accountRemovals ?? []).entries()) {
      const user = users.get(record.user_id),
        receipt = accountRemovalReceiptSchema.safeParse(record.receipt);
      if (
        !user ||
        !receipt.success ||
        record.actor_id !== user.removed_by ||
        record.removed_at !== user.removed_at ||
        !z.uuid().safeParse(record.command_key).success ||
        typeof record.request_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.request_hash) ||
        receipt.data.commandId !== record.command_key ||
        receipt.data.user.id !== record.user_id ||
        receipt.data.removedBy !== record.actor_id ||
        Date.parse(receipt.data.removedAt) !==
          Date.parse(String(record.removed_at))
      )
        invalid(['accountRemovals', index]);
    }
  });
export type SecurityState = z.infer<typeof securityStateSchema>;
export const transientPurposes = [
  'api-auth-token',
  'api-redaction-value',
  'api-tainted-variable',
] as const;
export async function captureSecurityState(
  transaction: SqlExecutor,
  platformMasterFingerprint: string,
): Promise<SecurityState> {
  const read = async (table: string, order: string, where = '') =>
    (
      await transaction.query<{ row: unknown }>(
        `SELECT to_jsonb(t) row FROM app.${table} t ${where} ORDER BY ${order}`,
      )
    ).rows.map((entry) => entry.row);
  const users = await read('users', 'id'),
    projects = (
      await transaction.query<{ row: unknown }>(
        "SELECT jsonb_build_object('id',id,'active',active,'row_version',row_version) row FROM app.projects ORDER BY id",
      )
    ).rows.map((entry) => entry.row);
  const members = await read('project_members', 'project_id,user_id'),
    secrets = await read(
      'secret_records',
      'id',
      "WHERE purpose NOT IN ('api-auth-token','api-redaction-value','api-tainted-variable')",
    );
  const modelServices = await read('model_services', 'id'),
    modelGrants = await read('model_grants', 'model_service_id,user_id'),
    modelRevisions = await read(
      'model_service_revisions',
      'model_service_id,revision',
    );
  const auxiliaryConfiguration = await read(
      'auxiliary_model_configuration',
      'singleton',
    ),
    testConfigurations = await read('test_configurations', 'id'),
    testConfigurationRevisions = await read(
      'test_configuration_revisions',
      'configuration_id,revision_no',
    );
  const privacyDeletions = await read(
    'privacy_deletion_events',
    'occurred_at,id',
  );
  const revokedScheduleIds = (
    await transaction.query<{
      id: string;
    }>(`SELECT s.id FROM app.api_schedules s WHERE s.pause_reason='creatorUnavailable' OR NOT EXISTS(
    SELECT 1 FROM app.users u JOIN app.project_members m ON m.user_id=u.id JOIN app.projects p ON p.id=m.project_id
    WHERE u.id=s.created_by AND u.active AND m.project_id=s.project_id AND m.active AND p.active AND 'tester'=ANY(m.roles)) OR EXISTS(
    SELECT 1 FROM app.audit_events e WHERE e.object_id=s.created_by AND e.created_at>=s.created_at AND (e.project_id=s.project_id OR e.action='identity.account-updated') AND ${revocationPredicate}) ORDER BY s.id`)
  ).rows.map((row) => row.id);
  const now = (
    await transaction.query<{ now: Date }>('SELECT clock_timestamp() now')
  ).rows[0]!.now;
  const migrations = (
    await transaction.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
    )
  ).rows;
  const agentMemory = migrations.some(
    (row) => row.version === '0045_agent_recovery.sql',
  )
    ? await captureAgentMemoryControl(transaction)
    : undefined;
  const operationFences = await read(
      'recovery_operation_fences',
      'actor_id,operation,key',
    ),
    dispatchFences = await read('recovery_dispatch_fences', 'created_at,id');
  const modelCalls = (
    await transaction.query<{ row: unknown }>(
      `SELECT to_jsonb(l)||jsonb_build_object('input_tokens',l.input_tokens::text,'output_tokens',l.output_tokens::text,'total_tokens',l.total_tokens::text,'cached_input_tokens',l.cached_input_tokens::text,'reasoning_output_tokens',l.reasoning_output_tokens::text) row FROM app.model_call_ledger l WHERE EXISTS(SELECT 1 FROM app.recovery_dispatch_fences f WHERE f.namespace IN ('model','auxiliary') AND f.id=l.id) ORDER BY l.started_at,l.id`,
    )
  ).rows.map((row) => row.row);
  const external = {
    available: Boolean(
      (
        await transaction.query<{ present: boolean }>(
          "SELECT to_regclass('app.external_mcp_services') IS NOT NULL present",
        )
      ).rows[0]?.present,
    ),
    services: [] as unknown[],
    grants: [] as unknown[],
    revisions: [] as unknown[],
    connections: [] as unknown[],
    dispatchFences: [] as unknown[],
  };
  if (external.available) {
    external.services = await read('external_mcp_services', 'id');
    external.grants = await read('external_mcp_grants', 'service_id,user_id');
    external.revisions = await read(
      'external_mcp_service_revisions',
      'service_id,revision',
    );
    external.connections = await read('external_mcp_connections', 'id');
    external.dispatchFences = await read(
      'external_mcp_dispatch_fences',
      'actor_id,command_id',
    );
  }
  const requirementDeletions = Boolean(
    (
      await transaction.query<{ present: boolean }>(
        "SELECT to_regclass('app.requirement_deletion_events') IS NOT NULL present",
      )
    ).rows[0]?.present,
  )
    ? await read('requirement_deletion_events', 'created_at,id')
    : undefined;
  return securityStateSchema.parse({
    schemaVersion: 'ath.security-state.v1',
    capturedAt: now.toISOString(),
    platformMasterFingerprint,
    migrations,
    ...(agentMemory === undefined ? {} : { agentMemory }),
    users,
    projects,
    members,
    secrets,
    modelServices,
    modelGrants,
    modelRevisions,
    ...(migrations.some(
      (migration) => migration.version === '0035_model_protocols.sql',
    )
      ? {
          modelEntries: await read(
            'model_entries',
            'model_service_id,position,id',
          ),
          modelLegacyBindings: await read(
            'model_legacy_bindings',
            'model_service_id,legacy_revision',
          ),
          modelEntryVerifications: await read(
            'model_entry_verifications',
            'created_at,id',
          ),
        }
      : {}),
    auxiliaryConfiguration,
    ...((
      await transaction.query<{ ready: boolean }>(
        "SELECT to_regclass('app.automatic_auxiliary_intents') IS NOT NULL ready",
      )
    ).rows[0]?.ready
      ? {
          automaticAuxiliaryIntents: await read(
            'automatic_auxiliary_intents',
            'created_at,id',
            'WHERE protected_history',
          ),
        }
      : {}),
    testConfigurations,
    testConfigurationRevisions,
    privacyDeletions,
    revokedScheduleIds,
    operationFences,
    dispatchFences,
    modelCalls,
    ...(migrations.some(
      (migration) => migration.version === '0036_account_removal.sql',
    )
      ? {
          accountRemovals: await read('account_removals', 'removed_at,user_id'),
        }
      : {}),
    ...(requirementDeletions === undefined ? {} : { requirementDeletions }),
    external,
  });
}
export function securityStateDigest(state: SecurityState) {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}
