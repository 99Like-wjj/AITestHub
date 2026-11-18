import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { RequirementMaterialInput } from '../../../contracts/src/requirements.js';
import {
  createRequirementResourceInputSchema as createRequirementInputSchema,
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
  requirementParticipantsInputSchema,
  requirementStateInputSchema,
  requirementArchiveInputSchema,
  requirementCandidatesInputSchema,
  requirementPageQuerySchema,
  requirementPageSchema,
  requirementParticipantSchema,
  requirementCollaborationInputSchema,
} from '../../../contracts/src/requirements.js';
import {
  materialSchema,
  requirementSchema,
} from '../../../contracts/src/domain.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { rejectMissingAcceptedReceipt } from '../recovery/receipts.js';
import { RequirementDeletionService } from './deletion.js';
import { prepareRequirementVersion } from './preparation.js';
import { matchRequirementMaterials } from './material-matching.js';
import { sanitizeSourceLinkFields } from '../../../contracts/src/source-links.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import {
  fileResourcePolicies,
  fileIntentDigest,
  assertFilePolicyCounts,
  type FileResourcePolicies,
  type FilePolicySnapshot,
} from '../files/resource-policy.js';

interface RequirementRow {
  id: string;
  project_id: string;
  business_number: string | null;
  title: string;
  lifecycle: 'inProgress' | 'archived' | 'paused' | 'completed' | 'terminated';
  inactive?: boolean;
  archived_at: Date | null;
  business_updated_at: Date;
  row_version: number;
}
interface VersionRow {
  id: string;
  requirement_id: string;
  project_id: string;
  version_no: number;
  summary: string;
  material_set_digest: string;
  materials: unknown;
  created_by: string;
  created_at: Date;
}
const requirementDto = (r: RequirementRow) =>
  requirementSchema.parse(
    sanitizeSourceLinkFields({
      id: r.id,
      projectId: r.project_id,
      businessNumber: r.business_number,
      title: r.title,
      lifecycle:
        r.archived_at !== null || r.lifecycle !== 'inProgress'
          ? 'archived'
          : 'inProgress',
      inactive:
        r.archived_at === null &&
        r.lifecycle === 'inProgress' &&
        r.inactive === true,
      archivedAt: r.archived_at?.toISOString() ?? null,
      businessUpdatedAt: r.business_updated_at.toISOString(),
      rowVersion: r.row_version,
    }),
  );
const versionDto = (r: VersionRow) => {
  const safe = sanitizeSourceLinkFields({
    id: r.id,
    requirementId: r.requirement_id,
    projectId: r.project_id,
    versionNo: r.version_no,
    summary: r.summary,
    materialSetDigest: r.material_set_digest,
    materials: r.materials,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  });
  return { ...safe, materials: materialSchema.array().parse(safe.materials) };
};

/** Called inside another domain command's transaction; routine API executions must not call this. */
export async function recordBusinessActivity(
  tx: SqlExecutor,
  projectId: string,
  requirementVersionId: string,
): Promise<void> {
  const updated = await tx.query(
    `UPDATE app.requirements r SET business_updated_at=clock_timestamp(),row_version=row_version+1
     WHERE r.project_id=$1 AND EXISTS(SELECT 1 FROM app.requirement_versions v
       WHERE v.id=$2 AND v.project_id=r.project_id AND v.requirement_id=r.id)`,
    [projectId, requirementVersionId],
  );
  if (!updated.rowCount)
    throw new DomainError('NOT_FOUND', '此范围内没有该需求版本。', 404);
}
// Calendar months use the product timezone, independent of the PG session/server timezone.
export const requirementInactivityDeadlineSql =
  "((r.business_updated_at AT TIME ZONE 'Asia/Shanghai') + interval '3 months') AT TIME ZONE 'Asia/Shanghai'";
