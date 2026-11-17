import { z } from 'zod';

/** Persisted execution authority; callers cannot select it in message inputs. */
export const aiTaskExecutionPolicySchema = z.enum([
  'interactive',
  'draftOnly',
  'officeOnly',
]);
export type AiTaskExecutionPolicy = z.infer<typeof aiTaskExecutionPolicySchema>;
