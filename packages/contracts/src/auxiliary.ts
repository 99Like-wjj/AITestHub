import { z } from 'zod';
import {
idSchema,
commandIdSchema,
persistedRowVersionSchema,
titleSchema,
} from './base.js';
import {
modelCapabilitiesSchema,
modelDataScopeSchema,
modelDataScopesSchema,
} from './configuration.js';
import { materialInputSchema } from './domain.js';
import {
modelAuthSchemeSchema,
modelBaseUrlSchema,
modelProtocolSchema,
} from './model-protocol.js';
/** Structural representation only; no submission, model-context or authorization override. */
export const auxiliaryMaterialStructuralLimit = 200;
const shared = {
  commandId: commandIdSchema,
  dataScope: modelDataScopeSchema,
  disclosureId: idSchema.optional(),
  disclosureDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  dataConsent: z.literal(true).optional(),
};
const aliasSource = z
  .strictObject({
    purpose: z.literal('alias'),
    conversationId: idSchema.optional(),
    projectId: idSchema.optional(),
    requirementId: idSchema.optional(),
    baseRowVersion: persistedRowVersionSchema,
    text: z.string().trim().min(1).max(16000),
  })
  .refine(
    (input) =>
      Boolean(input.conversationId) !==
        Boolean(input.projectId && input.requirementId) &&
      (!input.conversationId || (!input.projectId && !input.requirementId)),
    '精简名须明确本人会话或本人需求分组目标',
  );
const lookupSource = z.strictObject({
  purpose: z.literal('requirementLookup'),
  projectId: idSchema,
  title: titleSchema,
  businessNumber: z.string().max(100).nullable(),
  summary: z.string().max(16000),
  materials: z
    .array(materialInputSchema)
    .max(auxiliaryMaterialStructuralLimit)
    .optional(),
});
const sqlSource = z.strictObject({
  purpose: z.literal('sqlReview'),
  projectId: idSchema,
  caseId: idSchema,
  caseRevisionId: idSchema,
  cleanupStepId: z.string().min(1).max(200),
});
const issueSource = z.strictObject({
  purpose: z.literal('issueAdvice'),
  projectId: idSchema,
  issueId: idSchema,
  mode: z.enum(['severity', 'direction']),
});
export const auxiliarySourceInputSchema = z.discriminatedUnion('purpose', [
  aliasSource,
  lookupSource,
  sqlSource,
  issueSource,
]);
export type AuxiliarySourceInput = z.infer<typeof auxiliarySourceInputSchema>;
export const auxiliaryRequestInputSchema = z.discriminatedUnion('purpose', [
  aliasSource.safeExtend(shared),
  lookupSource.safeExtend(shared),
  sqlSource.safeExtend(shared),
  issueSource.safeExtend(shared),
]);
export type AuxiliaryRequestInput = z.infer<typeof auxiliaryRequestInputSchema>;
export const auxiliaryResultSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    purpose: z.literal('alias'),
    suggestedName: z.string().trim().min(1).max(80),
  }),
  z.strictObject({
    purpose: z.literal('requirementLookup'),
    candidates: z
      .array(
        z.strictObject({
          requirementId: idSchema,
          reason: z.string().min(1).max(2000),
          similarity: z.enum(['possible', 'likely']),
        }),
      )
      .max(200),
    incomplete: z.boolean(),
    note: z.string().max(4000),
  }),
  z.strictObject({
    purpose: z.literal('sqlReview'),
    conclusion: z.enum(['reviewed', 'unableToJudge']),
    findings: z
      .array(
        z.strictObject({
          level: z.enum(['info', 'warning', 'danger']),
          message: z.string().min(1).max(4000),
        }),
      )
      .max(100),
    note: z.string().max(4000),
  }),
  z.strictObject({
    purpose: z.literal('issueAdvice'),
    summary: z.string().min(1).max(8000),
    suggestedSeverity: z.enum(['severe', 'normal', 'minor']).nullable(),
    possibleDirections: z.array(z.string().min(1).max(4000)).max(30),
    evidenceGaps: z.array(z.string().min(1).max(2000)).max(30),
    confidence: z.enum(['insufficient', 'tentative']),
  }),
]);
export const legacyAuxiliaryModelSnapshotSchema = z.strictObject({
  modelServiceId: idSchema,
  configRevision: persistedRowVersionSchema,
  provider: z.enum(['sensenova', 'ark']),
  baseUrl: z.url(),
  modelId: z.string(),
  effort: z.string().nullable(),
  capabilities: modelCapabilitiesSchema,
  allowedDataScope: z.literal('syntheticPublicOnly'),
  allowedDataScopes: modelDataScopesSchema.default(['syntheticPublicOnly']),
});
/** New accepted tasks freeze the exact native protocol and stable model row. */
export const auxiliaryModelSnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal('ath.auxiliary-model-snapshot.v2'),
  modelServiceId: idSchema,
  modelEntryId: idSchema,
  serviceRevision: persistedRowVersionSchema,
  serviceName: titleSchema,
  modelDisplayName: titleSchema,
  protocol: modelProtocolSchema,
  authScheme: modelAuthSchemeSchema,
  baseUrl: modelBaseUrlSchema,
  modelId: z.string().min(1).max(200),
  effort: z.string().nullable(),
  contextLimit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  maxOutput: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  allowedDataScopes: modelDataScopesSchema,
});
export const auxiliaryModelSnapshotSchema = z.union([
  auxiliaryModelSnapshotV2Schema,
  legacyAuxiliaryModelSnapshotSchema,
]);
export type AuxiliaryModelSnapshot = z.infer<
  typeof auxiliaryModelSnapshotSchema
