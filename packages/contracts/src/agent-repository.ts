import { z } from 'zod';
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const path = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !/[\\\u0000-\u001f\u007f:]/.test(value) &&
      value
        .split('/')
        .every((part) => part && !['.', '..', '.git'].includes(part)),
  );
const page = {
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(200).default(80),
};
export const agentRepositoryInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect'), resourceId: z.uuid() }),
  z.strictObject({
    action: z.literal('history'),
    resourceId: z.uuid(),
    commit,
  }),
  z.strictObject({
    action: z.literal('tree'),
    resourceId: z.uuid(),
    commit,
    prefix: path.optional(),
    ...page,
  }),
  z.strictObject({
    action: z.literal('read'),
    resourceId: z.uuid(),
    commit,
    path,
    ...page,
  }),
  z.strictObject({
    action: z.literal('diff'),
    resourceId: z.uuid(),
    commit,
    baseCommit: commit,
    path: path.optional(),
    ...page,
  }),
]);
export type AgentRepositoryInput = z.infer<typeof agentRepositoryInputSchema>;
export const agentRepositoryResultSchema = z.strictObject({
  action: z.enum(['inspect', 'history', 'tree', 'read', 'diff']),
  commit: commit.nullable(),
  baseCommit: commit.nullable(),
  references: z
    .array(z.strictObject({ name: z.string().max(1000), commit }))
    .max(2000),
  commits: z
    .array(z.strictObject({ commit, parents: z.array(commit).max(64) }))
    .max(8)
    .default([]),
  entries: z
    .array(
      z.strictObject({
        path: z.string().max(1000),
        kind: z.enum(['file', 'directory', 'symlink', 'submodule', 'changed']),
        objectId: z.string().max(64),
        sizeBytes: z.number().int().min(0).nullable(),
      }),
    )
    .max(200),
  text: z.string().max(60000),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
  total: z.number().int().min(0),
  partial: z.boolean(),
});
