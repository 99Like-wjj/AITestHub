import {
  auxiliaryModelSnapshotSchema,
  auxiliaryModelSnapshotV2Schema,
  legacyAuxiliaryModelSnapshotSchema,
  type AuxiliaryModelSnapshot,
} from '../../../contracts/src/auxiliary.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { RuntimeModelSelectionV2 } from '../configuration/model-selection.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';

type Legacy = Awaited<
  ReturnType<ConfigurationService['resolveAuxiliarySelection']>
>;
export function auxiliaryModelSnapshot(
  selection: Legacy | RuntimeModelSelectionV2,
): AuxiliaryModelSnapshot {
  if ('runtimeVersion' in selection)
    return auxiliaryModelSnapshotV2Schema.parse({
      schemaVersion: 'ath.auxiliary-model-snapshot.v2',
      modelServiceId: selection.modelServiceId,
      modelEntryId: selection.modelEntryId,
      serviceRevision: selection.serviceRevision,
      serviceName: selection.serviceName,
      modelDisplayName: selection.modelDisplayName,
      protocol: selection.protocol,
      authScheme: selection.authScheme,
      baseUrl: selection.baseUrl,
      modelId: selection.modelId,
      effort: selection.effort,
      contextLimit: selection.contextLimit,
      maxOutput: selection.maxOutput,
      allowedDataScopes: selection.allowedDataScopes,
    });
  return legacyAuxiliaryModelSnapshotSchema.parse({
    modelServiceId: selection.modelServiceId,
    configRevision: selection.configRevision,
    provider: selection.provider,
    baseUrl: selection.baseUrl,
    modelId: selection.modelId,
    effort: selection.effort,
    capabilities: selection.capabilities,
    allowedDataScope: selection.allowedDataScope,
    allowedDataScopes: selection.allowedDataScopes,
  });
}
export function auxiliarySnapshotSelection(model: AuxiliaryModelSnapshot) {
  return 'schemaVersion' in model
    ? {
        modelServiceId: model.modelServiceId,
        modelEntryId: model.modelEntryId,
        serviceRevision: model.serviceRevision,
        effort: model.effort,
      }
    : {
        modelServiceId: model.modelServiceId,
        configRevision: model.configRevision,
        effort: model.effort,
      };
}
export const auxiliarySnapshotRevision = (model: AuxiliaryModelSnapshot) =>
  'schemaVersion' in model ? model.serviceRevision : model.configRevision;
export async function resolveNewAuxiliarySelection(
  configuration: ConfigurationService,
  tx: SqlExecutor,
  actor: ActorContext,
) {
  const state = (
    await tx.query<{ migrated: boolean; present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0035_model_protocols.sql') migrated,to_regclass('app.model_entries') IS NOT NULL present",
    )
  ).rows[0]!;
  if (state.migrated)
    return configuration.v2.resolveAuxiliaryInTransaction(tx, actor);
  if (state.present)
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '模型升级状态不完整，未受理辅助任务。',
      503,
    );
  return configuration.resolveAuxiliarySelectionInTransaction(tx, actor);
}
/** A legacy task is compared with an explicitly resolved legacy identity, never today's V2 canonical DTO. */
export async function resolveAcceptedAuxiliaryModel(
  configuration: ConfigurationService,
  actor: ActorContext,
  raw: unknown,
) {
  const model = auxiliaryModelSnapshotSchema.parse(raw);
  const selection = await configuration.resolveAcceptedAuxiliarySelection(
    actor,
    auxiliarySnapshotSelection(model),
  );
  if (canonicalJson(auxiliaryModelSnapshot(selection)) !== canonicalJson(model))
    throw new DomainError(
      'STALE_BASE_REVISION',
      '辅助模型参数或资料许可已变化，原任务不会更换模型。',
      412,
    );
  return selection;
}
