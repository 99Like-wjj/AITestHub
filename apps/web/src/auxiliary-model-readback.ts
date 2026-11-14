import type { z } from 'zod';
import type { auxiliaryModelV2Schema } from '../../../packages/contracts/src/model-configuration-v2';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
export type AuxiliaryModelConfiguration = z.infer<
  typeof auxiliaryModelV2Schema
>;
export type AuxiliaryModelView = {
  configuration: AuxiliaryModelConfiguration | null;
  draft: AuxiliaryModelConfiguration | null;
  readbackConflict?: boolean;
};
const fields = (value: AuxiliaryModelConfiguration) =>
  JSON.stringify({
    modelServiceId: value.modelServiceId,
    modelEntryId: value.modelEntryId,
    enabled: value.enabled,
    effort: value.effort,
  });
export function reconcileAuxiliarySnapshot(
  current: AuxiliaryModelView,
  incoming: AuxiliaryModelConfiguration,
  source: 'read' | 'receipt',
): AuxiliaryModelView {
  if (
    current.configuration &&
    incoming.rowVersion < current.configuration.rowVersion
  )
    return current;
  if (
    current.configuration &&
    incoming.rowVersion === current.configuration.rowVersion &&
    fields(incoming) !== fields(current.configuration)
  )
    return { ...current, readbackConflict: true };
  const dirty =
    !!current.configuration &&
    !!current.draft &&
    JSON.stringify(current.configuration) !== JSON.stringify(current.draft);
  const ownSubmittedDraft =
    source === 'receipt' &&
    current.draft &&
    fields(current.draft) === fields(incoming);
  return {
    configuration: incoming,
    draft: dirty && !ownSubmittedDraft ? current.draft : incoming,
  };
}
/** Read metadata only; no network, mutation, retry, or persisted configuration. */
export class AuxiliaryReadbackGuard {
  #generation = 0;
  begin() {
    return {
      generation: ++this.#generation,
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    };
  }
  invalidate() {
    ++this.#generation;
  }
  current(ticket: ReturnType<AuxiliaryReadbackGuard['begin']>) {
    return (
      ticket.generation === this.#generation &&
      ticket.owner !== null &&
      ticket.owner === currentIdentityOwner() &&
      ticket.epoch === identityContextEpoch()
    );
  }
}
