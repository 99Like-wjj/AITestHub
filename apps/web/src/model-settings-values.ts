import {
  modelServiceCreateV2Schema,
  modelServiceUpdateV2Schema,
  type ModelServiceV2,
  type ModelServiceCreateV2,
} from '../../../packages/contracts/src/model-configuration-v2';
import type { z } from 'zod';
import { auxiliaryModelV2Schema } from '../../../packages/contracts/src/model-configuration-v2';
export type ModelServiceDraft = Omit<ModelServiceCreateV2, 'id' | 'commandId'>;
export const protocolLabels = {
  chatCompletions: 'Chat Completions',
  responses: 'Responses',
  anthropicMessages: 'Anthropic Messages',
};
export function emptyModelEntry() {
  return {
    id: crypto.randomUUID(),
    displayName: '',
    modelId: '',
    enabled: true,
    contextLimit: null,
    maxOutput: null,
    effortValues: [] as string[],
    defaultEffort: null,
  };
}
export function emptyServiceDraft(): ModelServiceDraft {
  return {
    name: '',
    note: '',
    protocol: 'chatCompletions',
    baseUrl: '',
    authScheme: 'bearer',
    enabled: false,
    accessPolicy: 'restricted',
    allowedUserIds: [],
    allowedDataScopes: ['syntheticPublicOnly'],
    models: [],
  };
}
export function serviceDraft(service: ModelServiceV2): ModelServiceDraft {
  return {
    name: service.name,
    note: service.note,
    protocol: service.protocol,
    baseUrl: service.baseUrl,
    authScheme: service.authScheme,
    enabled: service.enabled,
    accessPolicy: service.accessPolicy,
    allowedUserIds: [...service.allowedUserIds],
    allowedDataScopes: [...service.allowedDataScopes],
    models: service.models
      .filter((row) => !row.removedAt)
      .map(
        ({
          id,
          displayName,
          modelId,
          enabled,
          contextLimit,
          effortValues,
          defaultEffort,
          maxOutput,
        }) => ({
          id,
          displayName,
          modelId,
          enabled,
          contextLimit,
          effortValues: [...effortValues],
          defaultEffort,
          maxOutput,
        }),
      ),
  };
}
export function credentialBindingChanged(
  service: ModelServiceV2,
  draft: ModelServiceDraft,
) {
  return (
    service.protocol !== draft.protocol ||
    service.baseUrl !== draft.baseUrl.trim() ||
    service.authScheme !== draft.authScheme
  );
}
export function auxiliaryBindingUnavailable(
  services: ModelServiceV2[],
  draft: z.infer<typeof auxiliaryModelV2Schema>,
) {
  if (!draft.enabled) return false;
  const service = services.find((item) => item.id === draft.modelServiceId),
    row = service?.models.find((item) => item.id === draft.modelEntryId);
  return (
    !service ||
    !!service.removedAt ||
    !service.enabled ||
    !service.hasCredential ||
    !row ||
    !!row.removedAt ||
    !row.enabled ||
    (draft.effort !== null && !row.effortValues.includes(draft.effort))
  );
}
export function prepareServiceBody(
  draft: ModelServiceDraft,
  commandId: string,
  id: string,
  baseline: ModelServiceV2 | null,
) {
  const normalized = {
    ...draft,
    allowedUserIds:
      draft.accessPolicy === 'allActive' ? [] : draft.allowedUserIds,
    models: draft.models.map((row) => ({
      ...row,
      displayName: row.displayName.trim() || row.modelId.trim(),
    })),
  };
  if (!baseline)
    return modelServiceCreateV2Schema.parse({ ...normalized, commandId, id });
  return modelServiceUpdateV2Schema.parse({
    ...normalized,
    commandId,
    rowVersion: baseline.rowVersion,
    removedModelEntryIds: baseline.models
      .filter(
        (row) =>
          !row.removedAt && !draft.models.some((item) => item.id === row.id),
      )
      .map((row) => row.id),
  });
}
