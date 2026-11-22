import { z } from 'zod';
import { idSchema, safeTextSchema, timestampSchema } from './base.js';
import {
  conversationReferenceInputSchema,
  operationTargetSchema,
} from './conversations.js';
import { platformGuidanceSkillIdSchema } from './skill-guidance.js';

export const workspaceDraftKeySchema = z.string().refine((key) => {
  if (key === 'new:personal') return true;
  const id = key.startsWith('new:detached:')
    ? key.slice('new:detached:'.length)
    : key.startsWith('new:')
      ? key.slice('new:'.length)
      : key;
  return id === id.toLowerCase() && idSchema.safeParse(id).success;
}, '草稿标识无效。');

const insertionSchema = z
  .strictObject({
    start: z.number().int().min(0).max(100_000),
    end: z.number().int().min(0).max(100_000),
    text: z.string().max(2500),
    restoreText: z.string().max(100_000).optional(),
  })
  .refine(
    (insertion) => insertion.end - insertion.start === insertion.text.length,
    '引用插入位置无效。',
  );

export const workspaceDraftInputSchema = z.strictObject({
  content: safeTextSchema,
  references: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        label: z.string().max(2400),
        note: z.string().max(2400),
        reference: conversationReferenceInputSchema,
        insertions: z.array(insertionSchema).max(1000).optional(),
      }),
    )
    .max(30),
  operationTarget: operationTargetSchema.nullable().optional(),
  skillIds: z.array(platformGuidanceSkillIdSchema).max(10).optional(),
});

export const workspaceDraftSaveSchema = z.strictObject({
  baseRevisionId: idSchema.nullable(),
  draft: workspaceDraftInputSchema,
});

export const workspaceDraftDeleteSchema = z.strictObject({
  revisionId: idSchema,
});

export const workspaceDraftResponseSchema = z.strictObject({
  draft: z
    .strictObject({
      revisionId: idSchema,
      draft: workspaceDraftInputSchema,
      updatedAt: timestampSchema,
    })
    .nullable(),
});

export const workspaceDraftListSchema = z.strictObject({
  drafts: z.array(
    z.strictObject({
      key: workspaceDraftKeySchema,
      updatedAt: timestampSchema,
    }),
  ),
});

export const workspaceDraftDeleteReceiptSchema = z.strictObject({
  deleted: z.boolean(),
});
