import { z } from 'zod';
import { reportExecutionScopeSchema, reportScopeItemSchema } from './ui-archives.js';
import { reportHandlingSchema } from './report-handling.js';
import {
idSchema,
commandIdSchema,
persistedRowVersionSchema,
sha256Schema,
timestampSchema,
} from './base.js';
import {
claimUiExecutionInputSchema,
uiOutcomeSchema,
evidenceManifestItemSchema,
resultItemSchema,
cleanupStateSchema,
deliveryStatusSchema,
resultSubmissionReceiptSchema,
runStateSchema,
apiDataRowAnchorSchema,
apiPreparationAnchorSchema,
} from './domain.js';

export const claimLocalExecutionInputSchema =
  claimUiExecutionInputSchema.safeExtend({
    executionProvenance: z
      .enum(['local-ai', 'protocol-synthetic', 'unknown'])
      .default('unknown'),
  });
export const closeUiProgressInputSchema = z.strictObject({
  commandId: commandIdSchema,
});
export const uiProgressCloseTargetSchema = z.strictObject({
  runId: idSchema.transform((value) => value.toLowerCase()),
  rowVersion: persistedRowVersionSchema,
});
const progressCloseTargets = z
  .array(uiProgressCloseTargetSchema)
  .min(1)
  .max(200)
  .refine(
    (items) => new Set(items.map((item) => item.runId)).size === items.length,
    '执行目标不能重复',
  );
export const previewCloseUiProgressBatchInputSchema = z.strictObject({
  items: progressCloseTargets,
});
export const closeUiProgressBatchInputSchema =
  previewCloseUiProgressBatchInputSchema.safeExtend({
    commandId: commandIdSchema,
    scopeDigest: sha256Schema,
  });
export const uiProgressClosePreviewSchema = z.strictObject({
  projectId: idSchema,
  scopeDigest: sha256Schema,
  items: z.array(
    z.strictObject({
      runId: idSchema,
      rowVersion: persistedRowVersionSchema,
      actualRowVersion: persistedRowVersionSchema.nullable(),
      kind: z.enum(['UI', 'API']).nullable(),
      state: z.string().nullable(),
      progressClosedAt: timestampSchema.nullable(),
      eligible: z.boolean(),
      code: z.string().nullable(),
    }),
  ),
  localExecutionStopped: z.literal(false),
});
export const uiProgressCloseItemReceiptSchema = z.strictObject({
  runId: idSchema,
  baseRowVersion: persistedRowVersionSchema,
  status: z.enum(['closed', 'alreadyClosed', 'conflict', 'skipped']),
  rowVersion: persistedRowVersionSchema.nullable(),
  progressClosedAt: timestampSchema.nullable(),
  code: z.string().nullable(),
  localExecutionStopped: z.literal(false),
});
export const closeUiProgressBatchReceiptSchema = z.strictObject({
  commandId: commandIdSchema,
  projectId: idSchema,
  scopeDigest: sha256Schema,
  items: z.array(uiProgressCloseItemReceiptSchema),
  localExecutionStopped: z.literal(false),
});
export const uiProgressCloseBatchStatusSchema = z.strictObject({
  commandId: commandIdSchema,
  projectId: idSchema,
  scopeDigest: sha256Schema,
  state: z.enum(['completed', 'receiptIncomplete']),
  receipt: closeUiProgressBatchReceiptSchema.nullable(),
  items: z.array(
    z.strictObject({
      runId: idSchema,
      rowVersion: persistedRowVersionSchema,
      receipt: uiProgressCloseItemReceiptSchema.nullable(),
    }),
  ),
  localExecutionStopped: z.literal(false),
});
export const finalAssessmentInputSchema = z.strictObject({
  commandId: commandIdSchema,
  baseResultRevisionId: idSchema,
  baseAssessmentRevisionId: idSchema.nullable(),
  finalOutcome: uiOutcomeSchema,
  reason: z.string().max(10_000),
});
export const supplementaryEvidenceInputSchema = z.strictObject({
  commandId: commandIdSchema,
  resultId: idSchema,
  evidenceManifest: z.array(evidenceManifestItemSchema).min(1).max(100),
});
export const supplementaryEvidenceResourceInputSchema =
  supplementaryEvidenceInputSchema.safeExtend({
    evidenceManifest: z.array(evidenceManifestItemSchema).min(1).max(200),
  });
