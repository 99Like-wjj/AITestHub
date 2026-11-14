import { z } from 'zod';
import { modelServiceV2Schema } from '../../../contracts/src/model-configuration-v2.js';
import { canonicalJson } from '../operations/service.js';

type JsonRow = Record<string, z.infer<ReturnType<typeof z.json>>>;
export interface ModelControlStateV2 {
  migrations: { version: string }[];
  modelServices: JsonRow[];
  modelRevisions: JsonRow[];
  modelGrants: JsonRow[];
  secrets: JsonRow[];
  modelEntries?: JsonRow[] | undefined;
  modelLegacyBindings?: JsonRow[] | undefined;
  modelEntryVerifications?: JsonRow[] | undefined;
}
/** The migration marker requires a complete signed set; missing is never an empty/default set. */
export function validateModelControlStateV2(
  state: ModelControlStateV2,
): boolean {
  if (
    !state.migrations.some((row) => row.version === '0035_model_protocols.sql')
  )
    return true;
  if (
    !state.modelEntries ||
    !state.modelLegacyBindings ||
    !state.modelEntryVerifications
  )
    return false;
  const services = new Map(state.modelServices.map((row) => [row.id, row]));
  const entries = new Map(state.modelEntries.map((row) => [row.id, row]));
  if (
    services.size !== state.modelServices.length ||
    entries.size !== state.modelEntries.length
  )
    return false;
  for (const row of state.modelEntries) {
    if (
      !z.uuid().safeParse(row.id).success ||
      !services.has(row.model_service_id) ||
      typeof row.enabled !== 'boolean' ||
      !Object.hasOwn(row, 'removed_at') ||
      (row.removed_at !== null && row.enabled)
    )
      return false;
  }
  for (const service of state.modelServices) {
    if (
      service.credential_ref !== null &&
      !state.secrets.some(
        (secret) =>
          secret.id === service.credential_ref &&
          secret.owner_scope === 'platform' &&
          secret.owner_id === service.id &&
          secret.purpose === 'model-api-key',
      )
    )
      return false;
    if (
      !Object.hasOwn(service, 'removed_at') ||
      !Object.hasOwn(service, 'removed_by') ||
      (service.removed_at === null) !== (service.removed_by === null) ||
      (service.removed_at !== null &&
        (service.enabled !== false || service.credential_ref !== null))
    )
      return false;
    const revision = state.modelRevisions.find(
      (row) =>
        row.model_service_id === service.id &&
        row.revision === service.config_revision,
    );
    const parsed = z
      .object({
        schemaVersion: z.literal('ath.model-service.v2'),
        provenance: z.record(z.string(), z.json()),
        credentialRef: z.uuid().nullable(),
        modelService: modelServiceV2Schema,
      })
      .safeParse(revision?.snapshot);
    if (!parsed.success) return false;
    const dto = parsed.data.modelService;
    if (
      parsed.data.credentialRef !== service.credential_ref ||
      dto.id !== service.id ||
      dto.serviceRevision !== service.config_revision ||
      dto.protocol !== service.protocol ||
      dto.authScheme !== service.auth_scheme ||
      dto.baseUrl !== service.base_url ||
      dto.enabled !== service.enabled ||
      dto.name !== service.name ||
      canonicalJson(dto.allowedDataScopes) !==
        canonicalJson(service.allowed_data_scopes)
    )
      return false;
    if (
      canonicalJson(
        state.modelGrants
          .filter((row) => row.model_service_id === service.id)
          .map((row) => row.user_id)
          .sort(),
      ) !== canonicalJson([...dto.allowedUserIds].sort())
    )
      return false;
    const rows = state.modelEntries.filter(
      (row) => row.model_service_id === service.id,
    );
    if (rows.length !== dto.models.length) return false;
    for (const model of dto.models) {
      const row = entries.get(model.id);
      if (
        !row ||
        row.model_service_id !== service.id ||
        row.display_name !== model.displayName ||
        row.model_id !== model.modelId ||
        row.enabled !== model.enabled ||
        (row.removed_at === null) !== (model.removedAt === null) ||
        canonicalJson(row.effort_values) !==
          canonicalJson(model.effortValues) ||
        row.default_effort !== model.defaultEffort ||
        (row.context_limit === null ? null : Number(row.context_limit)) !==
          model.contextLimit ||
        (row.max_output === null ? null : Number(row.max_output)) !==
          model.maxOutput
      )
        return false;
    }
  }
  for (const binding of state.modelLegacyBindings) {
    if (
      !entries.has(binding.model_entry_id) ||
      entries.get(binding.model_entry_id)?.model_service_id !==
        binding.model_service_id ||
      Number(binding.upgraded_revision) !==
        Number(binding.legacy_revision) + 1 ||
      typeof binding.legacy_snapshot_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(binding.legacy_snapshot_digest)
    )
      return false;
    if (
      !state.modelRevisions.some(
        (row) =>
          row.model_service_id === binding.model_service_id &&
          row.revision === binding.legacy_revision,
      )
    )
      return false;
  }
  for (const record of state.modelRevisions) {
    const snapshot = z
      .object({
        schemaVersion: z.literal('ath.model-service.v2'),
        provenance: z.object({
          kind: z.literal('schemaUpgrade'),
          migration: z.literal('0035_model_protocols.sql'),
          legacyRevision: z.number().int().positive(),
        }),
        modelService: modelServiceV2Schema,
      })
      .safeParse(record.snapshot);
    if (
      snapshot.success &&
      !state.modelLegacyBindings.some(
        (binding) =>
          binding.model_service_id === record.model_service_id &&
          binding.upgraded_revision === record.revision &&
          binding.legacy_revision === snapshot.data.provenance.legacyRevision &&
          snapshot.data.modelService.models.length === 1 &&
          binding.model_entry_id === snapshot.data.modelService.models[0]?.id,
      )
    )
      return false;
  }
  for (const record of state.modelEntryVerifications)
    if (
      !entries.has(record.model_entry_id) ||
      entries.get(record.model_entry_id)?.model_service_id !==
        record.model_service_id
    )
      return false;
  return true;
}
