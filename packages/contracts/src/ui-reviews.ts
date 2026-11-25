import { z } from 'zod';
import { idSchema, persistedRowVersionSchema, timestampSchema, titleSchema } from './base.js';

export const uiCaseReviewStageListSchema=z.strictObject({
  items:z.array(z.strictObject({caseId:idSchema,revisionId:idSchema,rowVersion:persistedRowVersionSchema,
    stage:z.enum(['pending','needsOptimization','waitingHuman','approved']),reasons:z.array(z.string())})),
});

const caseSuggestionSchema=z.strictObject({id:idSchema,sourceRevisionId:idSchema,
  sourceRevisionNo:persistedRowVersionSchema,body:z.string().min(1).max(10000),createdBy:idSchema,
  createdAt:timestampSchema,response:z.string().nullable(),
});

export const uiCaseReviewDetailSchema=z.strictObject({
  caseId:idSchema,revisionId:idSchema,suggestions:z.array(caseSuggestionSchema),setTitle:titleSchema,
  latestApproval:z.strictObject({id:idSchema,revisionId:idSchema,revisionNo:persistedRowVersionSchema,approvedAt:timestampSchema}).nullable(),
});

export const uiPendingSuggestionsSchema=z.strictObject({
  cases:z.array(z.strictObject({caseId:idSchema,title:titleSchema,revisionId:idSchema,
    rowVersion:persistedRowVersionSchema,suggestions:z.array(caseSuggestionSchema)})),
});
