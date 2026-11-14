import { randomUUID } from 'node:crypto';
import {
  registerInputSchema,
  loginInputSchema,
  profileUpdateInputSchema,
  changePasswordInputSchema,
  resetPasswordInputSchema,
  createPersonalKeyInputSchema,
  adminUpdateUserInputSchema,
  adminUserPageQuerySchema,
  adminUserPageSchema,
  adminUserSchema,
  removeAccountInputSchema,
  accountRemovalReceiptSchema,
  type ActorContext,
  type AccountRemovalReceipt,
  type User,
} from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requirePlatformAdmin } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import {
  hashPassword,
  verifyPassword,
  randomSecret,
  secretHash,
} from './password.js';

interface UserRow {
  id: string;
  account: string;
  display_account: string;
  display_name: string;
  password_hash: string;
  active: boolean;
  is_platform_admin: boolean;
  theme: 'light' | 'dark' | 'system';
  row_version: number;
  credential_version: number;
  created_at: Date;
  removed_at?: Date | null;
  removed_by?: string | null;
}

const dummyPassword = hashPassword(randomSecret('dummy_'));

export function userDto(row: UserRow): User {
  return {
    id: row.id,
    account: row.display_account || row.account,
    displayName: row.display_name,
    isPlatformAdmin: row.is_platform_admin,
    theme: row.theme,
    rowVersion: row.row_version,
  };
}

export class IdentityService {
  constructor(readonly db: Database) {}

