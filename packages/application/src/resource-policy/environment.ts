import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  FileResourcePolicyAnchor,
  policyFenceUnavailable,
  readOnlyResourcePolicyAnchor,
  type ResourcePolicyAnchorReader,
} from './anchor.js';

/** Trusted host environment only: paths/key supplier, never numeric policy overrides. */
async function configuration(environment: NodeJS.ProcessEnv) {
  const root =
    environment.AITESTHUB_LOCAL_ROOT ??
    (environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, 'AITestHub')
      : undefined);
  const existingAnchor = environment.AITESTHUB_RECOVERY_CONTROL_ANCHOR_FILE;
  const file =
    environment.AITESTHUB_RESOURCE_POLICY_ANCHOR_FILE ??
    (existingAnchor
      ? join(dirname(existingAnchor), 'resource-policy', 'anchor.json')
      : root
        ? join(root, 'recovery', 'controls', 'resource-policy', 'anchor.json')
        : undefined);
  const keyFile =
    environment.AITESTHUB_RECOVERY_CONTROL_KEY_FILE ??
    (root ? join(root, 'secrets', 'recovery-control-key') : undefined);
  const backups =
    environment.AITESTHUB_BACKUP_DIRECTORY ??
    (root ? join(root, 'backups', 'product') : undefined);
  if (
    !file ||
    !keyFile ||
    !backups ||
    ![file, keyFile, backups].every(isAbsolute)
  )
    throw policyFenceUnavailable();
  for (const path of [file, keyFile]) {
    const inside = relative(resolve(backups), resolve(path));
    if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
      throw policyFenceUnavailable();
  }
  try {
    // Existing restricted host key convention. Never create, rotate or replace it.
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw policyFenceUnavailable();
    return { file, backups, key: Buffer.from(value, 'hex'), root };
  } catch {
    throw policyFenceUnavailable();
  }
}

/** API/AI: only read/verify. No mkdir, writer lock, bootstrap or write capability. */
export async function resourcePolicyReaderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResourcePolicyAnchorReader> {
  const config = await configuration(environment);
  return readOnlyResourcePolicyAnchor(config.file, config.key);
}

/** Trusted operations process only; caller supplies a write mount outside backup restoration. */
export async function resourcePolicyWriterFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FileResourcePolicyAnchor> {
  const config = await configuration(environment);
  const existing = environment.AITESTHUB_RECOVERY_CONTROL_DIRECTORY;
  const locks =
    environment.AITESTHUB_RESOURCE_POLICY_LOCK_DIRECTORY ??
    (existing
      ? join(dirname(existing), 'resource-policy-writer')
      : config.root
        ? join(config.root, 'control', 'resource-policy-writer')
        : undefined);
  if (!locks || !isAbsolute(locks)) throw policyFenceUnavailable();
  return new FileResourcePolicyAnchor(
    config.file,
    locks,
    config.key,
    config.backups,
  );
}
