import type {
  ActorContext,
  Capability,
  ProjectRole,
} from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError, forbidden } from '../errors.js';

export async function currentUser(sql: SqlExecutor, actor: ActorContext) {
  const result = await sql.query<{
    id: string;
    active: boolean;
    is_platform_admin: boolean;
  }>(
    'SELECT id,active,is_platform_admin FROM app.users WHERE id=$1 FOR SHARE',
    [actor.userId],
  );
  const user = result.rows[0];
  if (!user?.active)
    throw new DomainError(
      'UNAUTHENTICATED',
      '账号已失效，请重新登录或联系管理员。',
      401,
    );
  if (actor.keyId) {
    const key = await sql.query<{
      allowed_scope: { capabilities?: Capability[] };
    }>(
      'SELECT allowed_scope FROM app.personal_keys WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE',
      [actor.keyId, actor.userId],
    );
    if (!key.rows[0])
      throw new DomainError('UNAUTHENTICATED', '个人 Key 已撤销。', 401);
    // The current stored scope is authoritative, even when an older actor context exists.
    const capabilities = key.rows[0].allowed_scope.capabilities;
    if (capabilities) actor.allowedCapabilities = capabilities;
    else delete actor.allowedCapabilities;
  }
  return user;
}

export async function requirePlatformAdmin(
  sql: SqlExecutor,
  actor: ActorContext,
): Promise<void> {
  const user = await currentUser(sql, actor);
  if (
    actor.entrypoint !== 'web' ||
    !user.is_platform_admin ||
    (actor.keyId && !actor.allowedCapabilities?.includes('platform.manage'))
  )
    forbidden();
}

export async function requireBusinessAdministrator(
  sql: SqlExecutor,
  actor: ActorContext,
) {
  const user = await currentUser(sql, actor);
  if (
    !user.is_platform_admin ||
    actor.entrypoint === 'worker' ||
    (actor.entrypoint === 'official-mcp' &&
      (!actor.keyId || !actor.allowedCapabilities?.includes('platform.manage')))
  )
    forbidden();
}

export function permitsPersonalData(actor: ActorContext): boolean {
  return (
    actor.entrypoint === 'web' ||
    actor.entrypoint === 'internal-ai' ||
    (actor.entrypoint === 'official-mcp' &&
      !!actor.keyId &&
      actor.allowedCapabilities?.includes('personal.data') === true)
  );
}

function inheritsPlatformAdmin(
  actor: ActorContext,
  user: Awaited<ReturnType<typeof currentUser>>,
) {
  return (
    user.is_platform_admin &&
    !actor.keyId &&
    (actor.entrypoint === 'web' || actor.entrypoint === 'internal-ai')
  );
}

interface ProjectAccessRow {
  id: string;
  name: string;
  row_version: number;
  is_admin: boolean | null;
  roles: ProjectRole[] | null;
  member_version: number | null;
}

const projectAccessRows = `
  SELECT p.id,p.name,p.row_version,m.is_admin,m.roles,m.member_version
  FROM app.projects p
  LEFT JOIN LATERAL (
    SELECT pm.is_admin,pm.roles,pm.row_version AS member_version
    FROM app.project_members pm
    WHERE pm.project_id=p.id AND pm.user_id=$1 AND pm.active
    FOR SHARE OF pm
  ) m ON true
  WHERE p.active`;

export async function listProjectAccess(sql: SqlExecutor, actor: ActorContext) {
  const user = await currentUser(sql, actor);
  if (
    actor.allowedCapabilities &&
    !actor.allowedCapabilities.includes('project.read')
  )
    forbidden();
  const inherited = inheritsPlatformAdmin(actor, user);
  const { rows } = await sql.query<ProjectAccessRow>(
    `${projectAccessRows}
     AND (m.member_version IS NOT NULL OR $2) ORDER BY p.created_at,p.id
     FOR SHARE OF p`,
    [actor.userId, inherited],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rowVersion: row.row_version,
    isAdmin: inherited || Boolean(row.is_admin),
    roles: row.roles ?? [],
    inheritsPlatformAdmin: inherited,
    memberVersion: row.member_version,
  }));
}

type DraftWriteCapability = 'requirements.write' | 'assets.write';

export function requireProjectDraftWrite(
  sql: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  capability: DraftWriteCapability,
) {
  return authorizeProject(sql, actor, projectId, capability, true);
}

const testerActions = new Set<Capability>([
  'requirements.write',
  'assets.write',
  'reviews.approve',
  'plans.write',
  'runs.organize',
  'results.submit',
  'results.assess',
  'issues.lifecycle',
]);
const memberActions = new Set<Capability>([
  'project.read',
  'requirements.participants.write',
  'requirements.state.write',
  'files.transfer',
  'test-configuration.read',
  'database-connections.metadata.read',
  'knowledge.write',
]);
const inheritedAdminActions = new Set<Capability>([
  'project.read',
  'project.members.manage',
  'requirements.participants.write',
  'files.transfer',
  'test-configuration.read',
  'test-configuration.write',
  'database-connections.metadata.read',
  'database-connections.write',
]);

export function requireProject(
  sql: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  capability: Capability,
): Promise<{ isAdmin: boolean; roles: ProjectRole[] }> {
  return authorizeProject(sql, actor, projectId, capability, false);
}

async function authorizeProject(
  sql: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  capability: Capability,
  draftWrite: boolean,
): Promise<{ isAdmin: boolean; roles: ProjectRole[] }> {
  const user = await currentUser(sql, actor);
  if (
    actor.allowedCapabilities &&
    !actor.allowedCapabilities.includes(capability)
  )
    forbidden();
  if (
    inheritsPlatformAdmin(actor, user) &&
    (draftWrite || inheritedAdminActions.has(capability))
  ) {
    const result = await sql.query<ProjectAccessRow>(
      `${projectAccessRows} AND p.id=$2 FOR SHARE OF p`,
      [actor.userId, projectId],
    );
    const project = result.rows[0];
    if (!project) forbidden();
    return { isAdmin: true, roles: project.roles ?? [] };
  }
  const result = await sql.query<{ is_admin: boolean; roles: ProjectRole[] }>(
    `SELECT m.is_admin,m.roles FROM app.project_members m JOIN app.projects p ON p.id=m.project_id
     WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND p.active FOR SHARE OF m,p`,
    [projectId, actor.userId],
  );
  const member = result.rows[0];
  if (!member) forbidden();
  const tester = member.roles.includes('tester');
  const developer = member.roles.includes('developer');
  const product = member.roles.includes('product');
  // New capability names are denied until a deliberate role rule is added here.
  let allowed = memberActions.has(capability);
  if (testerActions.has(capability)) allowed = tester;
  if (capability === 'project.members.manage')
    allowed =
      (actor.entrypoint === 'web' ||
        actor.entrypoint === 'internal-ai' ||
        (actor.entrypoint === 'official-mcp' &&
          !!actor.keyId &&
          actor.allowedCapabilities?.includes('project.members.manage') ===
            true)) &&
      member.is_admin;
  if (capability === 'test-configuration.write')
    allowed = tester || member.is_admin;
  if (capability === 'database-connections.write')
    allowed = tester || developer || member.is_admin;
  if (capability === 'issues.create') allowed = tester || product;
  if (capability === 'issues.handle') allowed = tester || developer;
  if (capability === 'platform.manage' || capability === 'personal-key.manage')
    allowed = false;
  if (!allowed) forbidden();
  return { isAdmin: member.is_admin, roles: member.roles };
}
