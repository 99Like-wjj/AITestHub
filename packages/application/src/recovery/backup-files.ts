import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  stat,
  readdir,
  realpath,
  rm,
  open,
} from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import {
  sealJson,
  unsealJson,
  fileDigest,
  verifySealedFile,
  encryptFile,
  decryptFile,
  type SealedFile,
} from './crypto.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/),
  sealed = z.strictObject({
    plaintextBytes: z.number().int().nonnegative(),
    plaintextSha256: sha,
    encryptedBytes: z.number().int().positive(),
    encryptedSha256: sha,
  });
export const backupManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.product-backup.v1'),
    id: z.uuid(),
    platformId: z.uuid(),
    capturedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    controls: z.strictObject({
      sequence: z.number().int().positive(),
      stateDigest: sha,
    }),
    platformMasterFingerprint: sha,
    versions: z.strictObject({
      application: z.string(),
      node: z.string(),
      postgres: z.string(),
      migrations: z.array(
        z.strictObject({ version: z.string(), checksum: sha }),
      ),
    }),
    database: sealed,
    objects: z.array(
      z.strictObject({
        id: z.uuid(),
        storageKey: z.string().min(1).max(2048),
        mediaType: z.string(),
        sealed,
      }),
    ),
    resources: z.array(
      z.strictObject({
        id: z.uuid(),
        objectId: z.uuid(),
        ownerScope: z.enum(['personal', 'project']),
        ownerId: z.uuid(),
        projectId: z.uuid().nullable(),
        runId: z.uuid().nullable(),
        bytes: z.number().int().nonnegative(),
        sha256: sha,
      }),
    ),
  })
  .superRefine((value, context) => {
    const duration = Date.parse(value.expiresAt) - Date.parse(value.capturedAt);
    if (duration <= 0 || duration > 30 * 86400000)
      context.addIssue({
        code: 'custom',
        message: 'Invalid product backup retention',
      });
    const objects = new Map(value.objects.map((object) => [object.id, object]));
    if (
      objects.size !== value.objects.length ||
      new Set(value.resources.map((resource) => resource.id)).size !==
        value.resources.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Duplicate backup object/resource identity',
      });
    for (const resource of value.resources) {
      const object = objects.get(resource.objectId);
      if (
        !object ||
        object.sealed.plaintextBytes !== resource.bytes ||
        object.sealed.plaintextSha256 !== resource.sha256
      )
        context.addIssue({
          code: 'custom',
          message: 'Resource bytes/hash lack matching sealed object',
        });
    }
  });
export type BackupManifest = z.infer<typeof backupManifestSchema>;
const bundleSchema = z.strictObject({
  schemaVersion: z.literal('ath.product-backup-bundle.v1'),
  id: z.uuid(),
  capturedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  manifestSha256: sha,
});
const invalid = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '产品备份文件未完成或校验失败，不可恢复。',
    503,
  );
