import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  persistedRowVersionSchema,
  rowVersionSchema,
  sha256Schema,
  timestampSchema,
} from './base.js';
import {
  sandboxLimits,
  sandboxPathSchema,
  sandboxStateSchema,
} from './agent-sandbox.js';
import {
  workspaceEntrySchema,
  workspaceImportSchema,
  workspacePathSchema,
  workspaceReceiptSchema,
} from './agent-workspace.js';

export const calculationInputFileSchema = z.strictObject({
  entryId: idSchema,
  revision: persistedRowVersionSchema,
  path: sandboxPathSchema,
});
export const calculationOutputFileSchema = z.strictObject({
  path: sandboxPathSchema,
  workspacePath: workspacePathSchema.describe(
    '产物在会话工作区的完整相对路径，保留用户指定的全部目录前缀；与沙箱内path分别指定。',
  ),
  expectedRowVersion: rowVersionSchema,
  mediaType: z.string().min(1).max(256),
});
export const calculationRunInputSchema = z
  .strictObject({
    commandId: commandIdSchema,
    code: z.string().min(1).max(sandboxLimits.maxCodeBytes),
    inputs: z
      .array(calculationInputFileSchema)
      .max(sandboxLimits.maxFiles)
      .default([]),
    outputs: z
      .array(calculationOutputFileSchema)
      .max(sandboxLimits.maxFiles)
      .default([]),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(sandboxLimits.maxRuntimeMs)
      .default(30_000),
  })
  .superRefine((input, context) => {
    for (const [key, values] of [
      ['inputs', input.inputs.map((file) => file.path)],
      ['outputs', input.outputs.map((file) => file.path)],
      ['outputs', input.outputs.map((file) => file.workspacePath)],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: '文件路径不可重复。',
        });
  });
export type CalculationRunInput = z.infer<typeof calculationRunInputSchema>;
export const calculationStateSchema = z.enum([
  'prepared',
  'running',
  'publishing',
  'completed',
  'execution_failed',
  'cancelled',
  'artifact_conflict',
  'unknown',
]);
export const calculationSourceSnapshotSchema = z.strictObject({
  ...calculationInputFileSchema.shape,
  resourceId: idSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative().max(sandboxLimits.maxFileBytes),
});
export const calculationArtifactSchema = z.strictObject({
  sandboxPath: sandboxPathSchema,
  entry: workspaceEntrySchema,
  downloadPath: z.string().max(2000),
});
export const calculationReceiptSchema = z.strictObject({
  runId: idSchema,
  taskId: idSchema,
  state: calculationStateSchema,
  executionState: sandboxStateSchema.nullable(),
  cleanupConfirmed: z.boolean().nullable(),
  cancelRequested: z.boolean(),
  requestSha256: sha256Schema,
  sources: z.array(calculationSourceSnapshotSchema),
  artifacts: z.array(calculationArtifactSchema),
  stdout: z.string().max(16_000),
  stderr: z.string().max(16_000),
  outputPartial: z.boolean(),
  stdoutCharacters: z.number().int().nonnegative(),
  stderrCharacters: z.number().int().nonnegative(),
  errorCode: z.string().max(100).nullable(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  replayed: z.boolean(),
  automaticReplay: z.literal(false),
});
export type CalculationReceipt = z.infer<typeof calculationReceiptSchema>;
export const calculationImportInputSchema = workspaceImportSchema.safeExtend({
  path: workspacePathSchema.describe('原件在会话工作区中的完整相对路径。'),
});
export const calculationImportReceiptSchema = workspaceReceiptSchema.extend({
  commandId: commandIdSchema,
  taskId: idSchema,
  sourceResourceId: idSchema,
  sourceResourceIds: z.array(idSchema).length(1),
  automaticReplay: z.literal(false),
});
export const calculationImportStatusSchema = z.strictObject({
  commandId: commandIdSchema,
  originTaskId: idSchema,
  found: z.boolean(),
  receipt: calculationImportReceiptSchema.nullable(),
  sourceResourceIds: z.array(idSchema).max(1),
  automaticReplay: z.literal(false),
  notice: z.string(),
});
export const agentCalculationToolInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('files'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  calculationImportInputSchema.safeExtend({
    action: z.literal('import_resource'),
  }),
  z.strictObject({
    action: z.literal('import_status'),
    commandId: commandIdSchema,
    originTaskId: idSchema
      .optional()
      .describe('原导入所属taskId；后续任务恢复时传原值，省略表示当前任务。'),
  }),
  calculationRunInputSchema.safeExtend({ action: z.literal('run') }),
  z.strictObject({ action: z.literal('status'), runId: idSchema }),
  z.strictObject({ action: z.literal('cancel'), runId: idSchema }),
  z.strictObject({
    action: z.literal('read_output'),
    runId: idSchema,
    channel: z.enum(['stdout', 'stderr']),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(20_000).default(10_000),
  }),
]);
