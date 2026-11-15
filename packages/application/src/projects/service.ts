import {
  createProjectInputSchema,
  updateMemberInputSchema,
  type ActorContext,
  type ProjectRole,
} from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import {
  currentUser,
  requirePlatformAdmin,
  requireProject,
} from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';

interface MemberRow {
  user_id: string;
  account: string;
  display_account: string;
  display_name: string;
  active: boolean;
  is_admin: boolean;
  roles: ProjectRole[];
  row_version: number;
}

export class ProjectService {
  constructor(readonly db: Database) {}

  async list(actor: ActorContext) {
    return this.db.transaction(async (tx) => {
      const user = await currentUser(tx, actor);
      if (
        actor.allowedCapabilities &&
        !actor.allowedCapabilities.includes('project.read')
      ) {
        throw new DomainError(
          'FORBIDDEN',
          '此个人 Key 未开放项目读取能力。',
          403,
        );
      }
      const result = await tx.query<{
        id: string;
        name: string;
        is_admin: boolean | null;
        roles: ProjectRole[] | null;
        row_version: number;
      }>(
        `SELECT p.id,p.name,m.is_admin,m.roles,p.row_version FROM app.projects p
         LEFT JOIN app.project_members m ON m.project_id=p.id AND m.user_id=$1 AND m.active
         WHERE p.active AND (m.user_id IS NOT NULL OR $2) ORDER BY p.created_at,p.id`,
        [actor.userId, actor.entrypoint === 'web' && user.is_platform_admin],
      );
      return {
        projects: result.rows.map((p) => ({
          id: p.id,
          name: p.name,
          isAdmin: p.is_admin ?? false,
          roles: p.roles ?? [],
          rowVersion: p.row_version,
        })),
      };
    });
  }