export class BackupFiles {
  readonly #key: Buffer;
  constructor(
    readonly directory: string,
    key: Buffer,
  ) {
    if (!isAbsolute(directory) || key.length !== 32) throw invalid();
    this.#key = key;
  }
  path(id: string, name?: string) {
    z.uuid().parse(id);
    if (
      name !== undefined &&
      !/^(?:manifest\.enc|bundle\.json|database\.enc|[a-f0-9-]{36}\.enc)$/.test(
        name,
      )
    )
      throw invalid();
    const path = resolve(this.directory, `product-${id}`, name ?? ''),
      within = relative(resolve(this.directory), path);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw invalid();
    return path;
  }
  async create(id: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.path(id), { mode: 0o700 });
  }
  private signature(value: unknown) {
    return createHmac('sha256', this.#key)
      .update(canonicalJson(value))
      .digest('hex');
  }
  async complete(manifest: BackupManifest) {
    backupManifestSchema.parse(manifest);
    const sealed = sealJson(
      manifest,
      this.#key,
      `ath.product-backup-manifest.v1/${manifest.id}`,
    );
    const manifestPath = this.path(manifest.id, 'manifest.enc');
    const handle = await open(manifestPath, 'wx', 0o600);
    try {
      await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const bundle = {
      schemaVersion: 'ath.product-backup-bundle.v1',
      id: manifest.id,
      capturedAt: manifest.capturedAt,
      expiresAt: manifest.expiresAt,
      manifestSha256: createHash('sha256').update(sealed).digest('hex'),
    };
    const file = await open(this.path(manifest.id, 'bundle.json'), 'wx', 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ bundle, signature: this.signature(bundle) }) + '\n',
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async read(id: string, allowExpired = false): Promise<BackupManifest> {
    try {
      if ((await stat(this.path(id, 'bundle.json'))).size > 65536)
        throw new Error();
      const raw = z
        .strictObject({ bundle: bundleSchema, signature: sha })
        .parse(
          JSON.parse(await readFile(this.path(id, 'bundle.json'), 'utf8')),
        );
      if (
        raw.bundle.id !== id ||
        !timingSafeEqual(
          Buffer.from(raw.signature, 'hex'),
          Buffer.from(this.signature(raw.bundle), 'hex'),
        )
      )
        throw new Error();
      if (
        Date.parse(raw.bundle.expiresAt) - Date.parse(raw.bundle.capturedAt) >
        30 * 86400000
      )
        throw new Error();
      if (!allowExpired && Date.parse(raw.bundle.expiresAt) <= Date.now())
        throw new Error();
      if ((await stat(this.path(id, 'manifest.enc'))).size > 64 * 1024 * 1024)
        throw new Error();
      const encrypted = await readFile(this.path(id, 'manifest.enc'));
      if (
        createHash('sha256').update(encrypted).digest('hex') !==
        raw.bundle.manifestSha256
      )
        throw new Error();
      const manifest = backupManifestSchema.parse(
        unsealJson(
          encrypted,
          this.#key,
          `ath.product-backup-manifest.v1/${id}`,
        ),
      );
      if (
        manifest.id !== id ||
        manifest.capturedAt !== raw.bundle.capturedAt ||
        manifest.expiresAt !== raw.bundle.expiresAt
      )
        throw new Error();
      return manifest;
    } catch {
      throw invalid();
    }
  }
  async verify(manifest: BackupManifest) {
    const entries = [
      {
        name: 'database.enc',
        context: `ath.product-backup.v1/${manifest.id}/database`,
        sealed: manifest.database,
      },
      ...manifest.objects.map((object) => ({
        name: `${object.id}.enc`,
        context: `ath.product-backup.v1/${manifest.id}/object/${object.id}`,
        sealed: object.sealed,
      })),
    ];
    for (const entry of entries) {
      const path = this.path(manifest.id, entry.name);
      if (
        (await stat(path)).size !== entry.sealed.encryptedBytes ||
        (await fileDigest(path)) !== entry.sealed.encryptedSha256
      )
        throw invalid();
      await verifySealedFile(path, this.#key, entry.context, entry.sealed);
    }
  }
  async writeDatabase(id: string, input: Readable) {
    return encryptFile(
      input,
      this.path(id, 'database.enc'),
      this.#key,
      `ath.product-backup.v1/${id}/database`,
    );
  }
  async writeObject(id: string, objectId: string, input: Readable) {
    z.uuid().parse(objectId);
    return encryptFile(
      input,
      this.path(id, `${objectId}.enc`),
      this.#key,
      `ath.product-backup.v1/${id}/object/${objectId}`,
    );
  }
  async databaseStream(id: string, sealed: SealedFile) {
    await verifySealedFile(
      this.path(id, 'database.enc'),
      this.#key,
      `ath.product-backup.v1/${id}/database`,
      sealed,
    );
    return decryptFile(
      this.path(id, 'database.enc'),
      this.#key,
      `ath.product-backup.v1/${id}/database`,
    );
  }
  async objectStream(id: string, objectId: string, sealed: SealedFile) {
    z.uuid().parse(objectId);
    await verifySealedFile(
      this.path(id, `${objectId}.enc`),
      this.#key,
      `ath.product-backup.v1/${id}/object/${objectId}`,
      sealed,
    );
    return decryptFile(
      this.path(id, `${objectId}.enc`),
      this.#key,
      `ath.product-backup.v1/${id}/object/${objectId}`,
    );
  }
  async removeExpired(now = new Date()) {
    let removed = 0;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      const match = /^product-([a-f0-9-]{36})$/.exec(name);
      if (!match?.[1]) continue;
      let manifest: BackupManifest;
      try {
        manifest = await this.read(match[1], true);
      } catch {
        continue;
      }
      if (Date.parse(manifest.expiresAt) > now.getTime()) continue;
      const root = await realpath(this.directory),
        target = await realpath(this.path(manifest.id)),
        inside = relative(root, target);
      if (inside !== name || inside.startsWith('..') || isAbsolute(inside))
        throw invalid();
      await rm(target, { recursive: true });
      removed++;
    }
    return { removed };
  }
  /** Only failed/expired UUIDs selected from the product job table may enter here. No directory sweep. */
  async removeIncomplete(id: string) {
    let target: string;
    try {
      target = await realpath(this.path(id));
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw invalid();
    }
    const root = await realpath(this.directory),
      within = relative(root, target);
    if (
      within !== `product-${id}` ||
      within.startsWith('..') ||
      isAbsolute(within)
    )
      throw invalid();
    await rm(target, { recursive: true });
    return true;
  }
}
