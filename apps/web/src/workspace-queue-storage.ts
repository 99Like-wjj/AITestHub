const prefix = 'aitesthub:queued-messages:';

export const workspaceQueueStorageKey = (ownerId: string) => prefix + ownerId;

/** Identity invalidation runs even on pages that never load the workbench. */
export function clearStoredWorkspaceQueues() {
  if (typeof window === 'undefined') return;
  try {
    const storage = window.sessionStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // A storage-denied page cannot load or automatically dispatch this queue.
  }
}
