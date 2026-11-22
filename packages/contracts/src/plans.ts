import { z } from 'zod';
import {
commandIdSchema,
idSchema,
kindSchema,
persistedRowVersionSchema,
titleSchema,
timestampSchema,
} from './base.js';
import {
executionScopeSchema,
planSchema,
scopeItemSchema,
uiCaseContentSchema,
uiPlanSchema,
} from './domain.js';
import { testConfigurationDtoSchema } from './test-configuration.js';

const uniqueIds = z
  .array(idSchema)
  .max(10000)
  .refine((ids) => new Set(ids).size === ids.length, '对象不可重复');
export const uiPlanApprovalBasisSchema = z.strictObject({
  caseId: idSchema,
  approvalSnapshotId: idSchema,
});
export const createPlanInputSchema = z
  .strictObject({
    commandId: commandIdSchema,
    kind: kindSchema,
    name: titleSchema,
    environmentId: idSchema,
    productBuild: z.string().max(200).nullable(),
    requirementVersionId: idSchema.optional(),
    caseIds: uniqueIds.min(1),
    approvalBasis: z
      .array(uiPlanApprovalBasisSchema)
      .min(1)
      .max(10000)
      .optional(),
  })
  .superRefine((input, context) => {
    if (input.kind === 'UI' && !input.requirementVersionId)
      context.addIssue({
        code: 'custom',
        path: ['requirementVersionId'],
        message: 'UI计划须明确同一需求版本',
      });
    if (input.kind === 'API' && input.requirementVersionId)
      context.addIssue({
        code: 'custom',
        path: ['requirementVersionId'],
        message: '接口计划按逻辑case引用，需求版本由各case保留',
      });
    if (input.approvalBasis) {
      const selected = new Set(input.caseIds);
      const approvals = new Set(input.approvalBasis.map(({ caseId }) => caseId));
      if (
        input.kind !== 'UI' ||
        approvals.size !== input.approvalBasis.length ||
        input.approvalBasis.some(({ caseId }) => !selected.has(caseId))
      )
        context.addIssue({
          code: 'custom',
          path: ['approvalBasis'],
          message: '批准基准只能绑定本次已选的 UI 用例，每条用例最多一项。',
        });
    }
  });
export const revisePlanInputSchema = createPlanInputSchema
  .safeExtend({
    rowVersion: persistedRowVersionSchema,
    basePlanRevisionId: idSchema,
    refreshCaseIds: uniqueIds.optional(),
  })
  .superRefine((input, context) => {
    const selected = new Set(input.caseIds);
    if (
      input.refreshCaseIds?.length &&
      (input.kind !== 'UI' || input.refreshCaseIds.some((id) => !selected.has(id)))
    )
      context.addIssue({
        code: 'custom',
        path: ['refreshCaseIds'],
        message: '只能更新本次已选的 UI 用例修订',
      });
  });
export const renamePlanInputSchema = z.strictObject({
  commandId: commandIdSchema,
  rowVersion: persistedRowVersionSchema,
  basePlanRevisionId: idSchema,
  name: titleSchema,
});
export const uiPlanEligibilitySchema = z.strictObject({
  items: z.array(z.strictObject({
    caseId: idSchema,
    setId: idSchema,
    eligible: z.boolean(),
    approvalSnapshotId: idSchema.nullable(),
    approvedRevisionId: idSchema.nullable(),
    reasons: z.array(z.string()),
  })),
});
export const apiStartPreviewInputSchema = z.strictObject({
  commandId: commandIdSchema,
  planRevisionId: idSchema,
  source: z.enum(['manual', 'debug']).default('manual'),
});
export const apiQueueInputSchema = z.strictObject({
  commandId: commandIdSchema,
  previewId: idSchema,
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  selectedCaseIds: uniqueIds.min(1),
  confirmedExistingRunIds: uniqueIds.default([]),
  confirmedExistingRequestIds: uniqueIds.default([]),
});
export const apiStartPreviewSchema = z.strictObject({
  previewId: idSchema,
  planId: idSchema,
  planRevisionId: idSchema,
  source: z.enum(['manual', 'debug']),
  scopeDigest: z.string(),
  existingRunIds: uniqueIds,
  existingRequestIds: uniqueIds,
  items: z.array(
    z.strictObject({
      caseId: idSchema,
      title: z.string(),
      eligible: z.boolean(),
      approvalSnapshotId: idSchema.nullable(),
      reasons: z.array(
        z.strictObject({ code: z.string(), message: z.string() }),
      ),
    }),
  ),
  createdAt: z.string(),
});
export type CreatePlanInput = z.infer<typeof createPlanInputSchema>;
export const planListSchema = z.strictObject({ plans: z.array(planSchema) });
export const planReceiptSchema = z.strictObject({ plan: planSchema });
export const planDetailSchema = z.strictObject({
  plan: planSchema,
  display: z.strictObject({
    environmentName: z.string().nullable(),
    cases: z.array(z.strictObject({
      caseId: idSchema,
      title: z.string().nullable(),
      requirementVersionId: idSchema.nullable(),
      approvalSnapshotId: idSchema.nullable(),
    })),
  }),
  revisions: z.array(
    z.strictObject({
      id: idSchema,
      revisionNo: z.number().int().min(1),
      createdAt: z.string(),
    }),
  ),
});
export const planOperationLookupSchema = z.strictObject({
  operation: z.enum([
    'plans.create',
    'plans.revise',
    'plans.rename',
    'api-runs.start-preview',
    'api-runs.queue',
  ]),
  key: commandIdSchema,
});
export const planningOperationStatusSchema = z.strictObject({
  command: z.strictObject({
    id: idSchema,
    operation: z.string(),
    status: z.enum(['pending', 'completed', 'failed', 'unknown']),
    projectId: idSchema.nullable(),
    response: z.json(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
});
export const uiPlanTemplateSchema = z.strictObject({
  environment: testConfigurationDtoSchema,
  items: z.array(
    scopeItemSchema
      .omit({ runItemId: true })
      .safeExtend({ content: uiCaseContentSchema }),
  ),
});
export const uiPlanScopeSchema = z.strictObject({
  plan: uiPlanSchema,
  scope: uiPlanTemplateSchema,
});
export const apiRequestSchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  planRevisionId: idSchema,
  source: z.enum(['manual', 'scheduled', 'debug']),
  state: z.enum(['queued', 'started', 'notExecuted', 'cancelled']),
  runId: idSchema.nullable(),
  reasonCode: z.string().nullable(),
});
export const apiQueueReceiptSchema = z.strictObject({
  request: apiRequestSchema,
});
export const planRunSchema = z.strictObject({
  id: idSchema,
  runSnapshotId: idSchema,
  state: z.string(),
  deliveryStatus: z.string(),
  cleanupState: z.string(),
  scope: executionScopeSchema,
  createdAt: z.string(),
});
