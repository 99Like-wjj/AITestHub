import { z } from 'zod';
export const agentMemoryEntrySchema = z.strictObject({
  id: z.uuid(),
  title: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(2000),
  enabled: z.boolean(),
  rowVersion: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  availability: z.enum(['available', 'restoredNeedsReview']),
});
export const agentMemoryGapSchema = z.strictObject({
  id: z.uuid(),
  rowVersion: z.number().int().positive(),
  reason: z.literal('notInBackup'),
});
export const agentMemoryListSchema = z.strictObject({
  enabled: z.boolean(),
  rowVersion: z.number().int().min(0),
  entries: z.array(agentMemoryEntrySchema).max(20),
  unavailableEntries: z.array(agentMemoryGapSchema).max(20),
});
export const agentMemorySaveSchema = z.strictObject({
  id: z.uuid(),
  rowVersion: z.number().int().min(0),
  title: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(2000),
  enabled: z.boolean(),
});
export const agentMemoryDeleteSchema = z.strictObject({
  rowVersion: z.number().int().positive(),
});
export const agentMemoryPreferenceSchema = z.strictObject({
  rowVersion: z.number().int().min(0),
  enabled: z.boolean(),
});
export type AgentMemoryEntry = z.infer<typeof agentMemoryEntrySchema>;
