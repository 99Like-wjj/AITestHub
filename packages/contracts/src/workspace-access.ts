import { z } from 'zod';
import { commandIdSchema, rowVersionSchema } from './base.js';

export const workspaceAccessModeSchema = z.enum(['full', 'restricted']);
export type WorkspaceAccessMode = z.infer<typeof workspaceAccessModeSchema>;

export const defaultWorkspaceAccessMode: WorkspaceAccessMode = 'full';

export const workspaceAccessPreferenceSchema = z.strictObject({
  mode: workspaceAccessModeSchema.nullable(),
  rowVersion: rowVersionSchema,
});
export type WorkspaceAccessPreference = z.infer<
  typeof workspaceAccessPreferenceSchema
>;

export const workspaceAccessPreferenceInputSchema =
  workspaceAccessPreferenceSchema.extend({
    commandId: commandIdSchema,
    mode: workspaceAccessModeSchema,
  });

export function workspaceDataScope(mode: WorkspaceAccessMode) {
  return mode === 'full'
    ? ('authorizedRelevantTestData' as const)
    : ('syntheticPublicOnly' as const);
}
