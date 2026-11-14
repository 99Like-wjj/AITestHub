import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const maximumRecordBytes = 4096;
export class LocalPolicyUpgradeFenceError extends Error {
  constructor(code) {
    super('Local resource policy upgrade fence rejected the operation.');
    this.name = 'LocalPolicyUpgradeFenceError';
    this.code = code;
  }
}
const denied = (code = 'UPGRADE_FENCE_UNAVAILABLE') =>
  new LocalPolicyUpgradeFenceError(code);
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;
function exact(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function identity(raw) {
  if (
    !exact(raw, ['permitId', 'signature']) ||
    typeof raw.permitId !== 'string' ||
    !uuid.test(raw.permitId) ||
    typeof raw.signature !== 'string' ||
    !digest.test(raw.signature)
  )
    throw denied('UPGRADE_FENCE_INVALID_IDENTITY');
  return { permitId: raw.permitId.toLowerCase(), signature: raw.signature };
}
const same = (left, right) =>
  left.permitId === right.permitId && left.signature === right.signature;
const recordVersion = (kind) => `ath.local-resource-policy-upgrade-${kind}.v1`;

// Cryptographic verification and policy/head agreement belong to the supplied
// real anchor reader. This additional protocol check rejects accidental partial
// callback objects; an object NEVER creates bootstrap permission.
function anchorPresence(raw, platformId) {
  if (
    !exact(raw, ['schemaVersion', 'platformId', 'committed', 'pending']) ||
    raw.schemaVersion !== 'ath.resource-policy-anchor.v1' ||
    raw.platformId !== platformId
  )
    return false;
  const head = (value) =>
    exact(value, ['revisionId', 'digest', 'activationVersion']) &&
    typeof value.revisionId === 'string' &&
    uuid.test(value.revisionId) &&
    typeof value.digest === 'string' &&
    digest.test(value.digest) &&
    typeof value.activationVersion === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value.activationVersion);
  const document = (value) =>
    exact(value, ['schemaVersion', 'files', 'tasks', 'capacity']) &&
    value.schemaVersion === 'ath.resource-policy.v1' &&
    object(value.files) &&
    object(value.tasks) &&
    object(value.capacity) &&
    ['maxFileBytes', 'maxSubmissionBytes', 'maxFilesPerBatch'].every((key) =>
      Object.hasOwn(value.files, key),
    ) &&
    ['maxApiRuns', 'maxAiTasks'].every((key) =>
      Object.hasOwn(value.tasks, key),
    ) &&
    [
      'warnBelowBytes',
      'restrictBelowBytes',
      'largeUploadFromBytes',
      'sampleMaxAgeMs',
    ].every((key) => Object.hasOwn(value.capacity, key));
  if (
    !exact(raw.committed, ['head', 'document']) ||
    !head(raw.committed.head) ||
    !document(raw.committed.document)
  )
    return false;
  if (raw.pending === null) return true;
  return (
    exact(raw.pending, ['actorId', 'requestHash', 'receipt', 'document']) &&
    typeof raw.pending.actorId === 'string' &&
    uuid.test(raw.pending.actorId) &&
    typeof raw.pending.requestHash === 'string' &&
    digest.test(raw.pending.requestHash) &&
    document(raw.pending.document) &&
    exact(raw.pending.receipt, [
      'activationId',
      'commandId',
      'previousHead',
      'activatedHead',
    ]) &&
    typeof raw.pending.receipt.activationId === 'string' &&
    uuid.test(raw.pending.receipt.activationId) &&
    typeof raw.pending.receipt.commandId === 'string' &&
    raw.pending.receipt.commandId.length > 0 &&
    head(raw.pending.receipt.previousHead) &&
    head(raw.pending.receipt.activatedHead)
  );
}

