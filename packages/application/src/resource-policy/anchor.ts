import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  resourcePolicyActivationReceiptSchema,
  resourcePolicyDocumentSchema,
  resourcePolicyHeadIdentitySchema,
  type ResourcePolicyHeadIdentity,
} from '../../../contracts/src/resource-policy.js';
import { idSchema, sha256Schema } from '../../../contracts/src/base.js';
import { ControlFiles } from '../recovery/control-files.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import { resourcePolicyDigest } from './core.js';

const committedSchema = z.strictObject({
  head: resourcePolicyHeadIdentitySchema,
  document: resourcePolicyDocumentSchema,
});
const pendingSchema = z.strictObject({
  actorId: idSchema,
  requestHash: sha256Schema,
  receipt: resourcePolicyActivationReceiptSchema,
  document: resourcePolicyDocumentSchema,
});
export const resourcePolicyAnchorSchema = z.strictObject({
  schemaVersion: z.literal('ath.resource-policy-anchor.v1'),
  platformId: idSchema,
  committed: committedSchema,
  pending: pendingSchema.nullable(),
});
export type ResourcePolicyAnchor = z.infer<typeof resourcePolicyAnchorSchema>;
export interface ResourcePolicyAnchorReader {
  read(): Promise<ResourcePolicyAnchor | null>;
}
export interface ResourcePolicyAnchorPort extends ResourcePolicyAnchorReader {
  withWriter<T>(work: () => Promise<T>): Promise<T>;
  write(value: ResourcePolicyAnchor): Promise<void>;
}
export const policyFenceUnavailable = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '最新资源策略栅栏缺失、未确认或与数据库不同；未开放新任务。',
    503,
  );
export function samePolicyHead(
  a: ResourcePolicyHeadIdentity,
  b: ResourcePolicyHeadIdentity,
) {
  return (
    a.revisionId === b.revisionId &&
    a.digest === b.digest &&
    a.activationVersion === b.activationVersion
  );
}
export function validateResourcePolicyAnchor(
  raw: unknown,
): ResourcePolicyAnchor {
  const result = resourcePolicyAnchorSchema.safeParse(raw);
  if (!result.success) throw policyFenceUnavailable();
  const anchor = result.data;
  if (
    resourcePolicyDigest(anchor.committed.document) !==
    anchor.committed.head.digest
  )
    throw policyFenceUnavailable();
  if (
    anchor.pending &&
    (!samePolicyHead(
      anchor.pending.receipt.previousHead,
      anchor.committed.head,
    ) ||
      BigInt(anchor.pending.receipt.activatedHead.activationVersion) !==
        BigInt(anchor.committed.head.activationVersion) + 1n ||
      resourcePolicyDigest(anchor.pending.document) !==
        anchor.pending.receipt.activatedHead.digest)
  )
    throw policyFenceUnavailable();
  return anchor;
}

function signature(key: Buffer, value: unknown) {
  return createHmac('sha256', key)
    .update('ath.resource-policy-anchor.v1\0')
    .update(canonicalJson(value))
    .digest('hex');
}
async function readAnchor(
  file: string,
  key: Buffer,
): Promise<ResourcePolicyAnchor | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768)
      throw policyFenceUnavailable();
    const envelope = z
      .strictObject({ value: z.unknown(), signature: sha256Schema })
      .parse(JSON.parse(await readFile(file, 'utf8')));
    if (
      !timingSafeEqual(
        Buffer.from(envelope.signature, 'hex'),
        Buffer.from(signature(key, envelope.value), 'hex'),
      )
    )
      throw policyFenceUnavailable();
    return validateResourcePolicyAnchor(envelope.value);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw policyFenceUnavailable();
  }
}
/** API/AI hosts receive this reader and a read-only mount; no writer/lock/bootstrap API. */
export function readOnlyResourcePolicyAnchor(
  file: string,
  key: Buffer,
): ResourcePolicyAnchorReader {
  if (!isAbsolute(file) || key.length !== 32) throw policyFenceUnavailable();
  const privateKey = Buffer.from(key);
  return Object.freeze({ read: () => readAnchor(file, privateKey) });
}

/**
 * Trusted fixed-path metadata store, kept outside every product-backup directory.
 * Only the existing ControlFiles writer lock is reused; no security-state body or
 * C5 checkpoint is read/changed. Caller must also hold the DB policy writer lock.
 */
export class FileResourcePolicyAnchor implements ResourcePolicyAnchorPort {
  readonly #key: Buffer;
  readonly #writer: ControlFiles;
  constructor(
    readonly file: string,
    readonly lockDirectory: string,
    key: Buffer,
    backupDirectory: string,
  ) {
    if (
      key.length !== 32 ||
      ![file, lockDirectory, backupDirectory].every(isAbsolute)
    )
      throw policyFenceUnavailable();
    for (const path of [file, lockDirectory]) {
      const inside = relative(resolve(backupDirectory), resolve(path));
      if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
        throw policyFenceUnavailable();
    }
    this.#key = Buffer.from(key);
    this.#writer = new ControlFiles(lockDirectory, file, key);
  }
  withWriter<T>(work: () => Promise<T>) {
    return this.#writer.withWriter(work);
  }
  private sign(value: unknown) {
    return signature(this.#key, value);
  }
  async read(): Promise<ResourcePolicyAnchor | null> {
    return readAnchor(this.file, this.#key);
  }
  async write(raw: ResourcePolicyAnchor): Promise<void> {
    const value = validateResourcePolicyAnchor(raw);
    const parent = dirname(this.file);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `${randomUUID()}.policy.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        const existing = await lstat(this.file);
        if (!existing.isFile() || existing.isSymbolicLink())
          throw policyFenceUnavailable();
      } catch (error: unknown) {
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ value, signature: this.sign(value) }) + '\n',
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.file);
    } catch {
      throw policyFenceUnavailable();
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}
