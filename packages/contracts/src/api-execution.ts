import { z } from 'zod';
import { idSchema,commandIdSchema,sha256Schema, persistedRowVersionSchema } from './base.js';
import { assetSchema } from './assets.js';
import {
scopeItemSchema,
apiCaseContentSchema,
apiDataRowAnchorSchema,
executionScopeSchema,
assertionSchema,
runStateSchema,
} from './domain.js';

const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;
export interface WorkerScriptOutput {
  variables: Record<string, JsonValue>;
  assertions: { passed: boolean; message: string }[];
}
export const runtimeVariablesSchema = z.strictObject({
  case: z.record(z.string(), jsonSchema),
  extract: z.record(z.string(), jsonSchema),
});
export const apiPhaseSchema = z.enum([
  'auth',
  'business',
  'cleanupHttp',
  'cleanupSql',
]);
export const workerActionInputSchema = z.strictObject({
  runItemId: idSchema,
  phase: apiPhaseSchema,
  stepId: z.string().min(1).max(200),
  forPhase: z.enum(['business', 'cleanupHttp']).optional(),
  forStepId: z.string().min(1).max(200).optional(),
  variables: runtimeVariablesSchema,
});
export const safeResponseSchema = z.strictObject({
  status: z.number().int().min(100).max(599).nullable(),
  headers: z.record(z.string(), z.string()),
  body: jsonSchema,
  elapsedMs: z.number().int().min(0),
  errorCode: z.string().max(100).nullable(),
  redactionVersion: z.literal('ath.api-redaction.v1'),
});
const evidenceScalar = z.union([z.string().max(512),z.number(),z.boolean(),z.null()]);
export const apiRecordedAssertionSchema = z.strictObject({
  passed: z.boolean(),
  message: z.string().max(2000),
  comparison: z.strictObject({
    id: z.string().max(200), field: z.string().max(2000), operator: z.string().max(100),
    expected: evidenceScalar, actual: evidenceScalar,
  }).optional(),
});
export const attemptReceiptInputSchema = z.strictObject({
  intentId: idSchema,
  response: safeResponseSchema,
  passed: z.boolean(),
  reason: z.string().max(10000),
  sideEffectCertainty: z.enum(['known', 'unknown', 'notApplicable']),
  extractions: z.record(z.string(), jsonSchema).default({}),
  assertions: z
    .array(apiRecordedAssertionSchema)
    .max(1000)
    .default([]),
  authToken: z.string().min(1).max(16384).optional(),
});
export const localStepFailureInputSchema = z.strictObject({
  runItemId: idSchema,
  phase: z.enum(['business', 'cleanupHttp', 'cleanupSql']),
  stepId: z.string().min(1).max(200),
  code: z.string().min(1).max(100),
  reason: z.string().max(10000),
  skipped: z.boolean().default(false),
});
export const apiCaseCompletionInputSchema = z.strictObject({
  runItemId: idSchema,
  outcome: z.enum(['passed', 'failed', 'notExecuted']),
  reason: z.string().max(10000),
});
export const apiStopInputSchema = z.strictObject({
  commandId: commandIdSchema,
});
export const apiStopReceiptSchema = z.strictObject({ state: runStateSchema });
export const apiStopStatusSchema=z.strictObject({commandId:commandIdSchema,runId:idSchema,status:z.enum(['pending','completed','failed','unknown']),response:apiStopReceiptSchema.nullable()});
export const workerInstanceInputSchema = z
  .strictObject({
    workerInstanceId: idSchema,
    desiredRunId: idSchema.optional(),
    desiredRequestId: idSchema.optional(),
  })
  .refine((value) => !(value.desiredRunId && value.desiredRequestId), {
    message: '只能指定一个固定run或queued request',
  });
