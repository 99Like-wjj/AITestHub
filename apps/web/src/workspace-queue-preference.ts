import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { currentIdentityOwner } from './identity-context';

const sendModeSchema = z.enum(['queue', 'steer']);
const preferenceSchema = z.strictObject({
  schemaVersion: z.literal('ath.workspace-send-mode-preference.v1'),
  ownerId: idSchema,
  mode: sendModeSchema,
});

export type WorkspaceSendMode = z.infer<typeof sendModeSchema>;

export const WORKSPACE_SEND_MODE_CHANGED_EVENT =
  'aitesthub:workspace-send-mode-changed';

export const workspaceSendModeStorageKey = (ownerId: string) =>
  `aitesthub:workspace-send-mode:${idSchema.parse(ownerId)}`;

function requireCurrentOwner(ownerId: string) {
  idSchema.parse(ownerId);
  if (currentIdentityOwner() !== ownerId)
    throw new Error('登录身份已更新，请重新核对后设置发送偏好。');
}

/** This browser preference affects new drafts only, never an accepted task or
 * queued snapshot. Invalid stored values remain intact for inspection. */
export function readWorkspaceSendMode(ownerId: string): WorkspaceSendMode {
  requireCurrentOwner(ownerId);
  const saved = window.localStorage.getItem(
    workspaceSendModeStorageKey(ownerId),
  );
  if (saved === null) return 'queue';
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    return 'queue';
  }
  const preference = preferenceSchema.safeParse(value);
  return preference.success && preference.data.ownerId === ownerId
    ? preference.data.mode
    : 'queue';
}

/** Storage errors propagate so the caller can retain the previous selection
 * and report that the preference was not saved. */
export function saveWorkspaceSendMode(
  ownerId: string,
  mode: WorkspaceSendMode,
): void {
  requireCurrentOwner(ownerId);
  const preference = preferenceSchema.parse({
    schemaVersion: 'ath.workspace-send-mode-preference.v1',
    ownerId,
    mode,
  });
  window.localStorage.setItem(
    workspaceSendModeStorageKey(ownerId),
    JSON.stringify(preference),
  );
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_SEND_MODE_CHANGED_EVENT, { detail: { ownerId } }),
  );
}