export async function recordRequirementActivity(
  tx: SqlExecutor,
  projectId: string,
  requirementId: string,
): Promise<void> {
  if (
    !(
      await tx.query(
        'UPDATE app.requirements SET business_updated_at=clock_timestamp(),row_version=row_version+1 WHERE project_id=$1 AND id=$2',
        [projectId, requirementId],
      )
    ).rowCount
  ) {
    throw new DomainError('NOT_FOUND', '此项目内没有该需求。', 404);
  }
}

export type RequirementNameAdmission = (
  tx: SqlExecutor,
  actor: ActorContext,
  requirement: ReturnType<typeof requirementDto>,
  version: ReturnType<typeof versionDto>,
) => Promise<void>;

export class RequirementService {
  readonly operations: OperationService;
  readonly deletions: RequirementDeletionService;
  constructor(
    readonly db: Database,
    readonly policies: FileResourcePolicies = fileResourcePolicies,
    private readonly admitName?: RequirementNameAdmission,
  ) {
    this.operations = new OperationService(db);
    this.deletions = new RequirementDeletionService(db);
  }
  previewDeletion(actor: ActorContext, projectId: string, id: string) {
    return this.deletions.preview(actor, projectId, id);
  }
  deleteUnused(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    return this.deletions.commit(actor, projectId, id, raw);
  }
  deletionReceipt(
    actor: ActorContext,
    projectId: string,
    id: string,
    key: string,
  ) {
    return this.deletions.receipt(actor, projectId, id, key);
  }

