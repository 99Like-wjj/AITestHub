import { z } from 'zod';

export const workspaceAccessModeSchema = z.enum(['full', 'restricted']);
export type WorkspaceAccessMode = z.infer<typeof workspaceAccessModeSchema>;

export function workspaceDataScope(mode: WorkspaceAccessMode) {
  return mode === 'full'
    ? ('authorizedRelevantTestData' as const)
    : ('syntheticPublicOnly' as const);
}
