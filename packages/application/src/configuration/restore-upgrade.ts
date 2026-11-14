import { z } from 'zod';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { modelServiceSchema } from '../../../contracts/src/configuration.js';
import { modelServiceV2Schema } from '../../../contracts/src/model-configuration-v2.js';
import type { ControlJournal } from '../recovery/control-journal.js';
import { securityStateSchema } from '../recovery/security-state.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';

type JsonRow = Record<string, z.infer<ReturnType<typeof z.json>>>;
const blocked = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '旧模型结构恢复准备与认证控制不一致，目标保持隔离。',
    503,
  );
const provenance = z.strictObject({
  kind: z.literal('schemaUpgrade'),
  migration: z.literal('0035_model_protocols.sql'),
  legacyRevision: z.number().int().positive(),
});

async function fields(
  tx: SqlExecutor,
  table: 'users' | 'secret_records' | 'model_services',
) {
  return (
    await tx.query<{ attname: string }>(
      'SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',
      [`app.${table}`],
    )
  ).rows.map((row) => row.attname);
}
async function insertMissingUser(
  tx: SqlExecutor,
  row: JsonRow,
  columns: string[],
) {
  const known = Object.fromEntries(
    columns
      .filter((name) => Object.hasOwn(row, name))
      .map((name) => [name, row[name]]),
  );
  const names = Object.keys(known)
    .map((name) => `"${name}"`)
    .join(',');
  await tx.query(
    `INSERT INTO app.users(${names}) SELECT ${names} FROM jsonb_populate_record(NULL::app.users,$1::jsonb) ON CONFLICT(id) DO NOTHING`,
    [known],
  );
}

/**
 * Trusted restore-only bridge. Reads the real signed ControlJournal itself; never accepts
 * a request-supplied state/actor, resolves a Key, claims work, creates an anchor or sends.
 * Only a quarantined pre35 database of the exact archived platform may be changed.
 */
