import { markIdentityCommandsUnknown } from './identity-commands';
const storageKey = 'aitesthub:identity-epoch:v1',
  eventName = 'aitesthub:identity-context-changed',
  channelName = 'aitesthub-identity-v1';
let epoch = 0,
  channel: BroadcastChannel | null = null,
  subscribers = 0;
let actorId: string | null = null,
  managed = false;
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
function receive(value: unknown) {
  if (typeof window === 'undefined' || !valid(value) || seen.has(value.nonce))
    return;
  seen.add(value.nonce);
  if (seen.size > 128) seen.delete(seen.values().next().value!);
  epoch += 1;
  actorId = null;
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
export function announceIdentityChange() {
  if (typeof window === 'undefined') return;
  const notice = { nonce: crypto.randomUUID() };
  receive(notice);
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