  async create(actor: ActorContext, raw: unknown) {
    const input = createProjectInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actor);
      const users = await tx.query<{ id: string }>(
        'SELECT id FROM app.users WHERE id=ANY($1::uuid[]) AND active FOR SHARE',
        [input.administratorIds],
      );
      if (users.rowCount !== input.administratorIds.length) {
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '项目管理员必须是已注册的有效账号。',
          422,
        );
      }
      const project = (
        await tx.query<{ id: string; name: string; row_version: number }>(
          'INSERT INTO app.projects(name,created_by) VALUES($1,$2) RETURNING id,name,row_version',
          [input.name, actor.userId],
        )
      ).rows[0];
      if (!project) throw new Error('Project insert returned no row');
      for (const user of users.rows) {
        await tx.query(
          'INSERT INTO app.project_members(project_id,user_id,is_admin) VALUES($1,$2,true)',
          [project.id, user.id],
        );
      }
      await audit(tx, actor, 'project.created', project.id, project.id, {
        administratorIds: input.administratorIds,
      });
      return {
        project: {
          id: project.id,
          name: project.name,
          rowVersion: project.row_version,
          isAdmin: input.administratorIds.includes(actor.userId),
          roles: [],
        },
      };
    });
  }

  async members(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      // The Web roster is readable by current project members; management and
      // non-Web tools retain their separate authorization boundary.
      const webUser =
        actor.entrypoint === 'web' ? await currentUser(tx, actor) : null;
      await requireProject(
        tx,
        actor,
        projectId,
        webUser && !webUser.is_platform_admin
          ? 'project.read'
          : 'project.members.manage',
      );
      const result = await tx.query<MemberRow>(
        `SELECT m.user_id,u.account,u.display_account,u.display_name,u.active,m.is_admin,m.roles,m.row_version
         FROM app.project_members m JOIN app.users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.active ORDER BY u.account`,
        [projectId],
      );
      return {
        members: result.rows.map((m) => ({
          userId: m.user_id,
          account: m.display_account || m.account,
          displayName: m.display_name,
          active: m.active,
          isAdmin: m.is_admin,
          roles: m.roles,
          rowVersion: m.row_version,
        })),
      };
    });
  }

  async memberCandidates(
    actor: ActorContext,
    projectId: string,
    search: string,
  ) {
    if (
      search.length > 100 ||
      (actor.entrypoint === 'internal-ai' && search.trim().length < 2)
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        '成员候选请提供明确姓名或账号关键字。',
        400,
      );
    }
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.members.manage');
      if (
        !(
          await tx.query('SELECT 1 FROM app.projects WHERE id=$1 AND active', [
            projectId,
          ])
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '项目不存在。', 404);
      const rows = await tx.query<{
        id: string;
        account: string;
        display_account: string;
        display_name: string;
        active: boolean;
        member_active: boolean | null;
        row_version: number | null;
      }>(
        `SELECT u.id,u.account,u.display_account,u.display_name,u.active,m.active member_active,m.row_version
         FROM app.users u LEFT JOIN app.project_members m ON m.project_id=$1 AND m.user_id=u.id
         WHERE u.active AND ($2='' OR position(lower($2) in lower(u.account||' '||u.display_name))>0) ORDER BY u.account LIMIT 200`,
        [projectId, search.trim()],
      );
      return {
        users: rows.rows.map((user) => ({
          id: user.id,
          account: user.display_account || user.account,
          displayName: user.display_name,
          active: user.active,
          membership:
            user.row_version === null
              ? null
              : {
                  active: user.member_active ?? false,
                  rowVersion: user.row_version,
                },
        })),
      };
    });
  }

  async updateMember(
    actor: ActorContext,
    projectId: string,
    userId: string,
    raw: unknown,
  ): Promise<void> {
    const input = updateMemberInputSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await this.lockProject(tx, projectId);
      await requireProject(tx, actor, projectId, 'project.members.manage');
      const user = (
        await tx.query<{ active: boolean }>(
          'SELECT active FROM app.users WHERE id=$1 FOR SHARE',
          [userId],
        )
      ).rows[0];
      if (!user?.active)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '只能添加或配置有效账号。',
          422,
        );
      const member = (
        await tx.query<{
          row_version: number;
          active: boolean;
          is_admin: boolean;
        }>(
          'SELECT row_version,active,is_admin FROM app.project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE',
          [projectId, userId],
        )
      ).rows[0];
      if (!member) {
        if (input.rowVersion !== 0) stale();
        await tx.query(
          'INSERT INTO app.project_members(project_id,user_id,is_admin,roles) VALUES($1,$2,$3,$4)',
          [projectId, userId, input.isAdmin, input.roles],
        );
      } else {
        // An explicitly removed relationship may be re-added, but its historical baseline is not reset.
        if (member.row_version !== input.rowVersion) stale();
        if (member.active && member.is_admin && !input.isAdmin)
          await this.ensureOtherAdmin(tx, projectId, userId);
        await tx.query(
          `UPDATE app.project_members SET is_admin=$3,roles=$4,active=true,row_version=row_version+1,
           updated_at=clock_timestamp() WHERE project_id=$1 AND user_id=$2`,
          [projectId, userId, input.isAdmin, input.roles],
        );
      }
      await audit(tx, actor, 'project.member-updated', userId, projectId, {
        isAdmin: input.isAdmin,
        roles: input.roles,
      });
    });
  }

  async removeMember(
    actor: ActorContext,
    projectId: string,
    userId: string,
    rowVersion: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockProject(tx, projectId);
      await requireProject(tx, actor, projectId, 'project.members.manage');
      const member = (
        await tx.query<{
          row_version: number;
          is_admin: boolean;
          user_active: boolean;
        }>(
          `SELECT m.row_version,m.is_admin,u.active user_active FROM app.project_members m JOIN app.users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.user_id=$2 AND m.active FOR UPDATE OF m`,
          [projectId, userId],
        )
      ).rows[0];
      if (!member)
        throw new DomainError('NOT_FOUND', '此项目成员已不存在。', 404);
      if (member.row_version !== rowVersion) stale();
      if (member.is_admin && member.user_active)
        await this.ensureOtherAdmin(tx, projectId, userId);
      await tx.query(
        `UPDATE app.project_members SET active=false,row_version=row_version+1,updated_at=clock_timestamp()
         WHERE project_id=$1 AND user_id=$2`,
        [projectId, userId],
      );
      await audit(tx, actor, 'project.member-removed', userId, projectId);
    });
  }

  private async lockProject(tx: SqlExecutor, id: string): Promise<void> {
    if (
      !(
        await tx.query(
          'SELECT id FROM app.projects WHERE id=$1 AND active FOR UPDATE',
          [id],
        )
      ).rowCount
    ) {
      throw new DomainError('NOT_FOUND', '项目不存在。', 404);
    }
  }

  private async ensureOtherAdmin(
    tx: SqlExecutor,
    projectId: string,
    exceptUserId: string,
  ): Promise<void> {
    if (
      !(
        await tx.query(
          `SELECT m.user_id FROM app.project_members m JOIN app.users u ON u.id=m.user_id
       WHERE m.project_id=$1 AND m.user_id<>$2 AND m.active AND m.is_admin AND u.active FOR SHARE OF u`,
          [projectId, exceptUserId],
        )
      ).rowCount
    )
      throw new DomainError(
        'LAST_PROJECT_ADMIN',
        '请先指定另一名有效项目管理员。',
        409,
      );
  }
}
