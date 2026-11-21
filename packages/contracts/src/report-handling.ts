import { z } from 'zod';
import { idSchema,persistedRowVersionSchema,timestampSchema } from './base.js';
import { issueSeveritySchema,issueStateSchema,problemStateSchema } from './domain.js';
import { problemReviewRetestOutcomeSchema } from './issues.js';

/** Current business handling is separate from execution facts and statistics. */
export const reportHandlingSchema = z.strictObject({
  capturedAt: timestampSchema,
  problems: z.array(z.strictObject({
    id: idSchema,
    requirementId: idSchema,
    title: z.string(),
    state: problemStateSchema,
    suggestedSeverity: issueSeveritySchema,
    rowVersion: persistedRowVersionSchema,
    updatedAt: timestampSchema,
    resultIds: z.array(idSchema),
    issueIds: z.array(idSchema),
    sourceResultId: idSchema.nullable().optional(),
    sourceResultRevisionId: idSchema.nullable().optional(),
    resultSources: z.array(z.strictObject({
      resultId: idSchema,
      sourceRevisionId: idSchema,
    })).optional(),
    latestReviewRetest: z.strictObject({
      id: idSchema,
      outcome: problemReviewRetestOutcomeSchema,
      resultId: idSchema,
      resultRevisionId: idSchema,
      createdAt: timestampSchema,
    }).nullable().optional(),
  })),
  issues: z.array(z.strictObject({
    id: idSchema,
    number: z.string(),
    requirementId: idSchema,
    title: z.string(),
    severity: issueSeveritySchema,
    state: issueStateSchema,
    assignee: z.strictObject({ id: idSchema, displayName: z.string(), active: z.boolean() }).nullable(),
    mergedIntoId: idSchema.nullable(),
    rowVersion: persistedRowVersionSchema,
    updatedAt: timestampSchema,
    resultIds: z.array(idSchema),
    problemIds: z.array(idSchema),
    latestVerification: z.strictObject({
      id: idSchema,
      method: z.enum(['manual', 'UI', 'API']),
      outcome: z.enum(['passed', 'failed', 'inconclusive', 'notExecuted']),
      runId: idSchema.nullable(),
      createdAt: timestampSchema,
    }).nullable(),
  })),
  statistics: z.strictObject({
    problemCount: z.number().int().nonnegative(),
    pendingProblemCount: z.number().int().nonnegative(),
    confirmedProblemCount: z.number().int().nonnegative(),
    dismissedProblemCount: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
    openIssueCount: z.number().int().nonnegative(),
    mergedIssueCount: z.number().int().nonnegative(),
  }),
});
export type ReportHandling = z.infer<typeof reportHandlingSchema>;