>;
export const auxiliarySourceMetaSchema = z.strictObject({
  kind: z.enum([
    'conversation',
    'requirementGroup',
    'requirementDraft',
    'caseRevision',
    'issue',
  ]),
  projectId: idSchema.nullable(),
  objectId: idSchema.nullable(),
  revisionId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  rowVersion: persistedRowVersionSchema.nullable().default(null),
  truncated: z.boolean(),
  unreadMaterials: z
    .array(z.string().max(600))
    .max(auxiliaryMaterialStructuralLimit)
    .optional(),
});
export const auxiliaryErrorDetailsSchema = z.strictObject({
  httpStatus: z.number().int().nullable(),
  providerCode: z.string().nullable(),
  providerType: z.string().nullable(),
  requestId: z.string().nullable(),
});
export const auxiliaryCallSchema = z.strictObject({
  id: idSchema,
  status: z.enum(['dispatchIntent', 'completed', 'failed', 'unknown']),
  requestCount: z.union([z.literal(0), z.literal(1)]).nullable(),
  dispatchCertainty: z.enum([
    'notDispatched',
    'fetchInvoked',
    'responseReceived',
    'unknown',
  ]),
  clientRequestId: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  inputTokens: z.string().nullable(),
  outputTokens: z.string().nullable(),
  totalTokens: z.string().nullable(),
  cachedInputTokens: z.string().nullable(),
  reasoningOutputTokens: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const auxiliaryTaskSchema = z.strictObject({
  id: idSchema,
  purpose: z.enum(['alias', 'requirementLookup', 'sqlReview', 'issueAdvice']),
  dataScope: modelDataScopeSchema.default('syntheticPublicOnly'),
  state: z.enum([
    'accepted',
    'running',
    'cancelling',
    'completed',
    'cancelled',
    'failed',
    'unknown',
  ]),
  executionOrigin: z.enum(['fixture', 'liveProvider', 'legacyUnknown']),
  source: auxiliarySourceMetaSchema,
  model: auxiliaryModelSnapshotSchema,
  result: auxiliaryResultSchema.nullable(),
  errorCode: z.string().nullable(),
  errorDetails: auxiliaryErrorDetailsSchema.nullable(),
  callId: idSchema.nullable(),
  call: auxiliaryCallSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export const auxiliaryTaskReceiptSchema = z.strictObject({
  task: auxiliaryTaskSchema,
});
export const cancelAuxiliaryInputSchema = z.strictObject({
  commandId: commandIdSchema,
});

export const auxiliaryPreflightInputSchema = z.strictObject({
  source: auxiliarySourceInputSchema,
});
export const auxiliaryDisclosureSchema = z.strictObject({
  id: idSchema,
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string(),
  source: auxiliarySourceMetaSchema,
  model: auxiliaryModelSnapshotSchema,
  allowedDataScopes: modelDataScopesSchema,
  payloadSummary: z.string().max(4000),
  payloadPreview: z.string().max(1600000),
});
export const auxiliaryPreflightReceiptSchema = z.strictObject({
  disclosure: auxiliaryDisclosureSchema,
});
