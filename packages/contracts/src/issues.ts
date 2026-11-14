import { z } from 'zod';
import {
idSchema,
commandIdSchema,
persistedRowVersionSchema,
rowVersionSchema,
titleSchema,
sha256Schema,
timestampSchema,
decimalCountSchema,
} from './base.js';
import {
issueSeveritySchema,
issueStateSchema,
problemStateSchema,
uiOutcomeSchema,
evidenceManifestItemSchema,
} from './domain.js';

const uniqueIds = z
  .array(idSchema)
  .max(1000)
  .refine((items) => new Set(items).size === items.length, '对象不可重复');
const description = z.string().min(1).max(100_000);
export const createIssueInputSchema = z.strictObject({
  commandId: commandIdSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  title: titleSchema,
  description,
  severity: issueSeveritySchema,
  manualOrigin: z.enum(['tester', 'product']),
  assigneeId: idSchema.nullable(),
  resultIds: uniqueIds.default([]),
});
export const confirmProblemInputSchema = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('new'),
    commandId: commandIdSchema,
    rowVersion: persistedRowVersionSchema,
    requirementId: idSchema,
    requirementVersionId: idSchema.nullable(),
    title: titleSchema,
    description,
    severity: issueSeveritySchema,
    assigneeId: idSchema.nullable(),
  }),
  z.strictObject({
    target: z.literal('existing'),
    commandId: commandIdSchema,
    rowVersion: persistedRowVersionSchema,
    issueId: idSchema,
    issueRowVersion: persistedRowVersionSchema,
  }),
]);
export const dismissProblemInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  note: z.string().max(10_000).default(''),
});
export const reportProblemInputSchema = z.strictObject({
  commandId: commandIdSchema,
  runId: idSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  title: titleSchema,
  description,
  suggestedSeverity: issueSeveritySchema,
  resultIds: uniqueIds.default([]),
  localEvidenceIds: z.array(z.string().min(1).max(200)).max(100),
});
export const issueHandlingInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  action: z.enum([
    'claim',
    'assign',
    'transfer',
    'return',
    'takeover',
    'start-processing',
    'ready-for-retest',
  ]),
  assigneeId: idSchema.nullable().optional(),
  note: z.string().max(10_000).default(''),
});
export const issueEditInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  title: titleSchema,
  description,
  severity: issueSeveritySchema,
});
export const issueSeverityInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  severity: issueSeveritySchema,
});
export const manualVerificationInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  outcome: z.enum(['passed', 'failed']),
  note: z.string().max(10_000).default(''),
  attachmentFileIds: uniqueIds.default([]),
  returnToInProgress: z.boolean().default(false),
  scopeDescription: z.string().trim().max(10_000).optional(),
});
export const manualVerificationScopeSchema = z.strictObject({
  issueId: idSchema,
  issueRowVersion: persistedRowVersionSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  requirementVersionNo: z.number().int().positive().nullable(),
  scopeDescription: z.string(),
});
export const lifecyclePreviewInputSchema = z.strictObject({
  commandId: commandIdSchema,
  action: z.enum(['close', 'reopen']),
  objectIds: uniqueIds.min(1),
});
export const lifecycleCommitInputSchema = z.strictObject({
  commandId: commandIdSchema,
  previewId: idSchema,
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  objectIds: uniqueIds.min(1),
});
export const singleIssueLifecycleInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  action: z.enum(['close', 'reopen']),
  resolution: z.enum(['fixed', 'notDefect']).default('fixed'),
  note: z.string().max(10_000).default(''),
});
export const mergeIssuesInputSchema = z.strictObject({
  commandId: commandIdSchema,
  masterId: idSchema,
  masterRowVersion: persistedRowVersionSchema,
  sourceIds: uniqueIds.min(1),
  sourceRowVersions: z.record(idSchema, persistedRowVersionSchema),
});
export const unmergeIssueInputSchema = z.strictObject({
  commandId: commandIdSchema,
  mergeId: idSchema,
  rowVersion: persistedRowVersionSchema,
});
export const issueListQuerySchema = z.strictObject({
  scope: z.enum(['all', 'mine', 'unassigned']).default('all'),
  participationOnly: z.boolean().default(true),
  includeArchivedRequirements: z.boolean().default(true),
  requirementId: idSchema.optional(),
  state: issueStateSchema.optional(),
  severity: issueSeveritySchema.optional(),
  assigneeId: idSchema.optional(),
  submittedBy: idSchema.optional(),
  search: z.string().max(200).default(''),
  includeMerged: z.boolean().default(true),
});
// Independent complete counts: requirement selection never narrows the tree query.
export const issueCountsQuerySchema = issueListQuerySchema
  .omit({ requirementId: true })
  .extend({
    unassignedOnly: z.boolean().default(false),
    problemState: problemStateSchema.optional(),
  });
