import { redactAutomaticAuxiliaryConversation } from '../auxiliary/automatic-common.js';
import { invalidateRestoredAgentExecution } from '../agent-recovery/restore.js';
import { detachRestoredActionIntents } from '../tool-registry/action-intent-data.js';
import { z } from 'zod';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { recoverInterruptedModelAttemptsInTransaction } from '../conversations/model-attempts.js';
import {
  insertDeletionEvent,
  applyPrivacyDeletion,
  type PrivacyDeletion,
} from '../conversations/privacy.js';
import { securityStateSchema, type SecurityState } from './security-state.js';
import { allowLocalUpgradeClockDifference } from '../configuration/upgrade-history.js';
import {
  applyRequirementDeletionInTransaction,
  requirementDeletionEventSchema,
} from '../requirements/deletion.js';

const tables = {
  users: ['id'],
  account_removals: ['user_id'],
  project_members: ['project_id', 'user_id'],
  secret_records: ['id'],
  model_services: ['id'],
  model_service_revisions: ['model_service_id', 'revision'],
  model_entries: ['id'],
  model_legacy_bindings: ['model_service_id', 'legacy_revision'],
  model_entry_verifications: ['id'],
  auxiliary_model_configuration: ['singleton'],
  automatic_auxiliary_intents: ['id'],
  test_configurations: ['id'],
  test_configuration_revisions: ['id'],
  recovery_operation_fences: ['actor_id', 'operation', 'key'],
  recovery_dispatch_fences: ['id'],
  model_call_ledger: ['id'],
  external_mcp_services: ['id'],
  external_mcp_service_revisions: ['service_id', 'revision'],
  external_mcp_connections: ['id'],
  external_mcp_dispatch_fences: ['actor_id', 'command_id'],
} as const;
type Table = keyof typeof tables;
const inconsistent = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '恢复数据与最新安全控制不一致，未开放隔离目标。',
    503,
  );
