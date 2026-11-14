import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryResultRow } from 'pg';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';

export interface SecretBinding {
  ownerScope: 'platform' | 'user' | 'project';
  ownerId: string;
  purpose: string;
}
interface SecretRow extends QueryResultRow {
  id: string;
  owner_scope: SecretBinding['ownerScope'];
  owner_id: string;
  purpose: string;
  key_version: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  revoked_at: Date | null;
}

/** Backend adapter dependency. Never put this broker or its return values into an AI tool registry. */
export class SecretBroker {
  constructor(
    private readonly database: Database,
    private readonly masterKey: Buffer,
    private readonly keyVersion = 'local-v1',
  ) {
    if (masterKey.length !== 32)
      throw new Error('Platform master key must contain 32 bytes.');
  }
  static async fromEnvironment(
    database: Database,
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<SecretBroker> {
    const root =
      environment.AITESTHUB_LOCAL_ROOT ??
      (environment.LOCALAPPDATA === undefined
        ? undefined
        : join(environment.LOCALAPPDATA, 'AITestHub'));
    const path =
      environment.AITESTHUB_MASTER_KEY_FILE ??
      (root === undefined
        ? undefined
        : join(root, 'secrets', 'platform-master-key'));
    if (path === undefined)
      throw new Error('AITESTHUB_MASTER_KEY_FILE is required.');
    let encoded: string;
    try {
      encoded = (await readFile(path, 'utf8')).trim();
    } catch {
      throw new Error('Platform master key file could not be read.');
    }
    if (!/^[a-f0-9]{64}$/i.test(encoded))
      throw new Error('Platform master key file has an invalid format.');
    return new SecretBroker(database, Buffer.from(encoded, 'hex'));
  }
  private aad(
    id: string,
    binding: SecretBinding,
    keyVersion = this.keyVersion,
  ): Buffer {
    return Buffer.from(
      JSON.stringify({
        id,
        ownerScope: binding.ownerScope,
        ownerId: binding.ownerId,
        purpose: binding.purpose,
        keyVersion,
      }),
    );
  }
  fingerprint(value: string, binding: SecretBinding): string {
    return createHmac('sha256', this.masterKey)
      .update(JSON.stringify(binding))
      .update('\0')
      .update(value)
      .digest('hex');
  }
  async store(
    transaction: SqlExecutor,
    value: string,
    binding: SecretBinding,
  ): Promise<string> {
    if (!value || Buffer.byteLength(value) > 16384)
      throw new DomainError(
        'VALIDATION_ERROR',
        '秘密输入长度不符合限制。',
        400,
      );
    const id = randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    cipher.setAAD(this.aad(id, binding));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    await transaction.query(
      `INSERT INTO app.secret_records(id,owner_scope,owner_id,purpose,key_version,ciphertext,nonce,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        binding.ownerScope,
        binding.ownerId,
        binding.purpose,
        this.keyVersion,
        ciphertext,
        nonce,
        cipher.getAuthTag(),
      ],
    );
    if (
      ![
        'api-auth-token',
        'api-redaction-value',
        'api-tainted-variable',
      ].includes(binding.purpose)
    )
      transaction.noteSecurityControlChange?.({
        action: 'secret.created',
        objectId: id,
        projectId: null,
      });
    return id;
  }
  async revoke(
    transaction: SqlExecutor,
    reference: string,
    binding: SecretBinding,
  ): Promise<void> {
    await transaction.query(
      'UPDATE app.secret_records SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND owner_scope=$2 AND owner_id=$3 AND purpose=$4',
      [reference, binding.ownerScope, binding.ownerId, binding.purpose],
    );
    if (
      ![
        'api-auth-token',
        'api-redaction-value',
        'api-tainted-variable',
      ].includes(binding.purpose)
    )
      transaction.noteSecurityControlChange?.({
        action: 'secret.revoked',
        objectId: reference,
        projectId: null,
      });
  }
  /** Only per-run transport material owned by the execution module may be physically discarded. */
  async destroyExecutionTransient(
    transaction: SqlExecutor,
    ownerId: string,
  ): Promise<void> {
    await transaction.query(
      `DELETE FROM app.secret_records WHERE owner_scope='project' AND owner_id=$1
      AND purpose=ANY($2::text[])`,
      [
        ownerId,
        ['api-auth-token', 'api-redaction-value', 'api-tainted-variable'],
      ],
    );
  }
  async resolve(reference: string, binding: SecretBinding): Promise<string> {
    return this.resolveInTransaction(this.database, reference, binding);
  }
  async resolveInTransaction(
    transaction: SqlExecutor,
    reference: string,
    binding: SecretBinding,
  ): Promise<string> {
    const row = (
      await transaction.query<SecretRow>(
        'SELECT * FROM app.secret_records WHERE id=$1 AND owner_scope=$2 AND owner_id=$3 AND purpose=$4 AND revoked_at IS NULL',
        [reference, binding.ownerScope, binding.ownerId, binding.purpose],
      )
    ).rows[0];
    if (!row || row.key_version !== this.keyVersion)
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        '配置凭据不可用，请由管理员重新配置。',
        422,
      );
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.masterKey, row.nonce);
      cipher.setAAD(this.aad(row.id, binding, row.key_version));
      cipher.setAuthTag(row.auth_tag);
      return Buffer.concat([
        cipher.update(row.ciphertext),
        cipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '配置凭据完整性校验失败。',
        503,
      );
    }
  }
}