export type IssueCountsQuery = z.infer<typeof issueCountsQuerySchema>;
const issueCountValuesSchema = z.strictObject({
  formal: decimalCountSchema,
  unassigned: decimalCountSchema,
  pendingTestConfirmation: decimalCountSchema,
});
export const issueCountsResponseSchema = z.strictObject({
  projectId: idSchema,
  filters: issueCountsQuerySchema,
  version: sha256Schema,
  calculatedAt: timestampSchema,
  totals: issueCountValuesSchema,
  requirements: z.array(
    z.strictObject({
      requirementId: idSchema,
      ...issueCountValuesSchema.shape,
    }),
  ),
  pendingConfirmationOwnership: z.literal('noAssignee'),
});
export type IssueCounts = z.infer<typeof issueCountsResponseSchema>;
export const issueSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  number: z.string(),
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  title: titleSchema,
  description,
  severity: issueSeveritySchema,
  state: issueStateSchema,
  assigneeId: idSchema.nullable(),
  assigneeActive: z.boolean(),
  mergedIntoId: idSchema.nullable(),
  source: z.enum(['manualTester', 'manualProduct', 'confirmedProblem']),
  submittedBy: idSchema,
  rowVersion: persistedRowVersionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  latestHandling: z
    .strictObject({
      action: z.string(),
      actorId: idSchema,
      previousOwnerId: idSchema.nullable(),
      newOwnerId: idSchema.nullable(),
      note: z.string(),
      createdAt: timestampSchema,
    })
    .nullable()
    .default(null),
});
export type Issue = z.infer<typeof issueSchema>;
export const problemListQuerySchema = z.strictObject({
  state: problemStateSchema.optional(),
  requirementId: idSchema.optional(),
  runId: idSchema.optional(),
  participationOnly: z.boolean().default(true),
  includeArchivedRequirements: z.boolean().default(true),
  search: z.string().max(200).default(''),
});
export const problemSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  requirementId: idSchema,
  requirementVersionId: idSchema.nullable(),
  runId: idSchema,
  sourceResultId: idSchema.nullable(),
  sourceResultRevisionId: idSchema.nullable(),
  title: titleSchema,
  description,
  suggestedSeverity: issueSeveritySchema,
  source: z.enum(['uiResult', 'apiResult', 'extraFinding']),
  state: problemStateSchema,
  createdBy: idSchema,
  rowVersion: persistedRowVersionSchema,
  decisionNote: z.string(),
  confirmedIssueId: idSchema.nullable(),
  sourceExecutionProvenance: z.enum([
    'local-ai',
    'protocol-synthetic',
    'unknown',
    'platform-api',
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const problemEvidenceSchema = z.strictObject({
  evidenceId: idSchema,
  fileId: idSchema,
  localEvidenceId: z.string(),
  manifest: evidenceManifestItemSchema,
  originalName: z.string(),
  fileStatus: z.string(),
  fileAvailable: z.boolean(),
  downloadPath: z.string(),
});
export const problemListResponseSchema = z.strictObject({
  problems: z.array(problemSchema),
});
export const problemResponseSchema = z.strictObject({ problem: problemSchema });
export const problemHistorySchema = z.strictObject({
  id: idSchema,
  action: z.string(),
  actorId: idSchema,
  payload: z.record(z.string(), z.json()),
  createdAt: timestampSchema,
});
export const problemDetailSchema = z.strictObject({
  problem: problemSchema,
  results: z.array(
    z.strictObject({
      resultId: idSchema,
      revisionId: idSchema,
      runId: idSchema,
      currentRevisionId: idSchema,
      sourceOutcome: uiOutcomeSchema,
      currentReportedOutcome: uiOutcomeSchema,
      finalOutcome: uiOutcomeSchema.nullable(),
    }),
  ),
  evidence: z.array(problemEvidenceSchema),
  history: z.array(problemHistorySchema),
});
export const problemConfirmationReceiptSchema = z.strictObject({
  problem: problemSchema,
  issue: issueSchema,
  alreadyConfirmed: z.boolean(),
});
export const problemDismissalReceiptSchema = z.strictObject({
  problem: problemSchema,
  alreadyDecided: z.boolean(),
});
export const problemConfirmationDecisionSchema = z.discriminatedUnion(
  'target',
  [
    confirmProblemInputSchema.options[0].omit({ commandId: true }),
    confirmProblemInputSchema.options[1].omit({ commandId: true }),
  ],
);
export const previewProblemBatchInputSchema = z.strictObject({
  commandId: idSchema,
  decisions: z
    .array(
      z.strictObject({
        problemId: idSchema,
        decision: problemConfirmationDecisionSchema,
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.problemId)).size === items.length,
      '问题选择不可重复',
    ),
});
export const commitProblemBatchInputSchema = z.strictObject({
  commandId: commandIdSchema,
  previewId: idSchema,
  scopeDigest: sha256Schema,
  problemIds: uniqueIds.min(1).max(100),
});
export const problemBatchPreviewSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  createdAt: timestampSchema,
  items: z.array(
    z.strictObject({
      problem: problemSchema,
      decision: problemConfirmationDecisionSchema,
      eligible: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export const problemBatchReceiptSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  results: z.array(
    z.strictObject({
      problemId: idSchema,
      status: z.enum(['confirmed', 'alreadyConfirmed', 'conflict', 'skipped']),
      issue: issueSchema.nullable(),
      code: z.string().nullable(),
    }),
  ),
});
export const issueListResponseSchema = z.strictObject({
  issues: z.array(issueSchema),
});
export const issueResponseSchema = z.strictObject({ issue: issueSchema });
export const issueEventSchema = z.strictObject({
  id: idSchema,
  action: z.string(),
  actorId: idSchema,
  previousOwnerId: idSchema.nullable(),
  newOwnerId: idSchema.nullable(),
  payload: z.record(z.string(), z.json()),
  createdAt: timestampSchema,
});
export const issueVerificationSchema = z.strictObject({
  id: idSchema,
  method: z.enum(['manual', 'UI', 'API']),
  outcome: z.enum(['passed', 'failed', 'inconclusive', 'notExecuted']),
  runId: idSchema.nullable(),
  note: z.string(),
  attachmentFileIds: uniqueIds,
  actorId: idSchema,
  createdAt: timestampSchema,
  executionProvenance: z
    .enum(['local-ai', 'protocol-synthetic', 'unknown', 'platform-api'])
    .nullable(),
  scopeSnapshot: manualVerificationScopeSchema.nullable().default(null),
});
export const issueMergeSchema = z.strictObject({
  id: idSchema,
  masterId: idSchema,
  sourceId: idSchema,
  rowVersion: persistedRowVersionSchema,
  actorId: idSchema,
  createdAt: timestampSchema,
  undoneAt: timestampSchema.nullable(),
});
export const issueDetailSchema = z.strictObject({
  issue: issueSchema,
  events: z.array(issueEventSchema),
  verifications: z.array(issueVerificationSchema),
  resultLinks: z.array(
    z.strictObject({ resultId: idSchema, revisionId: idSchema }),
  ),
  problemLinks: z.array(z.strictObject({ problemId: idSchema })),
  evidence: z.array(problemEvidenceSchema),
  mergedChildren: z.array(issueSchema),
  merges: z.array(issueMergeSchema),
});
export type Problem = z.infer<typeof problemSchema>;
export const manualVerificationReceiptSchema = z.strictObject({
  verificationId: idSchema,
  issue: issueSchema,
});
export const issueLifecyclePreviewSchema = z.strictObject({
  previewId: idSchema,
  action: z.enum(['close', 'reopen']),
  scopeDigest: sha256Schema,
  items: z.array(
    z.strictObject({
      id: idSchema,
      title: z.string(),
      number: z.string(),
      rowVersion: rowVersionSchema,
      state: issueStateSchema.nullable(),
      eligible: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export const issueLifecycleCommitReceiptSchema = z.strictObject({
  previewId: idSchema,
  scopeDigest: sha256Schema,
  results: z.array(
    z.discriminatedUnion('status', [
      z.strictObject({
        objectId: idSchema,
        status: z.literal('accepted'),
        issue: issueSchema,
      }),
      z.strictObject({
        objectId: idSchema,
        status: z.literal('conflict'),
        code: z.literal('STALE_BASE_REVISION'),
      }),
      z.strictObject({
        objectId: idSchema,
        status: z.literal('skipped'),
        code: z.literal('NOT_ELIGIBLE'),
      }),
    ]),
  ),
});
export const mergeIssuesReceiptSchema = z.strictObject({
  master: issueSchema,
  merges: z.array(
    z.strictObject({
      mergeId: idSchema,
      sourceId: idSchema,
      masterId: idSchema,
      rowVersion: persistedRowVersionSchema,
    }),
  ),
});
export const unmergeIssueReceiptSchema = z.strictObject({
  mergeId: idSchema,
  source: issueSchema,
  rowVersion: persistedRowVersionSchema,
});