function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw inconsistent();
  return `"${value}"`;
}
async function upsert(
  transaction: SqlExecutor,
  table: Table,
  rows: Record<string, z.infer<ReturnType<typeof z.json>>>[],
  immutable = false,
  upgradeBindings?: SecurityState['modelLegacyBindings'],
) {
  const columns = (
    await transaction.query<{ attname: string }>(
      'SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',
      [`app.${table}`],
    )
  ).rows.map((row) => row.attname);
  const keys: readonly string[] = tables[table];
  for (const row of rows) {
    if (
      Object.keys(row).some((column) => !columns.includes(column)) ||
      keys.some((key) => !(key in row))
    )
      throw inconsistent();
    const selected = columns.filter((column) => column in row),
      quoted = selected.map(identifier).join(','),
      updates = selected
        .filter((column) => !keys.includes(column))
        .map((column) => `${identifier(column)}=EXCLUDED.${identifier(column)}`)
        .join(',');
    await transaction.query(
      `INSERT INTO app.${table}(${quoted}) SELECT ${quoted} FROM jsonb_populate_record(NULL::app.${table},$1::jsonb) ON CONFLICT(${keys.map(identifier).join(',')}) ${immutable ? 'DO NOTHING' : `DO UPDATE SET ${updates}`}`,
      [JSON.stringify(row)],
    );
    if (immutable) {
      const where = keys
        .map((key, _index) => `t.${identifier(key)}=p.${identifier(key)}`)
        .join(' AND ');
      const omitted = columns.filter((column) => !(column in row));
      const match = (
        await transaction.query<{ matches: boolean }>(
          `SELECT (to_jsonb(t)-$2::text[])=(to_jsonb(p)-$2::text[]) matches FROM app.${table} t CROSS JOIN jsonb_populate_record(NULL::app.${table},$1::jsonb) p WHERE ${where}`,
          [JSON.stringify(row), omitted],
        )
      ).rows[0];
      if (!match?.matches) {
        const current = (
          await transaction.query<{
            row: Record<string, z.infer<ReturnType<typeof z.json>>>;
          }>(
            `SELECT to_jsonb(t) row FROM app.${table} t CROSS JOIN jsonb_populate_record(NULL::app.${table},$1::jsonb) p WHERE ${where}`,
            [JSON.stringify(row)],
          )
        ).rows[0]?.row;
        if (
          !current ||
          !upgradeBindings ||
          !(await allowLocalUpgradeClockDifference(
            transaction,
            table,
            row,
            current,
            upgradeBindings,
          ))
        )
          throw inconsistent();
      }
    }
  }
}
/** Private restore-only job. It preserves business history and overlays authenticated current security state. */
export async function applyLatestSecurity(
  transaction: SqlExecutor,
  state: SecurityState,
  options: { runtimeSafety?: boolean } = {},
) {
  state = securityStateSchema.parse(state);
  if (
    state.migrations.some(
      (migration) => migration.version === '0035_model_protocols.sql',
    )
  ) {
    const installed = (
      await transaction.query<{ ready: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0035_model_protocols.sql') AND to_regclass('app.model_entries') IS NOT NULL AND to_regclass('app.model_legacy_bindings') IS NOT NULL AND to_regclass('app.model_entry_verifications') IS NOT NULL ready",
      )
    ).rows[0]?.ready;
    if (!installed) throw inconsistent();
  }
  if (
    state.migrations.some(
      (migration) => migration.version === '0036_account_removal.sql',
    )
  ) {
    const installed = (
      await transaction.query<{ ready: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0036_account_removal.sql') AND to_regclass('app.account_removals') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.users'::regclass AND attname='removed_at' AND NOT attisdropped) AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.users'::regclass AND attname='removed_by' AND NOT attisdropped) ready",
      )
    ).rows[0]?.ready;
    if (!installed) throw inconsistent();
  }
  await transaction.query('SET CONSTRAINTS ALL DEFERRED');
  const users = state.users.map((row) => ({ ...row }));
  for (const row of users) z.uuid().parse(row.id);
  await upsert(transaction, 'users', users);
  if (state.accountRemovals)
    await upsert(transaction, 'account_removals', state.accountRemovals, true);
  const restoredProjects = new Set(
    (
      await transaction.query<{ id: string }>('SELECT id FROM app.projects')
    ).rows.map((row) => row.id),
  );
  const sourceProjects = state.projects.map((row) => z.uuid().parse(row.id));
  await transaction.query(
    'UPDATE app.projects SET active=false,row_version=row_version+1 WHERE NOT(id=ANY($1::uuid[]))',
    [sourceProjects],
  );
  for (const project of state.projects)
    if (restoredProjects.has(String(project.id)))
      await transaction.query(
        'UPDATE app.projects SET active=$2,row_version=greatest(row_version,$3::int)+1 WHERE id=$1',
        [project.id, project.active, project.row_version],
      );
  const members = state.members.filter((row) =>
    restoredProjects.has(String(row.project_id)),
  );
  await transaction.query(
    'UPDATE app.project_members SET active=false,row_version=row_version+1',
  );
  await upsert(transaction, 'project_members', members);
  await transaction.query(
    'UPDATE app.project_members SET row_version=row_version+1',
  );
  const secretIds = state.secrets.map((row) => z.uuid().parse(row.id));
  await transaction.query(
    'UPDATE app.secret_records SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE NOT(id=ANY($1::uuid[]))',
    [secretIds],
  );
  await upsert(transaction, 'secret_records', state.secrets);
  const modelIds = state.modelServices.map((row) => z.uuid().parse(row.id));
  await transaction.query(
    "UPDATE app.model_services SET enabled=false,access_policy='restricted',credential_ref=NULL WHERE NOT(id=ANY($1::uuid[]))",
    [modelIds],
  );
  const modelScopeColumn = (
    await transaction.query<{ ready: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.model_services'::regclass AND attname='allowed_data_scopes' AND NOT attisdropped) ready",
    )
  ).rows[0]?.ready;
  await upsert(
    transaction,
    'model_services',
    state.modelServices.map((row) => {
      const { allowed_data_scopes: scopes, ...old } = row;
      return modelScopeColumn
        ? { ...old, allowed_data_scopes: scopes ?? ['syntheticPublicOnly'] }
        : old;
    }),
  );
  await upsert(
    transaction,
    'model_service_revisions',
    state.modelRevisions,
    true,
    state.modelLegacyBindings,
  );
  if (state.modelEntries) {
    await transaction.query('UPDATE app.model_entries SET enabled=false');
    await upsert(transaction, 'model_entries', state.modelEntries);
    await upsert(
      transaction,
      'model_legacy_bindings',
      state.modelLegacyBindings ?? [],
      true,
      state.modelLegacyBindings,
    );
    await upsert(
      transaction,
      'model_entry_verifications',
      state.modelEntryVerifications ?? [],
      true,
    );
    const invalid = (
      await transaction.query<{
        invalid: boolean;
      }>(`SELECT EXISTS(SELECT 1 FROM app.model_legacy_bindings b JOIN app.model_service_revisions r
      ON r.model_service_id=b.model_service_id AND r.revision=b.legacy_revision WHERE b.legacy_snapshot_digest<>encode(sha256(convert_to(r.snapshot::text,'UTF8')),'hex')) invalid`)
    ).rows[0]?.invalid;
    if (invalid) throw inconsistent();
  }
  await transaction.query('DELETE FROM app.model_grants');
  for (const row of state.modelGrants)
    await transaction.query(
      'INSERT INTO app.model_grants(model_service_id,user_id) VALUES($1,$2)',
      [row.model_service_id, row.user_id],
    );
  if (state.auxiliaryConfiguration.length)
    await upsert(
      transaction,
      'auxiliary_model_configuration',
      state.auxiliaryConfiguration,
    );
  else
    await transaction.query(
      'UPDATE app.auxiliary_model_configuration SET enabled=false',
    );
  // Binding uniqueness is rebuilt atomically in the quarantined transaction. Current signed values, not defaults, win.
  await transaction.query(
    "UPDATE app.test_configurations SET active=false,content=jsonb_set(content,'{active}','false'::jsonb),credential_ref=NULL",
  );
  const configurations = state.testConfigurations.filter((row) =>
    restoredProjects.has(String(row.project_id)),
  );
  const order: Record<string, number> = {
    environment: 0,
    purpose: 1,
    account: 1,
    authProfile: 2,
    databaseConnection: 3,
    binding: 4,
  };
  configurations.sort(
    (a, b) => (order[String(a.kind)] ?? 9) - (order[String(b.kind)] ?? 9),
  );
  await upsert(transaction, 'test_configurations', configurations);
  const configurationIds = new Set(configurations.map((row) => String(row.id)));
  await upsert(
    transaction,
    'test_configuration_revisions',
    state.testConfigurationRevisions.filter((row) =>
      configurationIds.has(String(row.configuration_id)),
    ),
    true,
  );
  if (state.external.available) {
    const serviceIds = state.external.services.map((row) =>
      z.uuid().parse(row.id),
    );
    await transaction.query(
      'UPDATE app.external_mcp_services SET enabled=false WHERE NOT(id=ANY($1::uuid[]))',
      [serviceIds],
    );
    await upsert(transaction, 'external_mcp_services', state.external.services);
    await upsert(
      transaction,
      'external_mcp_service_revisions',
      state.external.revisions,
      true,
    );
    await transaction.query('DELETE FROM app.external_mcp_grants');
    for (const grant of state.external.grants)
      await transaction.query(
        'INSERT INTO app.external_mcp_grants(service_id,user_id) VALUES($1,$2)',
        [grant.service_id, grant.user_id],
      );
    await transaction.query(
      "UPDATE app.external_mcp_connections SET credential_ref=NULL,status='revoked',current_catalog_id=NULL",
    );
    const connections = state.external.connections.map((row) => ({
      ...row,
      current_catalog_id: null,
      status:
        row.status === 'revoked'
          ? 'revoked'
          : row.credential_ref
            ? 'unverified'
            : 'authRequired',
    }));
    await upsert(transaction, 'external_mcp_connections', connections);
    await upsert(
      transaction,
      'external_mcp_dispatch_fences',
      state.external.dispatchFences,
      true,
    );
  }
  // Preserve the original immutable fence timestamps before a domain tombstone consults them.
  await upsert(
    transaction,
    'recovery_operation_fences',
    state.operationFences,
    true,
  );
  await upsert(
    transaction,
    'recovery_dispatch_fences',
    state.dispatchFences,
    true,
  );
  const automaticIntents = state.automaticAuxiliaryIntents ?? [];
  const automaticReady = (
    await transaction.query<{ ready: boolean }>(
      "SELECT to_regclass('app.automatic_auxiliary_intents') IS NOT NULL ready",
    )
  ).rows[0]?.ready;
  if (automaticIntents.length && !automaticReady)
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '最新安全控制含自动辅助历史，而恢复目标缺少29迁移；保持隔离，先升级模式再应用控制。',
      503,
    );
  if (automaticReady) {
    for (const item of automaticIntents) {
      let taskId: string | null = null,
        taskState: string | null = null;
      if (typeof item.auxiliary_task_id === 'string') {
        const task = (
          await transaction.query<{ id: string; state: string }>(
            'SELECT id,state FROM app.auxiliary_tasks WHERE id=$1',
            [item.auxiliary_task_id],
          )
        ).rows[0];
        if (task) {
          taskId = task.id;
          taskState = task.state;
        }
      }
      await upsert(transaction, 'automatic_auxiliary_intents', [
        {
          ...item,
          auxiliary_task_id: taskId,
          disclosure_id: null,
          state:
            typeof item.state === 'string' &&
            [
              'completed',
              'failed',
              'cancelled',
              'superseded',
              'localMatched',
            ].includes(item.state)
              ? item.state
              : taskState === 'completed'
                ? 'completed'
                : taskState === 'failed' || taskState === 'cancelled'
                  ? taskState
                  : 'unknown',
          protected_history: true,
          error_code: taskId
            ? (item.error_code ?? null)
            : 'RESTORED_RESULT_NOT_AVAILABLE',
        },
      ]);
    }
    await transaction.query(
      "UPDATE app.automatic_auxiliary_intents SET state='unknown',error_code='RESTORED_NOT_REPLAYED',updated_at=clock_timestamp() WHERE state IN ('accepting','accepted')",
    );
  }
  const requirementDeletions = (state.requirementDeletions ?? []).map((event) =>
    requirementDeletionEventSchema.parse(event),
  );
  for (const event of requirementDeletions)
    await applyRequirementDeletionInTransaction(transaction, event, {
      deferResources: true,
      restoring: true,
    });
  let privacyApplied = 0,
    privacyOrphanSkipped = 0;
  for (const row of state.privacyDeletions) {
    const entry: PrivacyDeletion = {
      id: z.uuid().parse(row.id),
      ownerId: z.uuid().parse(row.owner_id),
      targetType: z.enum(['conversation', 'resource']).parse(row.target_type),
      targetId: z.uuid().parse(row.target_id),
      exclusiveResourceIds: z.array(z.uuid()).parse(row.exclusive_resource_ids),
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
      controlVersion: 1,
    };
    const inserted = await insertDeletionEvent(transaction, entry);
    if (entry.targetType === 'conversation')
      await redactAutomaticAuxiliaryConversation(
        transaction,
        entry.ownerId,
        entry.targetId,
      );
    if (inserted === 'orphanSkipped') {
      privacyOrphanSkipped++;
      continue;
    }
    await applyPrivacyDeletion(transaction, entry);
    privacyApplied++;
    await transaction.query(
      "INSERT INTO app.privacy_deletion_replication(event_id,state,recorded_at) VALUES($1,'recorded',clock_timestamp()) ON CONFLICT(event_id) DO UPDATE SET state='recorded',recorded_at=clock_timestamp()",
      [entry.id],
    );
  }
  const willDeleteResources = new Set(
    requirementDeletions.flatMap((event) =>
      event.resource_manifest
        .filter((resource) => resource.action === 'delete')
        .map((resource) => resource.id),
    ),
  );
  for (const event of requirementDeletions)
    await applyRequirementDeletionInTransaction(transaction, event, {
      resourcesOnly: true,
      restoring: true,
      willDeleteResources,
    });
  await transaction.query(
    'UPDATE app.users SET credential_version=credential_version+1',
  );
  await transaction.query(
    'UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp())',
  );
  await transaction.query(
    'UPDATE app.personal_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp())',
  );
  await transaction.query(
    'UPDATE app.password_resets SET used_at=COALESCE(used_at,clock_timestamp())',
  );
  await transaction.query(
    'UPDATE app.model_services SET verification=\'{"status":"unverified","checkedAt":null,"checks":{}}\'::jsonb',
  );
  if (state.modelEntries)
    await transaction.query(
      'UPDATE app.model_entries SET verification=\'{"status":"unverified","checkedAt":null,"checks":{}}\'::jsonb',
    );
  for (const original of state.modelCalls) {
    const row = { ...original };
    if (
      row.task_id &&
      !(
        await transaction.query('SELECT 1 FROM app.ai_tasks WHERE id=$1', [
          row.task_id,
        ])
      ).rowCount
    )
      row.task_id = null;
    if (
      row.auxiliary_task_id &&
      !(
        await transaction.query(
          'SELECT 1 FROM app.auxiliary_tasks WHERE id=$1',
          [row.auxiliary_task_id],
        )
      ).rowCount
    )
      row.auxiliary_task_id = null;
    await upsert(transaction, 'model_call_ledger', [row]);
  }
  if (options.runtimeSafety === false) {
    await transaction.query('SET CONSTRAINTS ALL IMMEDIATE');
    return {
      privacyApplied,
      privacyOrphanSkipped,
      preservedUsers: users.length,
      preservedMemberships: members.length,
      oldSessionsAndKeysInvalidated: true,
    };
  }
  await transaction.query(
    "UPDATE app.api_execution_requests SET state='notExecuted',reason_code='RESTORED_NOT_REPLAYED' WHERE state='queued'",
  );
  await transaction.query(
    'UPDATE app.api_worker_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp())',
  );
  await transaction.query(
    "UPDATE app.api_step_attempts SET state='unknown',outcome='failed',side_effect_certainty='unknown',reason='restored send intent is not replayed' WHERE state='intent'",
  );
  await transaction.query(
    "UPDATE app.runs r SET state=CASE WHEN EXISTS(SELECT 1 FROM app.api_step_attempts a WHERE a.run_id=r.id AND a.send_intent_at IS NOT NULL) THEN 'recoveryRequired' ELSE 'terminated' END,ended_at=COALESCE(ended_at,clock_timestamp()) WHERE kind='API' AND state IN ('prepared','queued','running','stopping')",
  );
  await transaction.query(
    "UPDATE app.runs r SET state='recoveryRequired',ended_at=NULL WHERE kind='API' AND EXISTS(SELECT 1 FROM app.recovery_dispatch_fences f WHERE f.namespace='api' AND f.source_id=r.id) AND state<>'completed'",
  );
  await transaction.query(
    "UPDATE app.ai_tasks SET state=CASE WHEN state='accepted' THEN 'cancelled' ELSE 'unknown' END,error_code='RESTORED_NOT_REPLAYED',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE state IN ('accepted','running','cancelling')",
  );
  await transaction.query(
    "UPDATE app.model_call_ledger SET status='unknown',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE status='dispatchIntent'",
  );
  await recoverInterruptedModelAttemptsInTransaction(transaction);
  await detachRestoredActionIntents(transaction);
  await transaction.query(
    "UPDATE app.commands SET status='unknown' WHERE status='pending'",
  );
  await transaction.query(
    'UPDATE app.ai_runtime_threads SET active_run_id=NULL',
  );
  await transaction.query('DELETE FROM app.ai_runtime_checkpoint_writes');
  await transaction.query('DELETE FROM app.ai_runtime_checkpoints');
  if (
    (
      await transaction.query<{ exists: boolean }>(
        "SELECT to_regclass('app.auxiliary_tasks') IS NOT NULL exists",
      )
    ).rows[0]?.exists
  )
    await transaction.query(
      "UPDATE app.auxiliary_tasks SET state=CASE WHEN state='accepted' THEN 'cancelled' ELSE 'unknown' END,error_code='RESTORED_NOT_REPLAYED',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE state IN ('accepted','running','cancelling')",
    );
  if (
    (
      await transaction.query<{ exists: boolean }>(
        "SELECT to_regclass('app.external_mcp_invocations') IS NOT NULL exists",
      )
    ).rows[0]?.exists
  )
    await transaction.query(
      "UPDATE app.external_mcp_invocations i SET state=CASE WHEN EXISTS(SELECT 1 FROM app.external_mcp_dispatch_fences f WHERE f.actor_id=i.actor_id AND f.command_id=i.command_id) THEN 'unknown' ELSE 'cancelled' END,error_code='RESTORED_NOT_REPLAYED',updated_at=clock_timestamp() WHERE state IN ('waitingConsent','dispatching')",
    );
  await transaction.query(
    "UPDATE app.api_schedules SET status='paused',pause_reason=CASE WHEN id=ANY($1::uuid[]) THEN 'creatorUnavailable' ELSE 'restoredNeedsFutureReview' END,row_version=row_version+1",
    [state.revokedScheduleIds],
  );
  await transaction.query(
    "UPDATE app.schedule_occurrences SET state=CASE WHEN state='queued' THEN 'missedOffline' ELSE state END,reason_code=CASE WHEN state='queued' THEN 'RESTORED_NOT_REPLAYED' ELSE reason_code END,completion_processed_at=COALESCE(completion_processed_at,clock_timestamp()) WHERE state IN ('queued','started','completed')",
  );
  await transaction.query(
    'INSERT INTO app.notification_dispatches(event_id) SELECT id FROM app.outbox ON CONFLICT DO NOTHING',
  );
  await transaction.query('DELETE FROM app.operations_request_leases');
  await transaction.query(
    "UPDATE app.operations_file_gc SET state='failed',error_code='RESTORED_GC_RECONCILE_REQUIRED' WHERE state='deleting'",
  );
  await transaction.query(
    "UPDATE app.file_resources SET status='failed',upload_expires_at=NULL WHERE status='uploading'",
  );
  await transaction.query(
    "UPDATE app.file_upload_attempts SET status='interrupted',error_code='RESTORED_NOT_REPLAYED' WHERE status='uploading'",
  );
  await transaction.query('SET CONSTRAINTS ALL IMMEDIATE');
  const agentRecovery = await invalidateRestoredAgentExecution(
    transaction,
    state.agentMemory,
  );
  return {
    privacyApplied,
    privacyOrphanSkipped,
    preservedUsers: users.length,
    preservedMemberships: members.length,
    oldSessionsAndKeysInvalidated: true,
    agentRecovery,
  };
}