  async list(actor: ActorContext, projectId: string, archived = false) {
    const page = await this.listPage(actor, projectId, {
      archived,
      pageSize: 200,
    });
    return {
      requirements: page.requirements,
      ...(page.hasMore ? { hasMore: true, nextPage: 2 } : {}),
    };
  }
  async listPage(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = requirementPageQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      type Item = RequirementRow & {
        inactive: boolean;
        latest_version_id: string;
        latest_version_no: number;
        participant_count: string;
        participant_preview: unknown;
        is_participant: boolean;
        ui_case_count: number;
        api_case_count: number;
        total: string;
      };
      const rows = await tx.query<Item | { id: null; total: string }>(
        `WITH base AS MATERIALIZED (
        SELECT r.*,r.archived_at IS NULL AND r.lifecycle='inProgress' AND (${requirementInactivityDeadlineSql})<=clock_timestamp() inactive,
          v.id latest_version_id,v.version_no latest_version_no
        FROM app.requirements r JOIN LATERAL(SELECT id,version_no FROM app.requirement_versions WHERE project_id=r.project_id AND requirement_id=r.id ORDER BY version_no DESC LIMIT 1)v ON true
        WHERE r.project_id=$1 AND (($2 AND r.archived_at IS NOT NULL) OR (NOT $2 AND r.archived_at IS NULL))
      ),filtered AS MATERIALIZED(
        SELECT b.* FROM base b WHERE ($3='all' OR EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.project_id=$1 AND rp.requirement_id=b.id AND rp.user_id=$4 AND rp.active))
        AND ($5='all' OR ($5='inactive' AND b.inactive) OR ($5='inProgress' AND b.lifecycle='inProgress' AND NOT b.inactive) OR ($5='archived' AND b.archived_at IS NOT NULL))
        AND ($6='' OR position(lower($6) in lower(b.title||' '||COALESCE(b.business_number,'')||' '||b.id::text))>0)
      ),total AS(SELECT count(*)::text total FROM filtered),page AS(
        SELECT * FROM filtered ORDER BY CASE WHEN lifecycle='inProgress' THEN CASE WHEN inactive THEN 1 ELSE 0 END ELSE 2 END,business_updated_at DESC,id LIMIT $7 OFFSET $8
      )SELECT page.*,total.total,
        (SELECT count(*)::text FROM app.requirement_participants rp JOIN app.project_members m ON m.project_id=rp.project_id AND m.user_id=rp.user_id JOIN app.users u ON u.id=rp.user_id WHERE rp.project_id=$1 AND rp.requirement_id=page.id AND rp.active AND m.active AND u.active) participant_count,
        EXISTS(SELECT 1 FROM app.requirement_participants rp WHERE rp.project_id=$1 AND rp.requirement_id=page.id AND rp.user_id=$4 AND rp.active) is_participant,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',member.id,'account',member.display_account,'displayName',member.display_name) ORDER BY member.account) FROM (
          SELECT u.id,u.account,u.display_account,u.display_name FROM app.requirement_participants rp JOIN app.project_members m ON m.project_id=rp.project_id AND m.user_id=rp.user_id JOIN app.users u ON u.id=rp.user_id
          WHERE rp.project_id=$1 AND rp.requirement_id=page.id AND rp.active AND m.active AND u.active ORDER BY u.account LIMIT 3
        )member),'[]'::jsonb) participant_preview,
        (SELECT count(*)::integer FROM app.test_assets a WHERE a.project_id=$1 AND a.requirement_version_id=page.latest_version_id AND a.kind='UI' AND a.target_type='case' AND a.removed_at IS NULL) ui_case_count,
        (SELECT count(*)::integer FROM app.test_assets a WHERE a.project_id=$1 AND a.requirement_version_id=page.latest_version_id AND a.kind='API' AND a.target_type='case' AND a.removed_at IS NULL) api_case_count
        FROM total LEFT JOIN page ON true ORDER BY CASE WHEN page.lifecycle='inProgress' THEN CASE WHEN page.inactive THEN 1 ELSE 0 END ELSE 2 END,page.business_updated_at DESC,page.id`,
        [
          projectId,
          input.archived,
          input.participation,
          actor.userId,
          input.status,
          input.search,
          input.pageSize,
          (input.page - 1) * input.pageSize,
        ],
      );
      const actual = rows.rows.filter((r): r is Item => r.id !== null),
        total = Number(rows.rows[0]?.total ?? '0');
      return requirementPageSchema.parse({
        requirements: actual.map((r) => ({
          ...requirementDto(r),
          inactive: r.inactive,
          latestVersionId: r.latest_version_id,
          latestVersionNo: r.latest_version_no,
          participantCount: Number(r.participant_count),
          participantPreview: requirementParticipantSchema
            .array()
            .parse(r.participant_preview),
          isParticipant: r.is_participant,
          uiCaseCount: r.ui_case_count,
          apiCaseCount: r.api_case_count,
        })),
        page: input.page,
        pageSize: input.pageSize,
        total,
        hasMore: input.page * input.pageSize < total,
      });
    });
  }

  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const requirement = await this.get(tx, projectId, id);
      const versions = await tx.query<VersionRow>(
        'SELECT * FROM app.requirement_versions WHERE requirement_id=$1 AND project_id=$2 ORDER BY version_no DESC',
        [id, projectId],
      );
      const participants = await tx.query<{
        id: string;
        account: string;
        display_name: string;
      }>(
        `SELECT u.id,u.display_account account,u.display_name FROM app.requirement_participants rp
         JOIN app.project_members m ON m.project_id=rp.project_id AND m.user_id=rp.user_id
         JOIN app.users u ON u.id=rp.user_id WHERE rp.requirement_id=$1 AND rp.active AND m.active AND u.active ORDER BY u.account`,
        [id],
      );
      return {
        requirement: requirementDto(requirement),
        versions: versions.rows.map(versionDto),
        participants: participants.rows.map((u) => ({
          id: u.id,
          account: u.account,
          displayName: u.display_name,
        })),
      };
    });
  }

  async eligibleParticipants(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<{
        id: string;
        account: string;
        display_name: string;
      }>(
        `SELECT u.id,u.display_account account,u.display_name FROM app.project_members m JOIN app.users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.active AND u.active ORDER BY u.account LIMIT 1000`,
        [projectId],
      );
      return {
        users: rows.rows.map((u) => ({
          id: u.id,
          account: u.account,
          displayName: u.display_name,
        })),
      };
    });
  }

  async candidates(actor: ActorContext, raw: unknown) {
    const input = requirementCandidatesInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, input.projectId, 'project.read');
      if (input.materials?.some((material) => material.fileResourceId))
        await requireProject(tx, actor, input.projectId, 'files.transfer');
      const exact = input.materials
        ? await matchRequirementMaterials(tx, input.projectId, input.materials)
        : { complete: false, matches: [] };
      const exactIds = [
        ...new Set(exact.matches.map((match) => match.requirementId)),
      ];
      const rows = await tx.query<RequirementRow>(
        `SELECT r.*,r.archived_at IS NULL AND r.lifecycle='inProgress' AND (${requirementInactivityDeadlineSql})<=clock_timestamp() inactive FROM app.requirements r WHERE r.project_id=$1 AND
         (id=ANY($4::uuid[]) OR ($2::text IS NOT NULL AND business_number=$2) OR lower(title)=lower($3) OR position(lower($3) in lower(title))>0)
         ORDER BY (id=ANY($4::uuid[])) DESC,business_updated_at DESC,id LIMIT 250`,
        [input.projectId, input.businessNumber || null, input.title, exactIds],
      );
      const latest = (
        await tx.query<{
          requirement_id: string;
          id: string;
          version_no: number;
        }>(
          'SELECT DISTINCT ON (requirement_id) requirement_id,id,version_no FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=ANY($2::uuid[]) ORDER BY requirement_id,version_no DESC',
          [input.projectId, rows.rows.map((row) => row.id)],
        )
      ).rows;
      // Auxiliary-model lookup is separate and must never turn failure into "no duplicate exists".
      return {
        candidates: rows.rows.map(requirementDto),
        exactMaterialMatches: exact.matches,
        latestVersions: latest.map((version) => ({
          requirementId: version.requirement_id,
          requirementVersionId: version.id,
          versionNo: version.version_no,
        })),
        materialMatchComplete: exact.complete,
        lookupIncomplete: !exact.complete || exact.matches.length === 0,
        lookupMessage: input.materials
          ? exact.complete
            ? exact.matches.length
              ? '已按本项目完整文件集合的用途、顺序和已验证SHA-256找到完全相同版本；请明确采用已有版本、开新版或独立新建。'
              : '完整文件集合已核对，未找到完全相同版本；编号/名称仅提供候选。语义查找未执行，不能断言不存在相似需求。'
            : '本次含来源链接或候选超过读取上限，完整材料比对未完成；链接相同不证明内容相同。'
          : actor.entrypoint === 'web'
            ? '本次仅完成本地编号与名称规则匹配；网页语义查找由本人主动触发，不能据无候选断言不存在重复。'
            : '本次仅提供编号与名称，未提供本地自动语义比较所需的完整材料；可使用完整材料find流程，未完成不表示不存在重复。',
      };
    });
  }

  async create(actor: ActorContext, raw: unknown) {
    const input = createRequirementInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'requirements.create',
      input.submissionId,
      input,
      async (tx) => {
        await requireProject(tx, actor, input.projectId, 'requirements.write');
      },
      async (tx) => {
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId: input.projectId,
          namespace: 'requirements.create',
          key: input.submissionId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        await this.numberAvailable(tx, input.projectId, input.businessNumber);
        const row = (
          await tx.query<RequirementRow>(
            `INSERT INTO app.requirements(project_id,business_number,title,created_by) VALUES($1,$2,$3,$4) RETURNING *`,
            [input.projectId, input.businessNumber, input.title, actor.userId],
          )
        ).rows[0];
        if (!row) throw new Error('Requirement insert returned no row');
        const version = await this.insertVersion(
          tx,
          actor,
          row,
          1,
          input.summary,
          input.materials,
          policy,
        );
        const requirement = requirementDto(row);
        await audit(tx, actor, 'requirement.created', row.id, input.projectId, {
          versionId: version.id,
        });
        await this.admitName?.(tx, actor, requirement, version);
        return { requirement, version };
      },
      input.projectId,
    );
  }

  prepareVersion(actor: ActorContext, raw: unknown) {
    return prepareRequirementVersion(this.db, actor, raw, this.policies);
  }

  async addVersion(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = addRequirementVersionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'requirements.add-version',
      input.submissionId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'requirements.write');
      },
      async (tx) => {
        const requirement = await this.get(tx, projectId, id, true);
        if (requirement.row_version !== input.rowVersion) stale();
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'requirements.add-version',
          key: input.submissionId,
          payloadDigest: fileIntentDigest({ projectId, id, ...input }),
          existing: false,
        });
        const latest = (
          await tx.query<{ no: number }>(
            'SELECT max(version_no)::integer no FROM app.requirement_versions WHERE requirement_id=$1',
            [id],
          )
        ).rows[0];
        const version = await this.insertVersion(
          tx,
          actor,
          requirement,
          (latest?.no ?? 0) + 1,
          input.summary,
          input.materials,
          policy,
        );
        const row = (
          await tx.query<RequirementRow>(
            'UPDATE app.requirements SET row_version=row_version+1,business_updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [id],
          )
        ).rows[0];
        if (!row) throw new Error('Requirement update returned no row');
        await audit(tx, actor, 'requirement.version-created', id, projectId, {
          versionId: version.id,
        });
        return { requirement: requirementDto(row), version };
      },
      projectId,
    );
  }

  async participants(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementParticipantsInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'requirements.participants',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(
          tx,
          actor,
          projectId,
          'requirements.participants.write',
        );
      },
      async (tx) => {
        const requirement = await this.get(tx, projectId, id, true);
        if (requirement.row_version !== input.rowVersion) stale();
        const members = await tx.query(
          `SELECT m.user_id FROM app.project_members m JOIN app.users u ON u.id=m.user_id
           WHERE m.project_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.active AND u.active FOR SHARE OF m,u`,
          [projectId, input.userIds],
        );
        if (members.rowCount !== input.userIds.length)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '参与人中包含失效或非本项目成员。',
            422,
          );
        await tx.query(
          'UPDATE app.requirement_participants SET active=false,updated_at=clock_timestamp() WHERE requirement_id=$1',
          [id],
        );
        for (const userId of input.userIds)
          await tx.query(
            `INSERT INTO app.requirement_participants(requirement_id,project_id,user_id,added_by) VALUES($1,$2,$3,$4)
           ON CONFLICT(requirement_id,user_id) DO UPDATE SET active=true,updated_at=clock_timestamp()`,
            [id, projectId, userId, actor.userId],
          );
        await tx.query(
          'UPDATE app.requirements SET row_version=row_version+1 WHERE id=$1',
          [id],
        );
        await audit(
          tx,
          actor,
          'requirement.participants-updated',
          id,
          projectId,
          { userIds: input.userIds },
        );
        return { completed: true, rowVersion: input.rowVersion + 1 };
      },
      projectId,
    );
  }

  async setState(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementStateInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'requirements.state',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'requirements.write');
      },
      async (tx) => {
        const row = await this.get(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (
          row.lifecycle === input.lifecycle &&
          Boolean(row.archived_at) === (input.lifecycle === 'archived')
        )
          return { completed: true, rowVersion: row.row_version };
        await tx.query(
          "UPDATE app.requirements SET lifecycle=$2,archived_at=CASE WHEN $2='archived' THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,row_version=row_version+1 WHERE id=$1",
          [id, input.lifecycle],
        );
        await audit(tx, actor, 'requirement.state-updated', id, projectId, {
          lifecycle: input.lifecycle,
        });
        return { completed: true, rowVersion: input.rowVersion + 1 };
      },
      projectId,
    );
  }

  async collaboration(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementCollaborationInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      `requirements.collaboration.${id}`,
      input.commandId,
      { projectId, id, ...input },
      (tx) =>
        requireProject(
          tx,
          actor,
          projectId,
          'requirements.participants.write',
        ).then(() => undefined),
      async (tx) => {
        const row = await this.get(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (row.lifecycle !== input.lifecycle)
          await requireProject(tx, actor, projectId, 'requirements.write');
        const members = await tx.query(
          `SELECT m.user_id FROM app.project_members m JOIN app.users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.active AND u.active ORDER BY m.user_id FOR SHARE OF m,u`,
          [projectId, input.userIds],
        );
        if (members.rowCount !== input.userIds.length)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '参与人包含失效或非本项目成员。',
            422,
          );
        const previous = (
          await tx.query<{ user_id: string }>(
            'SELECT user_id FROM app.requirement_participants WHERE requirement_id=$1 AND active ORDER BY user_id',
            [id],
          )
        ).rows.map((r) => r.user_id);
        const same =
          JSON.stringify(previous) ===
          JSON.stringify([...input.userIds].sort());
        if (same && row.lifecycle === input.lifecycle)
          return { completed: true, rowVersion: row.row_version };
        await tx.query(
          'UPDATE app.requirement_participants SET active=false,updated_at=clock_timestamp() WHERE requirement_id=$1',
          [id],
        );
        for (const userId of [...input.userIds].sort())
          await tx.query(
            `INSERT INTO app.requirement_participants(requirement_id,project_id,user_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT(requirement_id,user_id) DO UPDATE SET active=true,updated_at=clock_timestamp()`,
            [id, projectId, userId, actor.userId],
          );
        await tx.query(
          "UPDATE app.requirements SET lifecycle=$2,archived_at=CASE WHEN $2='archived' THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,row_version=row_version+1 WHERE id=$1",
          [id, input.lifecycle],
        );
        await audit(
          tx,
          actor,
          'requirement.collaboration-updated',
          id,
          projectId,
          {
            userIds: input.userIds,
            lifecycle: input.lifecycle,
            previousLifecycle: row.lifecycle,
          },
        );
        return { completed: true, rowVersion: row.row_version + 1 };
      },
      projectId,
    );
  }
  async collaborationReceipt(
    actor: ActorContext,
    projectId: string,
    id: string,
    commandId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      await this.get(tx, projectId, id);
      const operation = 'requirements.collaboration.' + id;
      const row = (
        await tx.query<{ status: string; response: unknown }>(
          `SELECT status,response FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND operation=$4 AND key=$3`,
          [actor.userId, projectId, commandId, operation],
        )
      ).rows[0];
      if (!row) {
        await rejectMissingAcceptedReceipt(tx, actor, operation, commandId);
        await this.operations.assertReceiptNotClosed(tx, actor, {
          operation,
          commandId,
          targetId: id,
          projectId,
        });
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得此保存回执，保持原command查询，不自动重发。',
          404,
        );
      }
      return { commandId, status: row.status, response: row.response };
    });
  }

  closeCollaborationReceipt(
    actor: ActorContext,
    projectId: string,
    id: string,
    commandId: string,
  ) {
    return this.operations.closeUnrecordedReceipt(
      actor,
      {
        operation: 'requirements.collaboration.' + id,
        commandId,
        targetId: id,
        projectId,
      },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'project.read');
        await this.get(tx, projectId, id);
      },
    );
  }

  async archive(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementArchiveInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'requirements.archive',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'requirements.write');
      },
      async (tx) => {
        const row = await this.get(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        await tx.query(
          "UPDATE app.requirements SET lifecycle=CASE WHEN $2 THEN 'archived' ELSE 'inProgress' END,archived_at=CASE WHEN $2 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,row_version=row_version+1 WHERE id=$1",
          [id, input.archived],
        );
        await audit(tx, actor, 'requirement.archive-updated', id, projectId, {
          archived: input.archived,
        });
        return { completed: true, rowVersion: input.rowVersion + 1 };
      },
      projectId,
    );
  }

  private async get(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    lock = false,
  ): Promise<RequirementRow> {
    const row = (
      await tx.query<RequirementRow>(
        `SELECT r.*,r.archived_at IS NULL AND r.lifecycle='inProgress' AND (${requirementInactivityDeadlineSql})<=clock_timestamp() inactive FROM app.requirements r WHERE r.id=$1 AND r.project_id=$2${lock ? ' FOR UPDATE OF r' : ''}`,
        [id, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此范围内没有该需求。', 404);
    return row;
  }

  private async numberAvailable(
    tx: SqlExecutor,
    projectId: string,
    number: string | null,
  ): Promise<void> {
    if (number === null) return;
    // Serialize the optional project number; a hash collision only reduces concurrency.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
      projectId,
      number,
    ]);
    if (
      (
        await tx.query(
          'SELECT 1 FROM app.requirements WHERE project_id=$1 AND business_number=$2',
          [projectId, number],
        )
      ).rowCount
    ) {
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '此项目已使用该需求编号，请选择已有需求或修改、留空编号。',
        409,
      );
    }
  }

  private async insertVersion(
    tx: SqlExecutor,
    actor: ActorContext,
    requirement: RequirementRow,
    no: number,
    summary: string,
    inputs: RequirementMaterialInput[],
    policy: FilePolicySnapshot,
  ) {
    assertFilePolicyCounts(policy, inputs.length);
    await assertSubmissionFileBudget(
      tx,
      requirement.project_id,
      inputs.flatMap((material) =>
        material.fileResourceId ? [material.fileResourceId] : [],
      ),
      policy,
    );
    const digests: unknown[] = [];
    const materials = inputs
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((m) => ({ ...m, id: randomUUID() }));
    for (const material of materials) {
      if (material.sourceLink) {
        const url = new URL(material.sourceLink);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new DomainError(
            'VALIDATION_ERROR',
            '来源链接必须为无内嵌凭据的HTTP(S)地址。',
            400,
          );
        }
        digests.push({
          purpose: material.purpose,
          sourceLink: material.sourceLink,
          order: material.order,
        });
      } else {
        const file = (
          await tx.query<{ declared_sha256: string }>(
            `SELECT declared_sha256 FROM app.file_resources WHERE id=$1 AND owner_scope='project' AND project_id=$2
           AND status='verified' AND deleted_at IS NULL FOR SHARE`,
            [material.fileResourceId, requirement.project_id],
          )
        ).rows[0];
        if (!file)
          throw new DomainError(
            'FILE_NOT_READY',
            '需求材料必须是本项目已完成字节验证的文件。',
            422,
          );
        digests.push({
          purpose: material.purpose,
          sha256: file.declared_sha256,
          order: material.order,
        });
      }
    }
    const digest = createHash('sha256')
      .update(JSON.stringify(digests))
      .digest('hex');
    const version = (
      await tx.query<VersionRow>(
        `INSERT INTO app.requirement_versions(requirement_id,project_id,version_no,summary,material_set_digest,materials,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          requirement.id,
          requirement.project_id,
          no,
          summary,
          digest,
          JSON.stringify(materials),
          actor.userId,
        ],
      )
    ).rows[0];
    if (!version) throw new Error('Version insert returned no row');
    for (const material of materials)
      if (material.fileResourceId)
        await tx.query(
          `INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by)
       VALUES($1,$2,'requirementVersion',$3,$4) ON CONFLICT DO NOTHING`,
          [
            material.fileResourceId,
            requirement.project_id,
            version.id,
            actor.userId,
          ],
        );
    return versionDto(version);
  }
}