/** Private fixed-directory metadata only. No DB/key, deletion/reset, or startup bootstrap. */
export class LocalPolicyUpgradeFence {
  #directory;
  #platformId;
  constructor(directory, platformId) {
    if (
      typeof directory !== 'string' ||
      !isAbsolute(directory) ||
      resolve(directory) === parse(directory).root ||
      typeof platformId !== 'string' ||
      !uuid.test(platformId)
    )
      throw denied('UPGRADE_FENCE_INVALID_IDENTITY');
    this.#directory = resolve(directory);
    this.#platformId = platformId.toLowerCase();
  }
  get directory() {
    return this.#directory;
  }
  get platformId() {
    return this.#platformId;
  }
  #file(kind) {
    return join(
      this.directory,
      `${this.platformId}.${kind === 'binding' ? 'binding' : 'initialization-started'}.json`,
    );
  }
  async #directoryReady(create) {
    const root = parse(this.directory).root;
    let current = root;
    for (const segment of this.directory
      .slice(root.length)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw denied();
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw denied();
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (creation) {
          if (creation.code !== 'EEXIST') throw denied();
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw denied();
      }
    }
  }
  #validateRecord(value, kind, bytes) {
    if (
      !exact(value, [
        'schemaVersion',
        'platformId',
        'permitId',
        'signature',
        'createdAt',
      ]) ||
      value.schemaVersion !== recordVersion(kind) ||
      value.platformId !== this.platformId ||
      typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt
    )
      throw denied();
    const parsed = identity({
      permitId: value.permitId,
      signature: value.signature,
    });
    if (
      parsed.permitId !== value.permitId ||
      !bytes.equals(Buffer.from(JSON.stringify(value) + '\n'))
    )
      throw denied(); // Includes duplicate JSON keys, non-UTF8, partial/trailing data.
    return parsed;
  }
  async #readRecord(kind) {
    await this.#directoryReady(false);
    const path = this.#file(kind);
    let handle;
    try {
      const initial = await lstat(path);
      if (
        !initial.isFile() ||
        initial.isSymbolicLink() ||
        initial.nlink !== 1 ||
        initial.size > maximumRecordBytes
      )
        throw denied();
      handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      );
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size > maximumRecordBytes ||
        opened.ino !== initial.ino ||
        opened.dev !== initial.dev
      )
        throw denied();
      const bytes = Buffer.alloc(maximumRecordBytes + 1);
      let received = 0;
      while (received <= maximumRecordBytes) {
        const result = await handle.read(
          bytes,
          received,
          bytes.length - received,
          received,
        );
        if (result.bytesRead === 0) break;
        received += result.bytesRead;
      }
      if (received > maximumRecordBytes) throw denied();
      const final = await lstat(path);
      await this.#directoryReady(false);
      if (
        final.isSymbolicLink() ||
        !final.isFile() ||
        final.ino !== opened.ino ||
        final.dev !== opened.dev ||
        final.size !== received
      )
        throw denied();
      const raw = bytes.subarray(0, received),
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      return this.#validateRecord(JSON.parse(text), kind, raw);
    } catch {
      throw denied();
    } finally {
      await handle?.close();
    }
  }
  async #writeExclusive(kind, bound) {
    await this.#directoryReady(true);
    let handle;
    try {
      handle = await open(this.#file(kind), 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw denied();
    }
    try {
      await handle.writeFile(
        JSON.stringify({
          schemaVersion: recordVersion(kind),
          platformId: this.platformId,
          ...bound,
          createdAt: new Date().toISOString(),
        }) + '\n',
      );
      await handle.sync();
    } catch {
      throw denied();
    } finally {
      await handle.close();
    }
    // Do not delete a partial record on failure: all later attempts fail closed.
    if (!same(await this.#readRecord(kind), bound)) throw denied();
    return true;
  }
  async bindPermit(raw) {
    const bound = identity(raw),
      fresh = await this.#writeExclusive('binding', bound);
    if (!fresh && !same(await this.#readRecord('binding'), bound))
      throw denied('UPGRADE_FENCE_ALREADY_BOUND');
    return { replayed: !fresh };
  }
  async assertBound(raw) {
    const bound = identity(raw);
    if (!same(await this.#readRecord('binding'), bound))
      throw denied('UPGRADE_FENCE_IDENTITY_MISMATCH');
  }
  async beginInitialization(raw, readAnchor) {
    const bound = identity(raw);
    if (typeof readAnchor !== 'function')
      throw denied('UPGRADE_FENCE_INVALID_IDENTITY');
    await this.assertBound(bound);
    const fresh = await this.#writeExclusive('started', bound);
    if (!fresh && !same(await this.#readRecord('started'), bound))
      throw denied('UPGRADE_FENCE_IDENTITY_MISMATCH');
    let anchor;
    try {
      anchor = await readAnchor();
    } catch {
      throw denied('UPGRADE_INITIALIZATION_ANCHOR_UNAVAILABLE');
    }
    if (anchor === null) {
      if (fresh) return { bootstrapAllowed: true };
      throw denied('UPGRADE_INITIALIZATION_CANNOT_RECREATE_ANCHOR');
    }
    if (!anchorPresence(anchor, this.platformId))
      throw denied('UPGRADE_INITIALIZATION_ANCHOR_UNAVAILABLE');
    return { bootstrapAllowed: false };
  }
}