export type RuntimeVariables = z.infer<typeof runtimeVariablesSchema>;
export type ApiPhase = z.infer<typeof apiPhaseSchema>;
export type SafeResponse = z.infer<typeof safeResponseSchema>;
export interface HttpTransport {
  type: 'http';
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}
export interface SqlTransport {
  type: 'sql';
  driver: 'postgresql' | 'mysql';
  host: string;
  port: number;
  database: string;
  tls: boolean;
  username: string;
  password: string;
  statement: string;
  values: (string | number | boolean)[];
  timeoutMs: number;
}
// Private worker protocol only. These values must never enter public run/AI/MCP responses.
export type WorkerTransport = HttpTransport | SqlTransport;
export const debugScopeItemSchema = scopeItemSchema.extend({
  caseId: idSchema.nullable(),
  approvalSnapshotId: z.null(),
  content: apiCaseContentSchema,
});
export const debugExecutionScopeSchema = z.strictObject({
  ...executionScopeSchema.shape,
  schemaVersion: z.literal('ath.debug-execution-scope.v1'),
  kind: z.literal('API'),
  sourceType: z.literal('debug'),
  items: z.array(debugScopeItemSchema).min(1).max(1),
  draftHash: sha256Schema,
  cleanupApprovalSnapshotId: idSchema.nullable(),
});
export const apiExecutionScopeSchema = z.discriminatedUnion('schemaVersion', [
  executionScopeSchema,
  debugExecutionScopeSchema,
]);
export const apiScopeItemSchema = z.union([
  scopeItemSchema,
  debugScopeItemSchema,
]);
export const startDebugInputSchema = z
  .strictObject({
    commandId: commandIdSchema,
    environmentId: idSchema,
    dataRowId: apiDataRowAnchorSchema.shape.id.optional(),
    productBuild: z.string().max(200).nullable(),
    sourceCaseId: idSchema.nullable(),
    sourceCaseRevisionId: idSchema.nullable(),
    scenarioRevisionId: idSchema.optional(),
    content: apiCaseContentSchema,
  })
  .refine(
    (input) =>
      input.sourceCaseId !== null || input.sourceCaseRevisionId === null,
    { path: ['sourceCaseRevisionId'], message: '未保存新用例没有正式来源修订' },
  );
