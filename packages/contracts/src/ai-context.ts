import { z } from 'zod';

/** Legacy authorization-changed records did not distinguish runtime recovery. */
export const aiContextResetReasonSchema = z.enum([
  'authorization-changed',
  'authorization-scope-changed',
  'access-mode-changed',
  'source-context-changed',
  'run-recovery',
  'context-rebuilt',
]);
export type AiContextResetReason = z.infer<typeof aiContextResetReasonSchema>;
