import { z } from 'zod';
import { idSchema } from './base.js';
import { requirementLifecycleSchema } from './domain.js';
import { executionRecordSchema } from './ui-results.js';
const count = z.number().int().nonnegative();
export const projectOverviewSchema = z.strictObject({
  projectId: idSchema,
  stats: z.strictObject({
    ongoingRequirements: count,
    inactiveOngoingRequirements: count,
    pendingCases: count,
    pendingUiCases: count,
    pendingApiCases: count,
    openIssues: count,
    executionRecords: count,
  }),
  myWork: z.strictObject({
    pendingCases: count,
    pendingProblems: count,
    ownedOpenIssues: count,
    incompleteDeliveries: count,
  }),
  participatingRequirements: z
    .array(
      z.strictObject({
        id: idSchema,
        title: z.string(),
        businessNumber: z.string().nullable(),
        latestVersionId: idSchema,
        latestVersionNo: z.number().int().positive(),
        lifecycle: requirementLifecycleSchema,
        inactive: z.boolean().default(false),
        archivedAt: z.string().nullable(),
      }),
    )
    .max(6),
  participatingRequirementsTotal: count,
  recentExecutions: z.array(executionRecordSchema).max(5),
  capturedAt: z.string(),
});