  async register(raw: unknown): Promise<User> {
    const input = registerInputSchema.parse(raw);
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const result = await tx.query<UserRow>(
        `INSERT INTO app.users(account,display_account,display_name,password_hash)
         VALUES($1,$2,$3,$4) ON CONFLICT(account) DO NOTHING RETURNING *`,
        [
          input.account.toLowerCase(),
          input.account,
          input.displayName,
          passwordHash,
        ],
      );
      const user = result.rows[0];
      if (!user)
        throw new DomainError(
          'ACCOUNT_ALREADY_EXISTS',
          '该账号已被使用；账号不区分字母大小写。',
          409,
        );
      const actor: ActorContext = {
        userId: user.id,
        entrypoint: 'web',
        requestId: randomUUID(),
      };
      await audit(tx, actor, 'identity.registered', user.id);
      return userDto(user);
    });
  }

  async login(raw: unknown): Promise<{ user: User; session: string }> {
    const input = loginInputSchema.parse(raw);
    const result = await this.db.query<UserRow>(
      'SELECT * FROM app.users WHERE account=$1',
      [input.account.toLowerCase()],
    );
    const user = result.rows[0];
    const valid = await verifyPassword(
      input.password,
      user?.password_hash ?? (await dummyPassword),
    );
    if (!user?.active || !valid)
      throw new DomainError('INVALID_CREDENTIALS', '账号或密码无效。', 401);
    const session = randomSecret('ath_session_');
    return this.db.transaction(async (tx) => {
      const locked = (
        await tx.query<UserRow>(
          'SELECT * FROM app.users WHERE id=$1 FOR SHARE',
          [user.id],
        )
      ).rows[0];
      if (
        !locked?.active ||
        locked.credential_version !== user.credential_version
      ) {
        throw new DomainError(
          'INVALID_CREDENTIALS',
          '认证状态已改变，请重新登录。',
          401,
        );
      }
      await tx.query(
        `INSERT INTO app.sessions(id_hash,user_id,credential_version,expires_at)
         VALUES($1,$2,$3,clock_timestamp()+interval '12 hours')`,
        [secretHash(session), user.id, user.credential_version],
      );
      return { user: userDto(locked), session };
    });
  }

  async authenticate(
    session: string | undefined,
    bearer: string | undefined,
    requestId: string,
  ): Promise<ActorContext> {
    if (bearer) {
      if (!bearer.startsWith('ath_key_'))
        throw new DomainError('UNAUTHENTICATED', '个人 Key 无效。', 401);
      const result = await this.db.query<{ id: string; user_id: string }>(
        `UPDATE app.personal_keys k SET last_used_at=clock_timestamp() FROM app.users u
         WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND u.id=k.user_id AND u.active RETURNING k.id,k.user_id`,
        [secretHash(bearer)],
      );
      const key = result.rows[0];
      if (key)
        return {
          userId: key.user_id,
          keyId: key.id,
          entrypoint: 'official-mcp',
          requestId,
        };
    } else if (session) {
      const result = await this.db.query<{ user_id: string }>(
        `SELECT s.user_id FROM app.sessions s JOIN app.users u ON u.id=s.user_id
         WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
           AND u.active AND s.credential_version=u.credential_version`,
        [secretHash(session)],
      );
      const row = result.rows[0];
      if (row) return { userId: row.user_id, entrypoint: 'web', requestId };
    }
    throw new DomainError(
      'UNAUTHENTICATED',
      '请登录或配置有效的个人 Key。',
      401,
    );
  }

  async me(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      const user = (
        await tx.query<UserRow>('SELECT * FROM app.users WHERE id=$1', [
          actor.userId,
        ])
      ).rows[0];
      if (!user) throw new DomainError('UNAUTHENTICATED', '账号无效。', 401);
      const projects = await tx.query<{
        id: string;
        name: string;
        is_admin: boolean;
        roles: ('tester' | 'developer' | 'product')[];
        row_version: number;
      }>(
        `SELECT p.id,p.name,m.is_admin,m.roles,p.row_version FROM app.projects p JOIN app.project_members m
         ON p.id=m.project_id WHERE m.user_id=$1 AND m.active AND p.active ORDER BY p.created_at,p.id`,
        [actor.userId],
      );
      return {
        user: userDto(user),
        projects: projects.rows.map((p) => ({
          id: p.id,
          name: p.name,
          isAdmin: p.is_admin,
          roles: p.roles,
          rowVersion: p.row_version,
        })),
      };
    });
  }

  async updateProfile(actor: ActorContext, raw: unknown) {
    const input = profileUpdateInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.lockUsers(tx, [actor.userId]);
      await currentUser(tx, actor);
      const result = await tx.query<UserRow>(
        `UPDATE app.users SET display_name=$2,theme=$3,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND row_version=$4 RETURNING *`,
        [actor.userId, input.displayName, input.theme, input.rowVersion],
      );
      const user = result.rows[0];
      if (!user) stale();
      return { user: userDto(user) };
    });
  }

  async logout(session: string | undefined): Promise<void> {
    if (session)
      await this.db.query(
        'UPDATE app.sessions SET revoked_at=clock_timestamp() WHERE id_hash=$1 AND revoked_at IS NULL',
        [secretHash(session)],
      );
  }

  async changePassword(actor: ActorContext, raw: unknown): Promise<void> {
    const input = changePasswordInputSchema.parse(raw);
    const row = (
      await this.db.query<UserRow>('SELECT * FROM app.users WHERE id=$1', [
        actor.userId,
      ])
    ).rows[0];
    if (
      !row ||
      !(await verifyPassword(input.currentPassword, row.password_hash))
    ) {
      throw new DomainError('INVALID_CREDENTIALS', '原密码无效。', 401);
    }
    const hash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await this.lockUsers(tx, [actor.userId]);
      await currentUser(tx, actor);
      const updated = await tx.query(
        `UPDATE app.users SET password_hash=$2,credential_version=credential_version+1,row_version=row_version+1,
         updated_at=clock_timestamp() WHERE id=$1 AND credential_version=$3`,
        [actor.userId, hash, row.credential_version],
      );
      if (!updated.rowCount) stale();
      await audit(tx, actor, 'identity.password-changed', actor.userId);
    });
  }

  async issueReset(actor: ActorContext, userId: string) {
    const resetCode = randomSecret('ath_reset_');
    return this.db.transaction(async (tx) => {
      await this.lockUsers(tx, [actor.userId, userId]);
      await requirePlatformAdmin(tx, actor);
      const user = (
        await tx.query<UserRow>(
          'SELECT * FROM app.users WHERE id=$1 FOR UPDATE',
          [userId],
        )
      ).rows[0];
      if (!user?.active)
        throw new DomainError('NOT_FOUND', '没有此有效账号。', 404);
      await tx.query(
        'UPDATE app.password_resets SET used_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL',
        [userId],
      );
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await tx.query(
        'INSERT INTO app.password_resets(hash,user_id,expires_at) VALUES($1,$2,$3)',
        [secretHash(resetCode), userId, expiresAt],
      );
      await audit(tx, actor, 'identity.reset-issued', userId);
      return { resetCode, expiresAt };
    });
  }

  async resetPassword(raw: unknown): Promise<void> {
    const input = resetPasswordInputSchema.parse(raw);
    const hash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      const found = (
        await tx.query<{ user_id: string }>(
          `SELECT r.user_id FROM app.password_resets r JOIN app.users u ON u.id=r.user_id
         WHERE r.hash=$1 AND r.used_at IS NULL AND r.expires_at>clock_timestamp() AND u.active FOR UPDATE OF r,u`,
          [secretHash(input.resetCode)],
        )
      ).rows[0];
      if (!found)
        throw new DomainError(
          'INVALID_RESET_CREDENTIAL',
          '重置凭据无效、已使用或已过期，请联系平台管理员。',
          422,
        );
      await tx.query(
        'UPDATE app.password_resets SET used_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL',
        [found.user_id],
      );
      await tx.query(
        `UPDATE app.users SET password_hash=$2,credential_version=credential_version+1,row_version=row_version+1,
         updated_at=clock_timestamp() WHERE id=$1`,
        [found.user_id, hash],
      );
      await audit(
        tx,
        { userId: found.user_id, entrypoint: 'web', requestId: randomUUID() },
        'identity.password-reset',
        found.user_id,
      );
    });
  }

  async keys(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      await this.personalOnly(tx, actor);
      const result = await tx.query<{
        id: string;
        name: string;
        prefix: string;
        created_at: Date;
        revoked_at: Date | null;
      }>(
        'SELECT id,name,prefix,created_at,revoked_at FROM app.personal_keys WHERE user_id=$1 ORDER BY created_at DESC,id',
        [actor.userId],
      );
      return {
        keys: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          createdAt: row.created_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
      };
    });
  }

  async createKey(actor: ActorContext, raw: unknown) {
    const input = createPersonalKeyInputSchema.parse(raw);
    const rawKey = randomSecret('ath_key_');
    return this.db.transaction(async (tx) => {
      await this.personalOnly(tx, actor);
      const row = (
        await tx.query<{ id: string; created_at: Date }>(
          'INSERT INTO app.personal_keys(user_id,key_hash,prefix,name,allowed_scope) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at',
          [
            actor.userId,
            secretHash(rawKey),
            rawKey.slice(0, 16),
            input.name,
            JSON.stringify(
              input.allowedCapabilities
                ? { capabilities: input.allowedCapabilities }
                : {},
            ),
          ],
        )
      ).rows[0];
      if (!row) throw new Error('Key insert returned no row');
      await audit(tx, actor, 'identity.key-created', row.id);
      return {
        key: {
          id: row.id,
          name: input.name,
          prefix: rawKey.slice(0, 16),
          createdAt: row.created_at.toISOString(),
          revokedAt: null,
        },
        rawKey,
      };
    });
  }

  async revokeKey(actor: ActorContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.personalOnly(tx, actor);
      const result = await tx.query(
        'UPDATE app.personal_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2',
        [id, actor.userId],
      );
      if (!result.rowCount)
        throw new DomainError('NOT_FOUND', '个人 Key 不存在。', 404);
      await audit(tx, actor, 'identity.key-revoked', id);
    });
  }

  async listUsers(actor: ActorContext, search = '') {
    return this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      if (actor.entrypoint !== 'web')
        throw new DomainError('FORBIDDEN', '此入口不开放账号管理。', 403);
      if (
        !(
          await tx.query(
            `SELECT 1 FROM app.users u WHERE u.id=$1 AND (u.is_platform_admin OR EXISTS(
           SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id
           WHERE m.user_id=u.id AND m.active AND m.is_admin AND p.active))`,
            [actor.userId],
          )
        ).rowCount
      )
        throw new DomainError('FORBIDDEN', '当前账号不能检索成员账号。', 403);
      const users = await tx.query<
        Pick<
          UserRow,
          'id' | 'account' | 'display_account' | 'display_name' | 'active'
        >
      >(
        `SELECT id,account,display_account,display_name,active FROM app.users WHERE active AND ($1='' OR position(lower($1) in lower(account||' '||display_name))>0)
         ORDER BY account LIMIT 200`,
        [search.slice(0, 100)],
      );
      return {
        users: users.rows.map((u) => ({
          id: u.id,
          account: u.display_account || u.account,
          displayName: u.display_name,
          active: u.active,
        })),
      };
    });
  }

  async listUserPage(actor: ActorContext, raw: unknown) {
    const input = adminUserPageQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      if (actor.entrypoint !== 'web')
        throw new DomainError('FORBIDDEN', '此入口不开放账号管理。', 403);
      await requirePlatformAdmin(tx, actor);
      // A single SQL snapshot keeps the filtered total and page in agreement.
      // Both projections omit credential hashes and reset/session/key material.
      const result = (
        await tx.query<{ total: string; users: unknown }>(
          `WITH matched AS (
          SELECT id,account,display_account,display_name,active,is_platform_admin,row_version,removed_at,removed_by
          FROM app.users WHERE ($4::boolean OR removed_at IS NULL)
            AND ($1='' OR position(lower($1) in lower(account||' '||display_name))>0)
        ) SELECT (SELECT count(*)::text FROM matched) total,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',p.id,'account',COALESCE(NULLIF(p.display_account,''),p.account),
            'displayName',p.display_name,'active',p.active,'isPlatformAdmin',p.is_platform_admin,'rowVersion',p.row_version,
            'removedAt',p.removed_at,'removedBy',p.removed_by
          ) ORDER BY p.account,p.id) FROM (
            SELECT * FROM matched ORDER BY account,id LIMIT $2 OFFSET $3
          ) p),'[]'::jsonb) users`,
          [
            input.search,
            input.pageSize,
            (input.page - 1) * input.pageSize,
            input.includeRemoved,
          ],
        )
      ).rows[0]!;
      return adminUserPageSchema.parse({
        page: input.page,
        pageSize: input.pageSize,
        users: result.users,
        total: Number(result.total),
      });
    });
  }

  async updateUser(
    actor: ActorContext,
    id: string,
    raw: unknown,
  ): Promise<void> {
    const input = adminUpdateUserInputSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948040)');
      await this.lockUsers(tx, [actor.userId, id]);
      await requirePlatformAdmin(tx, actor);
      const previous = (
        await tx.query<UserRow>(
          'SELECT * FROM app.users WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!previous || previous.row_version !== input.rowVersion) stale();
      if (previous.removed_at)
        throw new DomainError(
          'ACCOUNT_UNAVAILABLE',
          '账号已移除，不能重新启用或变更其历史身份。',
          409,
        );
      await this.keepPlatformAdministrator(
        tx,
        previous,
        input.active,
        input.isPlatformAdmin,
      );
      const result = await tx.query(
        `UPDATE app.users SET active=$2,is_platform_admin=$3,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 AND row_version=$4`,
        [id, input.active, input.isPlatformAdmin, input.rowVersion],
      );
      if (!result.rowCount) stale();
      await audit(tx, actor, 'identity.account-updated', id, null, {
        active: input.active,
        isPlatformAdmin: input.isPlatformAdmin,
      });
    });
  }

  /** Web administrators remove an identity once; authorship and private/business data are retained. */
  async removeUser(
    actor: ActorContext,
    id: string,
    raw: unknown,
  ): Promise<AccountRemovalReceipt> {
    const input = removeAccountInputSchema.parse(raw);
    const requestHash = secretHash(
      JSON.stringify({ userId: id, rowVersion: input.rowVersion }),
    );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(415948040)');
      await this.lockUsers(tx, [actor.userId, id]);
      await requirePlatformAdmin(tx, actor);
      const original = (
        await tx.query<{ request_hash: string; receipt: unknown }>(
          'SELECT request_hash,receipt FROM app.account_removals WHERE actor_id=$1 AND command_key=$2',
          [actor.userId, input.commandId],
        )
      ).rows[0];
      if (original) {
        if (original.request_hash !== requestHash)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '原移除标识对应其他账号或基准，请核对原回执。',
            409,
          );
        return accountRemovalReceiptSchema.parse(original.receipt);
      }
      const previous = (
        await tx.query<UserRow>(
          'SELECT * FROM app.users WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!previous) throw new DomainError('NOT_FOUND', '没有此账号。', 404);
      if (previous.removed_at)
        throw new DomainError(
          'ACCOUNT_UNAVAILABLE',
          '账号已移除，请查看已移除记录或原操作回执。',
          409,
        );
      if (previous.row_version !== input.rowVersion) stale();
      await this.keepPlatformAdministrator(
        tx,
        previous,
        false,
        previous.is_platform_admin,
      );
      const removed = (
        await tx.query<UserRow>(
          `UPDATE app.users SET active=false,removed_at=$3,removed_by=$2,
           credential_version=credential_version+1,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
          [id, actor.userId, new Date().toISOString()],
        )
      ).rows[0]!;
      await tx.query(
        'UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1',
        [id],
      );
      await tx.query(
        'UPDATE app.personal_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1',
        [id],
      );
      await tx.query(
        'UPDATE app.password_resets SET used_at=COALESCE(used_at,clock_timestamp()) WHERE user_id=$1',
        [id],
      );
      const receipt = accountRemovalReceiptSchema.parse({
        commandId: input.commandId,
        user: adminUserSchema.parse({
          id: removed.id,
          account: removed.display_account || removed.account,
          displayName: removed.display_name,
          isPlatformAdmin: removed.is_platform_admin,
          rowVersion: removed.row_version,
          active: false,
          removedAt: removed.removed_at!.toISOString(),
          removedBy: actor.userId,
        }),
        removedAt: removed.removed_at!.toISOString(),
        removedBy: actor.userId,
        businessDataDeleted: false,
      });
      await tx.query(
        'INSERT INTO app.account_removals(user_id,actor_id,command_key,request_hash,removed_at,receipt) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          actor.userId,
          input.commandId,
          requestHash,
          receipt.removedAt,
          JSON.stringify(receipt),
        ],
      );
      await audit(tx, actor, 'identity.account-updated', id, null, {
        active: false,
        isPlatformAdmin: removed.is_platform_admin,
        removed: true,
      });
      await audit(tx, actor, 'identity.account-removed', id, null, {
        commandId: input.commandId,
        businessDataDeleted: false,
      });
      return receipt;
    });
  }

  async removalReceipt(
    actor: ActorContext,
    userId: string,
    commandId: string,
  ): Promise<AccountRemovalReceipt> {
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      const row = (
        await tx.query<{ receipt: unknown }>(
          'SELECT receipt FROM app.account_removals WHERE actor_id=$1 AND user_id=$2 AND command_key=$3',
          [actor.userId, userId, commandId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '尚未查到本人的原移除回执；不代表原操作未发生。',
          404,
        );
      return accountRemovalReceiptSchema.parse(row.receipt);
    });
  }

  private async keepPlatformAdministrator(
    tx: SqlExecutor,
    previous: UserRow,
    active: boolean,
    administrator: boolean,
  ) {
    if (
      !previous.active ||
      !previous.is_platform_admin ||
      (active && administrator)
    )
      return;
    if (
      !(
        await tx.query(
          'SELECT 1 FROM app.users WHERE active AND is_platform_admin AND id<>$1 LIMIT 1',
          [previous.id],
        )
      ).rowCount
    )
      throw new DomainError(
        'LAST_PLATFORM_ADMIN',
        '至少保留一个有效的平台管理员账号。',
        409,
      );
  }

  private async personalOnly(
    tx: SqlExecutor,
    actor: ActorContext,
  ): Promise<void> {
    await currentUser(tx, actor);
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '个人配置仅由本人通过网页维护。', 403);
  }

  private async lockUsers(tx: SqlExecutor, ids: string[]): Promise<void> {
    await tx.query(
      'SELECT id FROM app.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [ids],
    );
  }
}