export async function prepareLegacyModelUpgradeFromControls(
  target: Database,
  controls: ControlJournal,
  expectedPlatformId: string,
) {
  const latest = await controls.latest(),
    state = securityStateSchema.parse(latest.state);
  if (
    !latest.head.committed ||
    latest.head.pending ||
    latest.head.platformId !== expectedPlatformId
  )
    throw blocked();
  if (
    !state.migrations.some((row) => row.version === '0035_model_protocols.sql')
  )
    return { prepared: false as const, serviceCount: 0 };
  return target.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(415948035)');
    const source = (
      await tx.query<{
        platform_id: string;
        phase: string;
        installed: boolean;
        partial: boolean;
      }>(`SELECT r.platform_id,m.phase,
      EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0035_model_protocols.sql') installed,
      (to_regclass('app.model_entries') IS NOT NULL OR to_regclass('app.model_legacy_bindings') IS NOT NULL
      OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app.model_services'::regclass AND attname='protocol' AND NOT attisdropped)) partial
      FROM app.recovery_control_state r CROSS JOIN app.maintenance_state m WHERE r.singleton AND m.singleton FOR UPDATE OF r,m`)
    ).rows[0];
    if (
      !source ||
      source.platform_id !== expectedPlatformId ||
      source.phase !== 'restoreQuarantine'
    )
      throw blocked();
    if (source.installed) return { prepared: false as const, serviceCount: 0 };
    if (source.partial) throw blocked();
    const installed = (
      await tx.query<{ version: string; checksum: string }>(
        'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
      )
    ).rows;
    if (
      installed.some(
        (row) =>
          !state.migrations.some(
            (known) =>
              known.version === row.version && known.checksum === row.checksum,
          ),
      )
    )
      throw blocked();
    const bindings = state.modelLegacyBindings;
    if (!bindings) throw blocked();
    const existing = (
      await tx.query<{ id: string; config_revision: number }>(
        'SELECT id,config_revision FROM app.model_services ORDER BY id FOR UPDATE',
      )
    ).rows;
    if (
      existing.some(
        (row) =>
          !bindings.some(
            (binding) =>
              binding.model_service_id === row.id &&
              Number(binding.legacy_revision) >= row.config_revision,
          ),
      )
    )
      throw blocked();
    const userColumns = await fields(tx, 'users');
    for (const user of state.users)
      await insertMissingUser(tx, user, userColumns);
    const secretColumns = await fields(tx, 'secret_records');
    for (const binding of bindings) {
      const revision = state.modelRevisions.find(
        (row) =>
          row.model_service_id === binding.model_service_id &&
          row.revision === binding.legacy_revision,
      );
      const upgrade = state.modelRevisions.find(
        (row) =>
          row.model_service_id === binding.model_service_id &&
          row.revision === binding.upgraded_revision,
      );
      const legacy = modelServiceSchema.safeParse(revision?.snapshot);
      const upgraded = z
        .strictObject({
          schemaVersion: z.literal('ath.model-service.v2'),
          provenance,
          credentialRef: z.uuid().nullable(),
          modelService: modelServiceV2Schema,
        })
        .safeParse(upgrade?.snapshot);
      if (
        !revision ||
        !upgrade ||
        !legacy.success ||
        !upgraded.success ||
        legacy.data.id !== binding.model_service_id ||
        legacy.data.configRevision !== binding.legacy_revision ||
        upgraded.data.provenance.legacyRevision !== binding.legacy_revision ||
        upgraded.data.credentialRef !== legacy.data.credentialRef ||
        Number(binding.upgraded_revision) !==
          Number(binding.legacy_revision) + 1 ||
        upgraded.data.modelService.models.length !== 1 ||
        upgraded.data.modelService.models[0]?.id !== binding.model_entry_id ||
        upgraded.data.modelService.models[0]?.modelId !== legacy.data.modelId ||
        upgraded.data.modelService.baseUrl !== legacy.data.baseUrl
      )
        throw blocked();
      const hash = (
        await tx.query<{ digest: string }>(
          "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') digest",
          [revision.snapshot],
        )
      ).rows[0]?.digest;
      if (hash !== binding.legacy_snapshot_digest) throw blocked();
      const old = legacy.data;
      if (old.credentialRef) {
        const secret = state.secrets.find(
          (row) => row.id === old.credentialRef,
        );
        if (
          !secret ||
          secret.owner_scope !== 'platform' ||
          secret.owner_id !== old.id ||
          secret.purpose !== 'model-api-key'
        )
          throw blocked();
        const names = secretColumns.map((name) => `"${name}"`).join(',');
        await tx.query(
          `INSERT INTO app.secret_records(${names}) SELECT ${names} FROM jsonb_populate_record(NULL::app.secret_records,$1::jsonb)
          ON CONFLICT(id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at`,
          [secret],
        );
        const same = (
          await tx.query<{ same: boolean }>(
            "SELECT (to_jsonb(s)-'revoked_at')=(p.row-'revoked_at') same FROM app.secret_records s CROSS JOIN(SELECT $2::jsonb row)p WHERE s.id=$1",
            [secret.id, secret],
          )
        ).rows[0]?.same;
        if (!same) throw blocked();
      }
      const sourceRow = state.modelServices.find((row) => row.id === old.id);
      if (!sourceRow) throw blocked();
      // Reconstruct only the exact old saved revision used by the explicit signed binding.
      // Current V2 settings are applied AFTER the ordinary 35 migration, never interpreted as legacy.
      const row = {
        ...sourceRow,
        name: old.name,
        provider: old.provider,
        base_url: old.baseUrl,
        model_id: old.modelId,
        enabled: old.enabled,
        access_policy: old.accessPolicy,
        capabilities: old.capabilities,
        effort_values: old.effortValues,
        default_effort: old.defaultEffort,
        context_limit: old.contextLimit,
        max_output: old.maxOutput,
        credential_ref: old.credentialRef,
        config_revision: old.configRevision,
        row_version: old.rowVersion,
        allowed_data_scopes: old.allowedDataScopes,
        verification: old.verification,
      };
      const columns = await fields(tx, 'model_services'),
        names = columns.map((name) => `"${name}"`).join(','),
        updates = columns
          .filter((name) => name !== 'id')
          .map((name) => `"${name}"=EXCLUDED."${name}"`)
          .join(',');
      await tx.query(
        `INSERT INTO app.model_services(${names}) SELECT ${names} FROM jsonb_populate_record(NULL::app.model_services,$1::jsonb) ON CONFLICT(id) DO UPDATE SET ${updates}`,
        [row],
      );
      for (const record of state.modelRevisions.filter(
        (record) =>
          record.model_service_id === old.id &&
          Number(record.revision) <= old.configRevision,
      )) {
        await tx.query(
          'INSERT INTO app.model_service_revisions(model_service_id,revision,snapshot,created_by,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            record.model_service_id,
            record.revision,
            record.snapshot,
            record.created_by,
            record.created_at,
          ],
        );
        const actual = (
          await tx.query<{ row: JsonRow }>(
            'SELECT to_jsonb(r) row FROM app.model_service_revisions r WHERE model_service_id=$1 AND revision=$2',
            [record.model_service_id, record.revision],
          )
        ).rows[0]?.row;
        if (!actual || canonicalJson(actual) !== canonicalJson(record))
          throw blocked();
      }
      await tx.query('DELETE FROM app.model_grants WHERE model_service_id=$1', [
        old.id,
      ]);
      for (const userId of old.allowedUserIds) {
        if (!state.users.some((user) => user.id === userId)) throw blocked();
        await tx.query(
          'INSERT INTO app.model_grants(model_service_id,user_id) VALUES($1,$2)',
          [old.id, userId],
        );
      }
    }
    return {
      prepared: true as const,
      serviceCount: bindings.length,
      controlSequence: latest.head.committed!.sequence,
      stateDigest: latest.head.committed!.stateDigest,
    };
  });
}
