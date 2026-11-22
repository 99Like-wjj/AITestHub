import { z } from 'zod';
import {
  commandIdSchema,
  idSchema,
  kindSchema,
  persistedRowVersionSchema,
  timestampSchema,
  titleSchema,
} from './base.js';

export const coverageCheckpointScopeSchema = z.strictObject({
  requirementVersionId: idSchema,
  kind: kindSchema,
});

const checkpointContent = {
  title: titleSchema,
  source: z.string().trim().min(1).max(4000),
  scenarioId: idSchema.nullable(),
  caseIds: z
    .array(idSchema)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, '关联用例不可重复。'),
};

export const coverageCheckpointSchema = coverageCheckpointScopeSchema.extend({
  ...checkpointContent,
  id: idSchema,
  rowVersion: persistedRowVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const coverageCheckpointListSchema = z.strictObject({
  items: z.array(coverageCheckpointSchema),
});

export const saveCoverageCheckpointInputSchema = coverageCheckpointScopeSchema
  .extend({
    ...checkpointContent,
    commandId: commandIdSchema,
    checkpointId: idSchema.optional(),
    rowVersion: persistedRowVersionSchema.optional(),
  })
  .refine(
    (input) =>
      (input.checkpointId === undefined) === (input.rowVersion === undefined),
    '更新检查点必须指定原检查点和编辑基准。',
  );

export const saveCoverageCheckpointResultSchema = z.strictObject({
  checkpoint: coverageCheckpointSchema,
});

export type CoverageCheckpoint = z.infer<typeof coverageCheckpointSchema>;
