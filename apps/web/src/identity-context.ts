import { markIdentityCommandsUnknown } from './identity-commands';
import { clearStoredWorkspaceQueues } from './workspace-queue-storage';
const storageKey = 'aitesthub:identity-epoch:v1',
  eventName = 'aitesthub:identity-context-changed',
  channelName = 'aitesthub-identity-v1';
let epoch = 0,
  channel: BroadcastChannel | null = null,
  subscribers = 0;
let actorId: string | null = null,
  managed = false;
export type IdentityChangeReason =
  | 'login'
  | 'logout'
  | 'password-changed'
  | 'password-reset'
  | 'session-expired'
  | 'account-security-changed'
  | 'session-unknown';
let lastReason: IdentityChangeReason = 'session-unknown';
export const lastIdentityChangeReason = () => lastReason;
export function identityChangeNotice(reason: IdentityChangeReason) {
  if (reason === 'login' || reason === 'logout') return undefined;
  if (reason === 'password-changed' || reason === 'password-reset')
    return '密码已更新，请重新登录。';
  if (reason === 'session-expired')
    return '登录会话已到期，请重新登录。旧页面范围已清除；原操作回执仍按原身份查询。';
  if (reason === 'account-security-changed')
    return '当前身份或权限范围已更新，旧页面范围已清除。请按当前身份继续；原操作回执仍按原身份查询。';
  return '登录状态已更新或失效，请重新核对当前身份。旧页面范围已清除；原操作回执仍按原身份查询。';
}
export function setIdentityOwner(userId: string | null) {
  managed = true;
  actorId = userId;
}
export const currentIdentityOwner = () => actorId;
export const identityRecheckPending = () => managed && actorId === null;
const seen = new Set<string>();
function valid(value: unknown): value is { nonce: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nonce' in value &&
    typeof value.nonce === 'string' &&
    /^[a-f0-9-]{36}$/i.test(value.nonce)
  );
}
function receive(
  value: unknown,
  reason: IdentityChangeReason = 'session-unknown',
) {
  if (typeof window === 'undefined' || !valid(value) || seen.has(value.nonce))
    return;
  seen.add(value.nonce);
  if (seen.size > 128) seen.delete(seen.values().next().value!);
  epoch += 1;
  lastReason = reason;
  actorId = null;
  clearStoredWorkspaceQueues();
  markIdentityCommandsUnknown();
  window.dispatchEvent(new Event(eventName));
}
const onStorage = (event: StorageEvent) => {
  if (event.key !== storageKey || !event.newValue) return;
  try {
    receive(JSON.parse(event.newValue));
  } catch {
    /* Unrelated/corrupt notifications never supply identity data. */
  }
};
/** Not an authentication token. This is a per-document invalidation counter only. */
export const identityContextEpoch = () => epoch;
export function announceIdentityChange(
  reason: IdentityChangeReason = 'session-unknown',
) {
  if (typeof window === 'undefined') return;
  const notice = { nonce: crypto.randomUUID() };
  receive(notice, reason);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(notice));
  } catch {
    /* BroadcastChannel still supports storage-restricted browsers. */
  }
  try {
    if (channel) channel.postMessage(notice);
    else if (typeof BroadcastChannel !== 'undefined') {
      const temporary = new BroadcastChannel(channelName);
      temporary.postMessage(notice);
      temporary.close();
    }
  } catch {
    /* Current document was already invalidated; focus/read-current-me remains available. */
  }
}
export function subscribeIdentityChanges(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(eventName, listener);
  if (subscribers++ === 0) {
    window.addEventListener('storage', onStorage);
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(channelName);
        channel.onmessage = (event) => receive(event.data);
      }
    } catch {
      channel = null;
    }
  }
  return () => {
    window.removeEventListener(eventName, listener);
    if (--subscribers === 0) {
      window.removeEventListener('storage', onStorage);
      channel?.close();
      channel = null;
    }
  };
}
