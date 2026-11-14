import { z } from 'zod';
import { modelSelectionInputSchema } from '../../../contracts/src/configuration.js';
import { legacyMessageModelSnapshotSchema } from '../../../contracts/src/conversations.js';
import {
  modelSelectionV2Schema,
  messageModelSnapshotV2Schema,
} from '../../../contracts/src/model-configuration-v2.js';
import type {
  ModelProtocol,
  ModelAuthScheme,
} from '../../../contracts/src/model-protocol.js';

/** Only trusted application/adapters receive credentialRef; never a public DTO. */
export interface RuntimeModelSelectionV2 {
  runtimeVersion: 'ath.model-selection.v2';
  modelServiceId: string;
  modelEntryId: string;
  serviceRevision: number;
  /** Existing ledger column spelling; always identical to serviceRevision. */
  configRevision: number;
  serviceName: string;
  modelDisplayName: string;
  protocol: ModelProtocol;
  authScheme: ModelAuthScheme;
  baseUrl: string;
  modelId: string;
  effort: string | null;
  contextLimit: number | null;
  maxOutput: number | null;
  credentialRef: string;
  allowedDataScope: 'syntheticPublicOnly';
  allowedDataScopes: ('syntheticPublicOnly' | 'authorizedRelevantTestData')[];
}

/** Persisted input only. Public V2 routes never accept the legacy alternative. */
export function readPersistedModelSelection(raw: unknown) {
  const v2 = modelSelectionV2Schema.safeParse(raw);
  if (v2.success) return { kind: 'v2' as const, selection: v2.data };
  return {
    kind: 'legacy' as const,
    selection: modelSelectionInputSchema.parse(raw),
  };
}

const legacyMessage = legacyMessageModelSnapshotSchema.extend({
  provenanceCaptured: z.boolean().optional(),
});
const v2Message = messageModelSnapshotV2Schema.extend({
  provenanceCaptured: z.boolean().optional(),
});
/** Explicit version readers: an old message is never joined to today's first model. */
export function readMessageModelSnapshot(raw: unknown) {
  const v2 = v2Message.safeParse(raw);
  if (v2.success) {
    const { provenanceCaptured: _private, ...snapshot } = v2.data;
    return { kind: 'v2' as const, snapshot };
  }
  const { provenanceCaptured: _private, ...snapshot } =
    legacyMessage.parse(raw);
  return { kind: 'legacy' as const, snapshot };
}
