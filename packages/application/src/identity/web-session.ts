import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  renewWebSessionInputSchema,
  type WebSessionInfo,
} from '../../../contracts/src/web-session.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { secretHash } from './password.js';

export const WEB_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
export const WEB_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
export const WEB_SESSION_RENEW_WINDOW_MS = 24 * 60 * 60_000;

interface SessionRow extends QueryResultRow {
  user_id: string;
  credential_version: number;
  current_credential_version: number;
  active: boolean;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  server_now: Date;
}

function invalid(
  reason: 'session-expired' | 'session-invalidated' | 'session-context-changed',
): never {
  throw new DomainError(
    'UNAUTHENTICATED',
    reason === 'session-expired'
      ? '登录会话已到期，请重新登录。'
      : '登录会话已失效，请重新核对当前身份。',
    401,
    { reason },
  );
}

function scopeId(session: string) {
  return createHash('sha256')
    .update('ath.web-session.context.v1\n')
    .update(secretHash(session))
    .digest('hex');
}

function info(row: SessionRow, session: string): WebSessionInfo {
  const absolute = row.created_at.getTime() + WEB_SESSION_ABSOLUTE_MS;
  const expiry = Math.min(row.expires_at.getTime(), absolute);
  return {
    userId: row.user_id,
    scopeId: scopeId(session),
    expiresAt: new Date(expiry).toISOString(),
    absoluteExpiresAt: new Date(absolute).toISOString(),
    cookieExpiresAt: new Date(absolute).toISOString(),
    renewAfter: new Date(expiry - WEB_SESSION_RENEW_WINDOW_MS).toISOString(),
    serverTime: row.server_now.toISOString(),
  };
}

/** Current state is always read from the database; an expired session never revives. */
export async function readWebSession(
  sql: SqlExecutor,
  session: string | undefined,
  lock = false,
) {
  if (!session)
    throw new DomainError(
      'UNAUTHENTICATED',
      '请登录或配置有效的个人 Key。',
      401,
    );
  const row = (
    await sql.query<SessionRow>(
      `SELECT s.user_id,s.credential_version,s.created_at,s.expires_at,s.revoked_at,
      u.credential_version current_credential_version,u.active,clock_timestamp() server_now
     FROM app.sessions s JOIN app.users u ON u.id=s.user_id WHERE s.id_hash=$1${lock ? ' FOR UPDATE OF s' : ''}`,
      [secretHash(session)],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      'UNAUTHENTICATED',
      '请登录或配置有效的个人 Key。',
      401,
    );
  if (
    row.revoked_at ||
    !row.active ||
    row.credential_version !== row.current_credential_version
  )
    invalid('session-invalidated');
  if (
    row.expires_at.getTime() <= row.server_now.getTime() ||
    row.created_at.getTime() + WEB_SESSION_ABSOLUTE_MS <=
      row.server_now.getTime()
  )
    invalid('session-expired');
  return { row, session: info(row, session) };
}

export async function createWebSession(
  sql: SqlExecutor,
  userId: string,
  credentialVersion: number,
  session: string,
): Promise<WebSessionInfo> {
  await sql.query(
    `INSERT INTO app.sessions(id_hash,user_id,credential_version,expires_at)
     VALUES($1,$2,$3,clock_timestamp()+$4::bigint*interval '1 millisecond')`,
    [secretHash(session), userId, credentialVersion, WEB_SESSION_IDLE_MS],
  );
  return (await readWebSession(sql, session)).session;
}

export class WebSessionService {
  constructor(private readonly db: Database) {}

  async status(
    actor: ActorContext,
    session: string | undefined,
  ): Promise<WebSessionInfo> {
    this.webOnly(actor);
    const current = await readWebSession(this.db, session);
    if (current.session.userId !== actor.userId)
      invalid('session-context-changed');
    return current.session;
  }

  async renew(actor: ActorContext, session: string | undefined, raw: unknown) {
    this.webOnly(actor);
    if (!session) throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
    const input = renewWebSessionInputSchema.parse(raw);
    if (input.userId !== actor.userId) invalid('session-context-changed');
    return this.db.transaction(async (tx) => {
      // Same user-first ordering as password change/account revocation.
      await tx.query('SELECT id FROM app.users WHERE id=$1 FOR UPDATE', [
        actor.userId,
      ]);
      const current = await readWebSession(tx, session, true);
      if (
        current.session.userId !== actor.userId ||
        current.session.scopeId !== input.scopeId
      )
        invalid('session-context-changed');
      const { row } = current;
      const now = row.server_now.getTime();
      const expiry = Date.parse(current.session.expiresAt);
      const next = Math.min(
        now + WEB_SESSION_IDLE_MS,
        Date.parse(current.session.absoluteExpiresAt),
      );
      if (expiry - now >= WEB_SESSION_RENEW_WINDOW_MS || next <= expiry)
        return { session: current.session, renewed: false };
      const updated = await tx.query(
        `UPDATE app.sessions SET expires_at=$3 WHERE id_hash=$1 AND user_id=$2
         AND revoked_at IS NULL AND credential_version=$4 AND expires_at>clock_timestamp()
         AND created_at+$5::bigint*interval '1 millisecond'>clock_timestamp()`,
        [
          secretHash(session),
          actor.userId,
          new Date(next),
          row.current_credential_version,
          WEB_SESSION_ABSOLUTE_MS,
        ],
      );
      if (!updated.rowCount) invalid('session-expired');
      return {
        session: (await readWebSession(tx, session)).session,
        renewed: true,
      };
    });
  }

  private webOnly(actor: ActorContext) {
    if (actor.entrypoint !== 'web')
      throw new DomainError(
        'FORBIDDEN',
        '网页登录会话仅由当前网页本人维护。',
        403,
      );
  }
}
