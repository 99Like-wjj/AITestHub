import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  open,
  readFile,
  rename,
  unlink,
  mkdir,
  stat,
  readdir,
} from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { hostname } from 'node:os';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { sealJson, unsealJson } from './crypto.js';
import { securityStateSchema, type SecurityState } from './security-state.js';

const reference = z.strictObject({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  encryptedDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const headSchema = z.strictObject({
  schemaVersion: z.literal('ath.security-control-head.v1'),
  platformId: z.uuid(),
  counter: z.number().int().nonnegative(),
  committed: reference.nullable(),
  pending: reference.nullable(),
});
export type ControlHead = z.infer<typeof headSchema>;
export type ControlReference = z.infer<typeof reference>;
const locked = (
  message = '最新安全控制记录缺失、损坏或尚未确认，恢复保持隔离。',
) => new DomainError('DEPENDENCY_UNAVAILABLE', message, 503);
/** A second anchor is kept outside the record directory and never included in a product backup. */
export class ControlFiles {
  readonly #key: Buffer;
  private verifiedBody:
    { id: string; size: number; mtimeMs: number; ctimeMs: number } | undefined;
  constructor(
    readonly directory: string,
    readonly anchorFile: string,
    key: Buffer,
  ) {
    if (key.length !== 32 || !isAbsolute(directory) || !isAbsolute(anchorFile))
      throw locked();
    this.#key = key;
    const anchorRelative = relative(resolve(directory), resolve(anchorFile));
    if (
      !anchorRelative ||
      (!anchorRelative.startsWith('..') && !isAbsolute(anchorRelative))
    )
      throw locked('安全控制anchor须在记录目录之外，不能由旧目录副本覆盖。');
  }
  private path(name: string) {
    if (
      !/^(?:head\.json|writer\.lock|[a-f0-9-]{36}\.(?:state|commit|abort))$/.test(
        name,
      )
    )
      throw locked();
    const path = resolve(this.directory, name),
      inside = relative(resolve(this.directory), path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw locked();
    return path;
  }
  private sign(value: unknown) {
    return createHmac('sha256', this.#key)
      .update(canonicalJson(value))
      .digest('hex');
  }
  private async atomic(path: string, bytes: Buffer) {
    const inside = relative(resolve(this.directory), resolve(path));
    if (
      resolve(path) !== resolve(this.anchorFile) &&
      (!inside || inside.startsWith('..') || isAbsolute(inside))
    )
      throw locked();
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  private async signed(path: string, value: unknown) {
    await this.atomic(
      path,
      Buffer.from(
        JSON.stringify({ value, signature: this.sign(value) }) + '\n',
      ),
    );
  }
  private async readSigned(path: string): Promise<unknown> {
    try {
      const parsed = z
        .strictObject({
          value: z.json(),
          signature: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(JSON.parse(await readFile(path, 'utf8')));
      if (
        !timingSafeEqual(
          Buffer.from(parsed.signature, 'hex'),
          Buffer.from(this.sign(parsed.value), 'hex'),
        )
      )
        throw new Error();
      return parsed.value;
    } catch {
      throw locked();
    }
  }
  async exists() {
    try {
      await stat(this.path('head.json'));
      return true;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw locked();
    }
  }
  async initialize(platformId: string) {
    z.uuid().parse(platformId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await this.exists()) return this.head();
    try {
      await stat(this.anchorFile);
      throw locked();
    } catch (error: unknown) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw locked();
    }
    const head: ControlHead = {
      schemaVersion: 'ath.security-control-head.v1',
      platformId,
      counter: 0,
      committed: null,
      pending: null,
    };
    await this.writeHead(head);
    return head;
  }
  async head(): Promise<ControlHead> {
    try {
      const head = headSchema.parse(
          await this.readSigned(this.path('head.json')),
        ),
        anchor = headSchema.parse(await this.readSigned(this.anchorFile));
      if (canonicalJson(head) !== canonicalJson(anchor)) throw new Error();
      return head;
    } catch {
      throw locked();
    }
  }
  private async writeHead(head: ControlHead) {
    await this.signed(this.path('head.json'), head);
    await this.signed(this.anchorFile, head);
  }
  async withWriter<T>(
    work: () => Promise<T>,
    holdsDatabaseWriterLock = false,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let index = 0; index < 100; index++) {
      try {
        handle = await open(this.path('writer.lock'), 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            host: hostname(),
            id: randomUUID(),
          }),
        );
        await handle.sync();
        break;
      } catch (error: unknown) {
        if (handle) {
          await handle.close().catch(() => {});
          handle = undefined;
          await unlink(this.path('writer.lock')).catch(() => {});
          throw locked();
        }
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw locked();
        if (holdsDatabaseWriterLock) {
          await unlink(this.path('writer.lock'));
          continue;
        }
        try {
          const owner = z
            .strictObject({
              pid: z.number().int().positive(),
              host: z.string().optional(),
              id: z.uuid(),
            })
            .parse(
              JSON.parse(await readFile(this.path('writer.lock'), 'utf8')),
            );
          if (owner.host === hostname())
            try {
              process.kill(owner.pid, 0);
            } catch (probe: unknown) {
              if (
                probe &&
                typeof probe === 'object' &&
                'code' in probe &&
                probe.code === 'ESRCH'
              ) {
                await unlink(this.path('writer.lock'));
                continue;
              }
            }
        } catch {}
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    if (!handle)
      throw locked('安全控制正在同步，请先核对状态；未提交新的权限变更。');
    try {
      return await work();
    } finally {
      await handle.close();
      await unlink(this.path('writer.lock')).catch(() => {});
    }
  }
  async prepare(
    head: ControlHead,
    state: SecurityState,
    stateDigest: string,
  ): Promise<ControlReference> {
    if (head.pending) throw locked();
    const id = randomUUID(),
      bytes = sealJson(
        state,
        this.#key,
        `ath.security-state.v1/${head.platformId}/${id}`,
      ),
      ref = {
        id,
        sequence: head.counter + 1,
        stateDigest,
        encryptedDigest: createHash('sha256').update(bytes).digest('hex'),
      };
    const handle = await open(this.path(`${id}.state`), 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.writeHead({ ...head, counter: ref.sequence, pending: ref });
    return ref;
  }
  async commit(ref: ControlReference) {
    const head = await this.head();
    if (head.committed?.id === ref.id && !head.pending) return;
    if (head.pending?.id !== ref.id && head.counter >= ref.sequence) {
      const proof = z
        .strictObject({ platformId: z.uuid(), ...reference.shape })
        .parse(await this.readSigned(this.path(`${ref.id}.commit`)));
      const { platformId, ...committedProof } = proof;
      if (
        platformId === head.platformId &&
        canonicalJson(reference.parse(committedProof)) === canonicalJson(ref)
      )
        return;
    }
    if (
      head.pending?.id !== ref.id ||
      canonicalJson(head.pending) !== canonicalJson(ref)
    )
      throw locked();
    await this.signed(this.path(`${ref.id}.commit`), {
      platformId: head.platformId,
      ...ref,
    });
    await this.writeHead({ ...head, committed: ref, pending: null });
  }
  async abort(ref: ControlReference) {
    const head = await this.head();
    if (head.pending?.id !== ref.id) throw locked();
    await this.signed(this.path(`${ref.id}.abort`), {
      platformId: head.platformId,
      ...ref,
    });
    await this.writeHead({ ...head, pending: null });
  }
  async state(head: ControlHead): Promise<SecurityState> {
    if (!head.committed || head.pending) throw locked();
    try {
      const bytes = await readFile(this.path(`${head.committed.id}.state`));
      if (
        createHash('sha256').update(bytes).digest('hex') !==
        head.committed.encryptedDigest
      )
        throw new Error();
      const state = securityStateSchema.parse(
        unsealJson(
          bytes,
          this.#key,
          `ath.security-state.v1/${head.platformId}/${head.committed.id}`,
        ),
      );
      if (
        createHash('sha256').update(canonicalJson(state)).digest('hex') !==
        head.committed.stateDigest
      )
        throw new Error();
      return state;
    } catch {
      throw locked();
    }
  }
  /** Readiness checks stat every time; changed/current bodies must authenticate before being trusted. */
  async assertBodyAvailable(head: ControlHead) {
    if (!head.committed) throw locked();
    try {
      const info = await stat(this.path(`${head.committed.id}.state`)),
        cached = this.verifiedBody;
      if (
        cached?.id === head.committed.id &&
        cached.size === info.size &&
        cached.mtimeMs === info.mtimeMs &&
        cached.ctimeMs === info.ctimeMs
      )
        return;
      await this.state({ ...head, pending: null });
      this.verifiedBody = {
        id: head.committed.id,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
    } catch {
      throw locked();
    }
  }
  /** Old encrypted full states are unnecessary for recovery: only the authenticated current state is replayed. */
  async pruneSupersededBodies(
    maximumAgeMs = 86400000,
    now = new Date(),
    holdsDatabaseWriterLock = false,
  ) {
    if (
      !Number.isSafeInteger(maximumAgeMs) ||
      maximumAgeMs < 0 ||
      maximumAgeMs > 30 * 86400000
    )
      throw locked();
    return this.withWriter(async () => {
      const head = await this.head();
      await this.state(head);
      let removed = 0;
      for (const name of await readdir(this.directory)) {
        const match = /^([a-f0-9-]{36})\.state$/.exec(name);
        if (
          !match?.[1] ||
          match[1] === head.committed?.id ||
          match[1] === head.pending?.id
        )
          continue;
        const file = this.path(name);
        if ((await stat(file)).mtimeMs > now.getTime() - maximumAgeMs) continue;
        await unlink(file);
        removed++;
      }
      return { removed };
    }, holdsDatabaseWriterLock);
  }
}
