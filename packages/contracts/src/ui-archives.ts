import { z } from 'zod';
import { commandIdSchema, idSchema, sha256Schema, timestampSchema, titleSchema } from './base.js';
import {
  deliveryStatusSchema,
  evidenceManifestItemSchema,
  executionScopeSchema,
  localIdSchema,
  resultItemSchema,
  resultSubmissionReceiptSchema,
  scopeItemSchema,
  uiOutcomeSchema,
} from './domain.js';

const archiveEntrySchema = z.strictObject({
  localItemId: localIdSchema,
  title: titleSchema,
  scenario: titleSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  caseReference: z.strictObject({caseId: idSchema, revisionId: idSchema}).nullable().default(null),
  originalOutcome: uiOutcomeSchema,
});
export const uiArchiveInputSchema = z.strictObject({
  schemaVersion: z.literal('ath.ui-archive.v1'),
  localExecutionId: commandIdSchema,
  title: titleSchema,
  environmentId: idSchema,
  productBuild: z.string().max(200).nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  executionProvenance: z.enum(['local-ai','protocol-synthetic','unknown']).default('unknown'),
  items: z.array(archiveEntrySchema).min(1).max(10000),
}).superRefine((input,context)=>{
  if(Date.parse(input.startedAt)>Date.parse(input.endedAt))
    context.addIssue({code:'custom',path:['endedAt'],message:'实际结束时间不能早于开始。'});
  if(new Set(input.items.map(i=>i.localItemId)).size!==input.items.length)
    context.addIssue({code:'custom',path:['items'],message:'同一归档的本地条目标识须唯一。'});
});
export const uiArchiveCommitSchema = z.strictObject({
  commandId: commandIdSchema,
  input: uiArchiveInputSchema,
  previewDigest: sha256Schema,
});
export const uiArchiveItemSchema = z.strictObject({
  runItemId:idSchema,
  localItemId:localIdSchema,
  requirementId:idSchema,
  requirementVersionId:idSchema.nullable(),
  caseId:idSchema.nullable(),
  caseRevisionId:idSchema.nullable(),
  approvalSnapshotId:z.null(),
  scenario:z.strictObject({title:titleSchema}),
  content:z.strictObject({kind:z.literal('UI'),title:titleSchema}),
  ordinal:z.number().int().nonnegative(),
  declaredOutcome:uiOutcomeSchema,
  issueIds:z.tuple([]),
});
export const uiArchiveScopeSchema = z.strictObject({
  schemaVersion:z.literal('ath.ui-archive-scope.v1'),
  kind:z.literal('UI'),
  sourceType:z.literal('uiArchive'),
  sourceRevisionId:idSchema,
  runId:idSchema,
  projectId:idSchema,
  title:titleSchema,
  localExecutionId:commandIdSchema,
  environmentId:idSchema,
  environmentRevisionId:idSchema,
  startedAt:timestampSchema,
  endedAt:timestampSchema,
  productBuild:z.string().max(200).nullable(),
  snapshotDigest:sha256Schema,
  items:z.array(uiArchiveItemSchema).min(1).max(10000),
});
export const uiArchivePreviewSchema = z.strictObject({
  previewDigest:sha256Schema,
  environment:z.strictObject({id:idSchema,revisionId:idSchema,name:z.string()}),
  items:z.array(archiveEntrySchema.extend({
    requirementTitle:titleSchema,
    matched:z.boolean(),
    matchReason:z.string().nullable(),
  })),
});
export const uiArchiveReceiptSchema = z.strictObject({runId:idSchema,scope:uiArchiveScopeSchema});
/** All original facts for one registered, completed independent run. */
export const uiArchiveResultSubmissionSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.ui-archive-results.v1'),
    runId: idSchema,
    submissionId: commandIdSchema,
    snapshotDigest: sha256Schema,
    endedAt: timestampSchema,
    items: z.array(resultItemSchema).min(1).max(10_000),
    evidenceManifest: z.array(evidenceManifestItemSchema).max(200),
  })
  .superRefine((input, context) => {
    for (const field of ['runItemId', 'localResultId'] as const)
      if (new Set(input.items.map((item) => item[field])).size !== input.items.length)
        context.addIssue({ code: 'custom', path: ['items'], message: '归档项及本地结果标识须唯一。' });
    const known = new Set(input.evidenceManifest.map((item) => item.localEvidenceId));
    if (known.size !== input.evidenceManifest.length)
      context.addIssue({ code: 'custom', path: ['evidenceManifest'], message: '清单内本地证据标识须唯一。' });
    for (const [index, item] of input.items.entries())
      if (item.evidenceRefs.some((id) => !known.has(id)))
        context.addIssue({ code: 'custom', path: ['items', index, 'evidenceRefs'], message: '结果证据须在本次归档清单登记。' });
  });
export const uiArchiveResultReceiptSchema = z.strictObject({
  receipt: resultSubmissionReceiptSchema,
  currentDelivery: z.strictObject({
    status: deliveryStatusSchema,
    missingFileIds: z.array(idSchema),
  }),
});
export const reportExecutionScopeSchema = z.union([executionScopeSchema,uiArchiveScopeSchema]);
export const reportScopeItemSchema = z.union([scopeItemSchema,uiArchiveItemSchema]);

export const uiArchivePreviewToolSchema = z.strictObject({
  op:z.literal('preview'),projectId:idSchema,input:uiArchiveInputSchema,
});
export const uiArchiveCommitToolSchema = z.strictObject({
  op:z.literal('commit'),projectId:idSchema,input:uiArchiveCommitSchema,
});
export const uiArchiveReceiptToolSchema = z.strictObject({
  op:z.literal('receipt'),projectId:idSchema,commandId:commandIdSchema,
});
export const uiArchiveResultSubmitToolSchema = z.strictObject({
  op: z.literal('submit-results'),
  projectId: idSchema,
  input: uiArchiveResultSubmissionSchema,
});
export const uiArchiveResultReceiptToolSchema = z.strictObject({
  op: z.literal('result-receipt'),
  projectId: idSchema,
  runId: idSchema,
  submissionId: commandIdSchema,
});
export const uiArchiveToolInputSchema = z.discriminatedUnion('op', [
  uiArchivePreviewToolSchema,
  uiArchiveCommitToolSchema,
  uiArchiveReceiptToolSchema,
  uiArchiveResultSubmitToolSchema,
  uiArchiveResultReceiptToolSchema,
]);
