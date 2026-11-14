import assert from 'node:assert/strict';

/** Exact nonce-name recovery after a create-key ACK is lost. Never creates/replays a key. */
export async function cleanupMetadataKey(port, name, expectedId) {
  const first = (await port.list()).keys.filter((key) => key.name === name);
  assert.ok(first.length > 0, 'KEY_CREATION_RECOVERY_UNCONFIRMED');
  if (expectedId) assert.ok(first.some((key) => key.id === expectedId));
  const ids = new Set(first.map((key) => key.id));
  for (const key of first) {
    if (key.revokedAt !== null) continue;
    try {
      await port.revoke(key.id);
    } catch {
      // The response can be unknown; the authoritative read below decides cleanup.
    }
  }
  const after = (await port.list()).keys.filter((key) => key.name === name);
  assert.equal(after.length, first.length);
  assert.ok(after.every((key) => ids.has(key.id) && key.revokedAt !== null));
  return { keyIds: [...ids], keyRevoked: true };
}
