import { z } from 'zod';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { modelServiceSchema } from '../../../contracts/src/configuration.js';
import { modelServiceV2Schema } from '../../../contracts/src/model-configuration-v2.js';
import { canonicalJson } from '../operations/service.js';

type Row = Record<string, z.infer<ReturnType<typeof z.json>>>;
const provenance = z.strictObject({
  kind: z.literal('schemaUpgrade'),
  migration: z.literal('0035_model_protocols.sql'),
  legacyRevision: z.number().int().positive(),
});
const envelope = z.strictObject({
  schemaVersion: z.literal('ath.model-service.v2'),
  provenance,
  credentialRef: z.uuid().nullable(),
  modelService: modelServiceV2Schema,
});
/** Technical local migration clocks may differ. No user-authored history field is ignored. */
export async function allowLocalUpgradeClockDifference(
  tx: SqlExecutor,
  table: string,
  incoming: Row,
  current: Row,
  bindings: Row[],
): Promise<boolean> {
  if (table !== 'model_service_revisions' && table !== 'model_legacy_bindings')
    return false;
  const { created_at: _sourceClock, ...source } = incoming,
    { created_at: _targetClock, ...target } = current;
  if (canonicalJson(source) !== canonicalJson(target)) return false;
  const binding =
    table === 'model_legacy_bindings'
      ? incoming
      : bindings.find(
          (row) =>
            row.model_service_id === incoming.model_service_id &&
            row.upgraded_revision === incoming.revision,
        );
  if (!binding) return false;
  const records = (
    await tx.query<{
      legacy: unknown;
      upgraded: unknown;
      actor: string;
      expected_id: string;
      matches: boolean;
    }>(
      `SELECT old.snapshot legacy,new.snapshot upgraded,new.created_by actor,app.model_legacy_entry_id($1) expected_id,
    encode(sha256(convert_to(old.snapshot::text,'UTF8')),'hex')=$4 matches
    FROM app.model_service_revisions old JOIN app.model_service_revisions new ON new.model_service_id=old.model_service_id
    WHERE old.model_service_id=$1 AND old.revision=$2 AND new.revision=$3`,
      [
        binding.model_service_id,
        binding.legacy_revision,
        binding.upgraded_revision,
        binding.legacy_snapshot_digest,
      ],
    )
  ).rows[0];
  if (
    !records?.matches ||
    records.expected_id !== binding.model_entry_id ||
    Number(binding.upgraded_revision) !== Number(binding.legacy_revision) + 1
  )
    return false;
  const legacy = modelServiceSchema.safeParse(records.legacy),
    upgrade = envelope.safeParse(records.upgraded);
  if (!legacy.success || !upgrade.success) return false;
  const old = legacy.data,
    next = upgrade.data.modelService,
    model = next.models[0];
  if (
    next.models.length !== 1 ||
    !model ||
    upgrade.data.provenance.legacyRevision !== old.configRevision ||
    next.id !== old.id ||
    next.serviceRevision !== old.configRevision + 1 ||
    next.rowVersion !== old.rowVersion + 1 ||
    upgrade.data.credentialRef !== old.credentialRef ||
    next.protocol !== 'chatCompletions' ||
    next.authScheme !== 'bearer' ||
    next.note !== '' ||
    next.removedAt !== null ||
    next.baseUrl !== old.baseUrl ||
    next.name !== old.name ||
    next.enabled !== old.enabled ||
    next.accessPolicy !== old.accessPolicy ||
    canonicalJson(next.allowedUserIds) !== canonicalJson(old.allowedUserIds) ||
    canonicalJson(next.allowedDataScopes) !==
      canonicalJson(old.allowedDataScopes) ||
    model.id !== records.expected_id ||
    model.displayName !== old.modelId ||
    model.modelId !== old.modelId ||
    !model.enabled ||
    model.removedAt !== null ||
    model.contextLimit !== old.contextLimit ||
    model.maxOutput !== old.maxOutput ||
    model.defaultEffort !== old.defaultEffort ||
    canonicalJson(model.effortValues) !== canonicalJson(old.effortValues)
  )
    return false;
  if (
    table === 'model_service_revisions' &&
    incoming.created_by !== records.actor
  )
    return false;
  return true;
}