export const runStatusSchema = z.strictObject({
  runId: idSchema,
  projectId: idSchema,
  kind: z.enum(['UI', 'API']),
  state: z.string(),
  deliveryStatus: z.enum([
    'notSubmitted',
    'receiving',
    'incomplete',
    'complete',
  ]),
  progressClosedAt: z.string().nullable(),
  lastProgressAt: z.string().nullable(),
  progressSequence: z.string(),
  completedItems: z.number().int().min(0),
  totalItems: z.number().int().min(0),
  executionProvenance: z.enum([
    'local-ai',
    'protocol-synthetic',
    'unknown',
    'platform-api',
  ]),
  rowVersion: persistedRowVersionSchema,
  reportId: idSchema.nullable(),
  scope: reportExecutionScopeSchema,
});
export const resultScopeItemSchema = z.strictObject({
  kind: z.enum(['UI', 'API']),
  caseId: idSchema.nullable(),
  revisionId: idSchema.nullable(),
  revisionNo: z.number().int().positive().nullable(),
  approvalSnapshotId: idSchema.nullable(),
  title: z.string(),
  dataRow: apiDataRowAnchorSchema.optional(),
  preparationSources: z.array(apiPreparationAnchorSchema).optional(),
  preconditions: z.array(z.string()),
  expected: z.string().nullable(),
  steps: z.array(z.strictObject({ action: z.string(), expected: z.string().optional() })),
});
export const resultDetailSchema = z.strictObject({
  result: z.strictObject({
    id: idSchema,
    runId: idSchema,
    runItemId: idSchema,
    revisionId: idSchema,
    assessmentRevisionId: idSchema.nullable(),
    content: resultItemSchema,
    scopeItem: resultScopeItemSchema.optional(),
    history: z.array(
      z.strictObject({
        id: idSchema,
        revisionNo: z.number().int().positive(),
        content: resultItemSchema,
        reason: z.string().nullable(),
        actorId: idSchema,
        createdAt: z.string(),
      }),
    ),
    assessments: z.array(
      z.strictObject({
        id: idSchema,
        finalOutcome: uiOutcomeSchema,
        reason: z.string(),
        actorId: idSchema,
        createdAt: z.string(),
      }),
    ),
    evidence: z.array(
      z.strictObject({
        id: idSchema,
        fileId: idSchema,
        manifest: evidenceManifestItemSchema,
        source: z.enum(['original', 'manualAddition']),
      }),
    ),
  }),
});
const count = z.number().int().nonnegative();
const outcomeCounts = z.strictObject({
  passed: count,
  failed: count,
  blocked: count,
  inconclusive: count,
  notExecuted: count,
  notReported: count,
});
export const reportFactsSchema = z.strictObject({
  runId: idSchema,
  projectId: idSchema,
  kind: z.enum(['UI', 'API']),
  executionState: z.string(),
  cleanupState: cleanupStateSchema,
  executionProvenance: z.enum([
    'local-ai',
    'protocol-synthetic',
    'unknown',
    'platform-api',
  ]),
  scope: reportExecutionScopeSchema,
  items: z.array(
    z.strictObject({
      scopeItem: reportScopeItemSchema,
      result: z
        .strictObject({
          id: idSchema,
          revisionId: idSchema,
          revisionNo: z.number().int().positive(),
          initialOutcome: uiOutcomeSchema,
          reportedOutcome: uiOutcomeSchema,
          finalOutcome: uiOutcomeSchema.nullable(),
          effectiveOutcome: uiOutcomeSchema,
          cleanupState: cleanupStateSchema,
          content: resultItemSchema,
          assessmentRevisionId: idSchema.nullable(),
          assessmentReason: z.string().nullable(),
          assessmentBasisRevisionId: idSchema.nullable(),
          assessmentBasisChanged: z.boolean(),
          manuallyAssessed: z.boolean(),
        })
        .nullable(),
    }),
  ),
  statistics: z.strictObject({
    denominator: count,
    reportedItems: count,
    original: outcomeCounts,
    reported: outcomeCounts,
    final: outcomeCounts.extend({ notAssessed: count }),
    effective: outcomeCounts,
  }),
  evidence: z.array(
    z.strictObject({
      id: idSchema,
      localEvidenceId: z.string(),
      fileId: idSchema,
      manifest: evidenceManifestItemSchema,
      lastKnownFileStatus: z.enum([
        'pending',
        'uploading',
        'verified',
        'failed',
      ]),
      originalName: z.string(),
      downloadPath: z.string(),
    }),
  ),
  missingFileIds: z.array(idSchema),
  deliveryStatus: deliveryStatusSchema,
  capturedAt: z.string(),
});
export const reportListSchema = z.strictObject({
  reports: z.array(
    z.strictObject({
      id: idSchema,
      runId: idSchema,
      revisionId: idSchema,
      createdAt: z.string(),
      kind: z.enum(['UI', 'API']),
      executionState: z.string(),
    }),
  ),
});
export const reportDetailSchema = z.strictObject({
  report: z.strictObject({
    id: idSchema,
    revisionId: idSchema,
    facts: reportFactsSchema,
    currentHandling: reportHandlingSchema,
    history: z.array(
      z.strictObject({
        id: idSchema,
        revisionNo: z.number().int().positive(),
        reason: z.string(),
        createdAt: z.string(),
        actorId: idSchema,
      }),
    ),
  }),
});
export const reportRevisionSchema = z.strictObject({
  revisionId: idSchema,
  revisionNo: z.number().int().positive(),
  reason: z.string(),
  facts: reportFactsSchema,
  handlingAtCapture: reportHandlingSchema.nullable(),
  currentHandling: reportHandlingSchema,
});
export const assessmentReceiptSchema = z.strictObject({
  resultId: idSchema,
  assessmentRevisionId: idSchema,
  reportId: idSchema.nullable(),
});
export const evidenceAdditionReceiptSchema = z.strictObject({
  resultId: idSchema,
  evidenceAdded: z.number().int().nonnegative(),
  resultRevisionId: idSchema,
  reportId: idSchema.nullable(),
});
export const amendmentReceiptSchema = z.strictObject({
  resultId: idSchema,
  revisionId: idSchema,
  reportId: idSchema.nullable(),
});
export const resultReceiptStatusSchema = z.strictObject({
  receipt: resultSubmissionReceiptSchema,
  currentDelivery: z.strictObject({
    missingFileIds: z.array(idSchema),
    status: z.enum(['complete', 'incomplete']),
  }),
});
export const executionRecordQuerySchema = z.strictObject({
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  kind: z.enum(['all', 'UI', 'API']).default('all'),
  source: z.enum(['formal', 'archive']).default('formal'),
  state: runStateSchema.optional(),
  search: z.string().trim().max(200).default(''),
});
export const executionRecordSchema = z.strictObject({
  runId: idSchema,
  reportId: idSchema.nullable(),
  reportRevisionId: idSchema.nullable(),
  name: z.string(),
  kind: z.enum(['UI', 'API']),
  source: z.enum(['manual', 'scheduled', 'localUi', 'retest','uiArchive']),
  state: runStateSchema,
  environment: z.strictObject({ id: idSchema, name: z.string() }),
  productBuild: z.string().nullable(),
  createdBy: z.strictObject({
    id: idSchema,
    name: z.string(),
    active: z.boolean(),
  }),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  totalItems: count,
  completedItems: count,
  reportedItems: count,
  missingFileCount: count,
  deliveryStatus: deliveryStatusSchema,
  cleanupState: cleanupStateSchema,
  executionProvenance: z.enum([
    'local-ai',
    'protocol-synthetic',
    'unknown',
    'platform-api',
  ]),
  progressClosedAt: z.string().nullable(),
  lastProgressAt: z.string().nullable(),
  currentCase: z
    .strictObject({
      runItemId: idSchema,
      title: z.string(),
      ordinal: z.number().int().nonnegative(),
    })
    .nullable(),
  requirementCount: count,
  requirementPreview: z
    .array(
      z.strictObject({
        id: idSchema,
        title: z.string(),
        versionNo: z.number().int().positive(),
      }),
    )
    .max(3),
  invalidResultCount: count,
  assessmentBasisChangedCount: count,
  statistics: z
    .strictObject({
      denominator: count,
      reportedItems: count,
      original: outcomeCounts,
      reported: outcomeCounts,
      final: outcomeCounts.extend({ notAssessed: count }),
      effective: outcomeCounts,
    })
    .nullable(),
  rowVersion: persistedRowVersionSchema,
});
export const executionRecordListSchema = z.strictObject({
  records: z.array(executionRecordSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: count,
  hasMore: z.boolean(),
});