export type ApiExecutionScope = z.infer<typeof apiExecutionScopeSchema>;
export type ApiScopeItem = z.infer<typeof apiScopeItemSchema>;
export const apiExecutionStatusSchema = z.strictObject({
  run: z.strictObject({
    id: idSchema,
    runSnapshotId: idSchema,
    state: z.string(),
    deliveryStatus: z.string(),
    cleanupState: z.string(),
    scope: apiExecutionScopeSchema,
    createdAt: z.iso.datetime(),
  }),
});
export const debugStartReceiptSchema = z.strictObject({
  runId: idSchema,
  state: z.literal('prepared'),
  draftHash: sha256Schema,
  sourceChanged: z.boolean(),
  formal: z.literal(false),
  approvalSnapshotId: z.null(),
  cleanupApprovalSnapshotId: idSchema.nullable(),
  debugResultUrl: z.string(),
});
export const debugReceiptLookupSchema = z.strictObject({
  commandId: commandIdSchema,
  status: z.enum(['accepted', 'pending', 'failed', 'unknown']),
  receipt: debugStartReceiptSchema.nullable(),
});
export const apiRegressionQualificationSchema = z.strictObject({
  snapshotId: idSchema,
  caseId: idSchema,
  revisionId: idSchema,
  revisionNo: z.number().int().positive(),
  source: z.enum(['debugPassed', 'legacyApproval']),
  debugRunId: idSchema.nullable(),
  environmentId: idSchema.nullable(),
  savedAt: z.iso.datetime(),
});
export const apiRegressionQualificationListSchema = z.strictObject({
  qualifications: z.array(apiRegressionQualificationSchema),
});
export const saveApiRegressionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  caseId: idSchema,
  baseRevisionId: idSchema,
  rowVersion: persistedRowVersionSchema,
  debugRunId: idSchema,
  draftHash: sha256Schema,
  content: apiCaseContentSchema,
});
export const withdrawApiRegressionInputSchema = z.strictObject({
  commandId: commandIdSchema,
  snapshotId: idSchema,
  reason: z.string().trim().min(1).max(1000),
});
export const apiRegressionSaveReceiptSchema = z.strictObject({
  asset: assetSchema,
  qualification: apiRegressionQualificationSchema,
});
export const apiRegressionSaveStatusSchema = z.strictObject({
  commandId: commandIdSchema,
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: apiRegressionSaveReceiptSchema.nullable(),
});
export const apiRegressionWithdrawReceiptSchema = z.strictObject({
  snapshotId: idSchema,
  withdrawnAt: z.iso.datetime(),
});
export const apiAttemptDetailSchema = z.strictObject({
  attempt: z.strictObject({
    id: idSchema,
    phase: apiPhaseSchema,
    step_id: z.string(),
    state: z.enum(['intent', 'completed', 'unknown', 'failed', 'skipped']),
    outcome: z.enum(['passed', 'failed']).nullable(),
    send_intent_at: z.iso.datetime().nullable(),
    side_effect_certainty: z.enum(['known', 'unknown', 'notApplicable']),
    request_safe: z.json(),
    response_safe: safeResponseSchema.nullable(),
    extractions_safe: z.record(z.string(), z.json()),
    assertions_safe: z.array(apiRecordedAssertionSchema),
    reason: z.string(),
  }),
});
export const apiResultTraceSchema = z.strictObject({
  attempts: z.array(
    apiAttemptDetailSchema.shape.attempt.pick({
      id: true,
      phase: true,
      step_id: true,
      state: true,
      outcome: true,
      send_intent_at: true,
      side_effect_certainty: true,
      reason: true,
    }).extend({
      step_name: z.string().nullable(),
      status: safeResponseSchema.shape.status,
      elapsed_ms: safeResponseSchema.shape.elapsedMs.nullable(),
    }),
  ).max(1000),
});
export const debugTraceSchema = z.strictObject({
  runId: idSchema,
  state: z.string(),
  formal: z.literal(false),
  approvalSnapshotId: z.null(),
  draftHash: sha256Schema,
  scope: debugExecutionScopeSchema,
  evaluationStatus: z.enum([
    'notStarted',
    'inProgress',
    'notConfigured',
    'evaluated',
    'notExecuted',
  ]),
  facts: z.array(
    z.strictObject({
      runItemId: idSchema,
      originalOutcome: z.enum(['passed', 'failed', 'notExecuted']).nullable(),
      cleanupState: z.string(),
      sideEffectCertainty: z.enum(['known', 'unknown', 'notApplicable']),
      reason: z.string(),
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime().nullable(),
    }),
  ),
  steps: z.array(
    z.strictObject({
      id: idSchema,
      phase: apiPhaseSchema,
      stepId: z.string(),
      state: z.string(),
      outcome: z.enum(['passed', 'failed']).nullable(),
      reason: z.string(),
      sideEffectCertainty: z.enum(['known', 'unknown', 'notApplicable']),
    }),
  ),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  qualificationRetained: z.boolean().optional(),
  qualificationEnvironment: z.boolean().optional(),
});
export interface SendPermit {
  send: true;
  intentId: string;
  transport: WorkerTransport;
  protectedValues: string[];
  assertions?: z.infer<typeof assertionSchema>[];
  authExtractor?: { source: 'json' | 'header' | 'body'; path: string };
}
export const workerRunPackageSchema = z.strictObject({
  runId: idSchema,
  snapshotDigest: z.string(),
  scope: apiExecutionScopeSchema,
  items: z.array(
    z.strictObject({
      scopeItem: z.union([
        scopeItemSchema.safeExtend({ content: apiCaseContentSchema }),
        debugScopeItemSchema,
      ]),
      environment: z.record(z.string(), jsonSchema),
      auth: z.record(
        z.string(),
        z.strictObject({
          mode: z.enum(['token', 'login']),
          cacheKey: z.string(),
        }),
      ),
    }),
  ),
});
export type WorkerRunPackage = z.infer<typeof workerRunPackageSchema>;
