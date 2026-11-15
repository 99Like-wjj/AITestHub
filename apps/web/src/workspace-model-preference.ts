import { z } from 'zod';
import {
  idSchema,
  persistedRowVersionSchema,
} from '../../../packages/contracts/src/base';
import {
  modelEffortSchema,
  modelSelectionV2Schema,
  type AvailableModelV2,
} from '../../../packages/contracts/src/model-configuration-v2';

const preferenceSchema = z.strictObject({
  schemaVersion: z.literal('ath.workspace-model-preference.v1'),
  ownerId: idSchema,
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  effort: modelEffortSchema.nullable(),
});

export type WorkspaceModelPreference = z.infer<typeof preferenceSchema>;

const storageKey = (ownerId: string) => `aitesthub:workspace-model:${ownerId}`;

export function parseWorkspaceModelPreference(
  ownerId: string,
  value: unknown,
): WorkspaceModelPreference | null {
  const parsed = preferenceSchema.safeParse(value);
  return parsed.success && parsed.data.ownerId === ownerId ? parsed.data : null;
}

/** Preference is not authority: only a currently offered, available model may
 * be restored, and its saved revision is retained for the existing CAS check. */
export function restoreWorkspaceModelPreference(
  ownerId: string,
  models: AvailableModelV2[],
): WorkspaceModelPreference | null {
  try {
    const saved = window.localStorage.getItem(storageKey(ownerId));
    const preference = parseWorkspaceModelPreference(
      ownerId,
      saved ? JSON.parse(saved) : null,
    );
    if (
      !preference ||
      !models.some(
        (entry) =>
          entry.available &&
          entry.modelServiceId === preference.modelServiceId &&
          entry.modelEntryId === preference.modelEntryId,
      )
    )
      return null;
    return preference;
  } catch {
    return null;
  }
}

/** Store only a selection with an accepted message receipt. A failed/unknown
 * submission or an unsent picker change must not replace the last used model. */
export function rememberWorkspaceModelSelection(
  ownerId: string,
  input: unknown,
) {
  const selection = modelSelectionV2Schema.safeParse(input);
  if (!selection.success) return;
  const preference = parseWorkspaceModelPreference(ownerId, {
    schemaVersion: 'ath.workspace-model-preference.v1',
    ownerId,
    ...selection.data,
    effort: selection.data.effort ?? null,
  });
  if (!preference) return;
  try {
    window.localStorage.setItem(
      storageKey(ownerId),
      JSON.stringify(preference),
    );
  } catch {
    // The current picker remains usable when the browser disallows storage.
  }
}

export function chooseWorkspaceModel(
  ownerId: string,
  model: AvailableModelV2,
  previous: WorkspaceModelPreference | null,
): WorkspaceModelPreference {
  const retainedEffort =
    previous?.ownerId === ownerId &&
    previous.modelServiceId === model.modelServiceId &&
    previous.modelEntryId === model.modelEntryId &&
    previous.effort !== null &&
    model.effortValues.includes(previous.effort)
      ? previous.effort
      : null;
  return {
    schemaVersion: 'ath.workspace-model-preference.v1',
    ownerId,
    modelServiceId: model.modelServiceId,
    modelEntryId: model.modelEntryId,
    serviceRevision: model.serviceRevision,
    effort: retainedEffort,
  };
}
