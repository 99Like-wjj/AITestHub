import { randomUUID } from 'node:crypto';
import {
  createIssueInputSchema,
  issueHandlingInputSchema,
  issueEditInputSchema,
  issueSeverityInputSchema,
  issueListQuerySchema,
  manualVerificationInputSchema,
  issueDetailSchema,
  manualVerificationScopeSchema,
  fileReportIssueInputSchema,
  fileReportIssueReceiptSchema,
  type Issue,
} from '../../../contracts/src/issues.js';
import { reportScopeItemSchema } from '../../../contracts/src/ui-archives.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { audit } from '../events.js';
import { issueListFilter } from './list-filter.js';
import { readIssueCounts } from './counts.js';
import { OperationService } from '../operations/service.js';
import { forbidden, DomainError, stale } from '../errors.js';
import { assertSafeResultContent } from '../results/safety.js';
import { recordRequirementActivity } from '../requirements/service.js';
import {
  issueConfirmationEvidence,
  lockReportResult,
  readResultRetestFact,
} from './review-evidence.js';
import {
  issueDto,
  issueRow,
  issueSelect,
  issueEvent,
  requireRequirement,
  requireAssignee,
  lockIssueProject,
  linkResults,
  evidenceDtos,
  type IssueRow,
} from './common.js';

export async function createIssueInTransaction(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  input: {
    requirementId: string;
    requirementVersionId: string | null;
    title: string;
    description: string;
    severity: 'severe' | 'normal' | 'minor';
    assigneeId: string | null;
    source: 'manualTester' | 'manualProduct' | 'confirmedProblem';
    resultIds: string[];
  },
): Promise<Issue> {
  await requireRequirement(
    tx,
    projectId,
    input.requirementId,
    input.requirementVersionId,
  );
  await requireAssignee(tx, projectId, input.assigneeId);
  const sequence = (
    await tx.query<{ number: string }>(
      `INSERT INTO app.issue_sequences(project_id,next_number) VALUES($1,2) ON CONFLICT(project_id)
     DO UPDATE SET next_number=app.issue_sequences.next_number+1 RETURNING (next_number-1)::text number`,
      [projectId],
    )
  ).rows[0];
  if (!sequence) throw new Error('Issue sequence unavailable');
  const id = randomUUID();
  await tx.query(
    `INSERT INTO app.issues(id,project_id,number,requirement_id,requirement_version_id,title,description,severity,assignee_id,source,submitted_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      projectId,
      sequence.number,
      input.requirementId,
      input.requirementVersionId,
      input.title,
      input.description,
      input.severity,
      input.assigneeId,
      input.source,
      actor.userId,
    ],
  );
  await linkResults(tx, projectId, id, input.resultIds);
  const created = await issueRow(tx, projectId, id);
  await issueEvent(tx, actor, created, 'created', null, input.assigneeId, {
    source: input.source,
  });
  await recordRequirementActivity(tx, projectId, input.requirementId);
  return issueDto(created);
}

export class IssueService {
  private readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async create(actor: ActorContext, projectId: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = createIssueInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.create',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.create');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const member = await requireProject(
          tx,
          actor,
          projectId,
          'issues.create',
        );
        if (!member.roles.includes(input.manualOrigin)) forbidden();
        if (input.assigneeId && !member.roles.includes('tester')) forbidden();
        return {
          issue: await createIssueInTransaction(tx, actor, projectId, {
            ...input,
            source:
              input.manualOrigin === 'product'
                ? 'manualProduct'
                : 'manualTester',
          }),
        };
      },
      projectId,
    );
  }
  async fileFromReport(actor: ActorContext, projectId: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = fileReportIssueInputSchema.parse(raw);
    const scope = input.reportReview;
    return this.operations.execute(
      actor,
      'issues.file-from-report',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const source = await lockReportResult(tx, projectId, scope);
        const retest = input.retestId
          ? await readResultRetestFact(tx, projectId, scope, input.retestId)
          : undefined;
        if (input.retestId && !retest)
          throw new DomainError(
            'NOT_FOUND',
            '复测记录不属于此报告结果修订。',
            404,
          );
        if (retest && retest.reportReview.stepOrdinal !== scope.stepOrdinal)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '所选人工复测与缺陷来源的步骤不一致。',
            409,
          );
        const observedFailure =
          source.content.originalOutcome === 'failed' &&
          Boolean(
            source.content.actualObservations.trim() ||
            source.content.stepObservations?.length ||
            source.content.observations?.length,
          );
        if (retest?.outcome !== 'reproduced' && !observedFailure)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '请登记可复现的人工观察后再提缺陷。',
            422,
          );
        const prior = (
          await tx.query<{ issue_id: string }>(
            `SELECT l.issue_id FROM app.issue_result_links l JOIN app.issues i ON i.id=l.issue_id
             WHERE l.project_id=$1 AND l.result_id=$2 AND l.source_revision_id=$3
               AND i.merged_into_id IS NULL ORDER BY i.number LIMIT 1`,
            [projectId, scope.resultId, scope.resultRevisionId],
          )
        ).rows[0];
        if (
          prior &&
          input.target === 'existing' &&
          prior.issue_id !== input.issueId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '当前结果修订已有正式缺陷，请核对后继续处理。',
            409,
          );
        if (prior)
          return fileReportIssueReceiptSchema.parse({
            issue: issueDto(await issueRow(tx, projectId, prior.issue_id)),
            alreadyLinked: true,
            source: scope,
          });

        const item = reportScopeItemSchema.parse(source.snapshot);
        let issue;
        if (input.target === 'new') {
          const requirementVersionId =
            item.requirementVersionId ?? input.requirementVersionId ?? null;
          const version = requirementVersionId
            ? (
                await tx.query<{ requirement_id: string }>(
                  'SELECT requirement_id FROM app.requirement_versions WHERE project_id=$1 AND id=$2',
                  [projectId, requirementVersionId],
                )
              ).rows[0]
            : undefined;
          const requirementId =
            ('requirementId' in item ? item.requirementId : null) ??
            version?.requirement_id ??
            input.requirementId;
          if (!requirementId)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '此执行项需要明确的缺陷归属需求。',
              422,
            );
          issue = await createIssueInTransaction(tx, actor, projectId, {
            title: input.title,
            description: input.description,
            severity: input.severity,
            assigneeId: input.assigneeId,
            requirementId,
            requirementVersionId,
            source: 'manualTester',
            resultIds: [],
          });
        } else {
          const existing = await issueRow(tx, projectId, input.issueId, true);
          if (existing.row_version !== input.issueRowVersion) stale();
          if (existing.merged_into_id)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '该缺陷已合并，请选择保留的正式缺陷。',
              409,
            );
          issue = issueDto(existing);
          await tx.query(
            'UPDATE app.issues SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
            [issue.id],
          );
        }
        await tx.query(
          `INSERT INTO app.issue_result_links(project_id,issue_id,result_id,source_revision_id)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [projectId, issue.id, scope.resultId, scope.resultRevisionId],
        );
        const candidate = (
          await tx.query<{ id: string }>(
            `UPDATE app.problem_candidates SET state='confirmed',decision_note='',row_version=row_version+1,updated_at=clock_timestamp()
             WHERE project_id=$1 AND source_result_id=$2 AND source_result_revision_id=$3 AND state='pendingConfirmation'
             RETURNING id`,
            [projectId, scope.resultId, scope.resultRevisionId],
          )
        ).rows[0];
        if (candidate) {
          await tx.query(
            'INSERT INTO app.issue_problem_links(project_id,issue_id,problem_id) VALUES($1,$2,$3)',
            [projectId, issue.id, candidate.id],
          );
          await audit(tx, actor, 'problem.confirmed', candidate.id, projectId, {
            issueId: issue.id,
            sourceResultId: scope.resultId,
            previousState: 'pendingConfirmation',
            reportReview: scope,
          });
        }
        const current = await issueRow(tx, projectId, issue.id);
        if (input.target === 'existing')
          await recordRequirementActivity(
            tx,
            projectId,
            current.requirement_id,
          );
        await issueEvent(
          tx,
          actor,
          current,
          'report-source-linked',
          current.assignee_id,
          current.assignee_id,
          {
            reportReview: scope,
            ...(retest ? { retestId: retest.id } : {}),
          },
        );
        return fileReportIssueReceiptSchema.parse({
          issue: issueDto(current),
          alreadyLinked: false,
          source: scope,
        });
      },
      projectId,
    );
  }
  async reportAssignees(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'reviews.approve');
      const result = await tx.query<{
        id: string;
        display_name: string;
        developer: boolean;
      }>(
        `SELECT u.id,u.display_name,'developer'=ANY(m.roles) AS developer
         FROM app.project_members m JOIN app.users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.active AND u.active
         ORDER BY developer DESC,u.display_name,u.id`,
        [projectId],
      );
      return {
        users: result.rows.map((user) => ({
          id: user.id,
          displayName: user.display_name,
          developer: user.developer,
        })),
      };
    });
  }
  async list(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = issueListQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const filter = issueListFilter(projectId, actor.userId, input);
      const rows = await tx.query<IssueRow>(
        `${issueSelect} WHERE ${filter.where} ORDER BY i.updated_at DESC,i.id LIMIT 200`,
        filter.values,
      );
      return { issues: rows.rows.map(issueDto) };
    });
  }
  counts(actor: ActorContext, projectId: string, raw: unknown = {}) {
    return readIssueCounts(this.db, actor, projectId, raw);
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await issueRow(tx, projectId, id);
      const events = await tx.query<{
        id: string;
        action: string;
        actor_id: string;
        previous_owner_id: string | null;
        new_owner_id: string | null;
        payload: unknown;
        created_at: Date;
      }>(
        'SELECT * FROM app.issue_events WHERE issue_id=$1 ORDER BY created_at,id',
        [id],
      );
      const verifications = await tx.query<{
        id: string;
        method: string;
        outcome: string;
        run_id: string | null;
        note: string;
        attachment_file_ids: string[];
        actor_id: string;
        created_at: Date;
        execution_provenance: string | null;
      }>(
        'SELECT v.*,r.execution_provenance FROM app.issue_verifications v LEFT JOIN app.runs r ON r.id=v.run_id WHERE v.issue_id=$1 ORDER BY v.created_at DESC,v.id',
        [id],
      );
      const sources = await tx.query<{
        result_id: string;
        source_revision_id: string;
      }>(
        'SELECT result_id,source_revision_id FROM app.issue_result_links WHERE issue_id=$1',
        [id],
      );
      const children = await tx.query<IssueRow>(
        `${issueSelect} WHERE i.project_id=$1 AND i.merged_into_id=$2 ORDER BY i.number`,
        [projectId, id],
      );
      const problems = await tx.query<{ problem_id: string }>(
        'SELECT problem_id FROM app.issue_problem_links WHERE project_id=$1 AND issue_id=$2',
        [projectId, id],
      );
      const evidence = await tx.query<{ evidence_id: string }>(
        `SELECT DISTINCT e.evidence_id FROM app.problem_evidence_links e JOIN app.issue_problem_links l ON l.problem_id=e.problem_id WHERE l.project_id=$1 AND l.issue_id=$2
        UNION SELECT e.evidence_id FROM app.result_evidence_links e JOIN app.issue_result_links l ON l.result_id=e.result_id WHERE l.project_id=$1 AND l.issue_id=$2`,
        [projectId, id],
      );
      const merges = await tx.query<{
        id: string;
        master_id: string;
        source_id: string;
        row_version: number;
        actor_id: string;
        created_at: Date;
        undone_at: Date | null;
      }>(
        'SELECT * FROM app.issue_merges WHERE project_id=$1 AND (master_id=$2 OR source_id=$2) ORDER BY created_at,id',
        [projectId, id],
      );
      return issueDetailSchema.parse({
        issue: issueDto(row),
        events: events.rows.map((event) => ({
          id: event.id,
          action: event.action,
          actorId: event.actor_id,
          previousOwnerId: event.previous_owner_id,
          newOwnerId: event.new_owner_id,
          payload: event.payload,
          createdAt: event.created_at.toISOString(),
        })),
        verifications: verifications.rows.map((verification) => ({
          id: verification.id,
          method: verification.method,
          outcome: verification.outcome,
          runId: verification.run_id,
          note: verification.note,
          attachmentFileIds: verification.attachment_file_ids,
          actorId: verification.actor_id,
          createdAt: verification.created_at.toISOString(),
          executionProvenance: verification.execution_provenance,
          scopeSnapshot:
            verification.method === 'manual'
              ? (() => {
                  const recorded = events.rows.find(
                    (event) =>
                      event.action === 'manual-verification' &&
                      typeof event.payload === 'object' &&
                      event.payload !== null &&
                      'verificationId' in event.payload &&
                      event.payload.verificationId === verification.id,
                  );
                  const payload = recorded?.payload;
                  const parsed = manualVerificationScopeSchema.safeParse(
                    payload &&
                      typeof payload === 'object' &&
                      'scopeSnapshot' in payload
                      ? payload.scopeSnapshot
                      : null,
                  );
                  return parsed.success ? parsed.data : null;
                })()
              : null,
        })),
        resultLinks: sources.rows.map((source) => ({
          resultId: source.result_id,
          revisionId: source.source_revision_id,
        })),
        problemLinks: problems.rows.map((problem) => ({
          problemId: problem.problem_id,
        })),
        evidence: await evidenceDtos(
          tx,
          projectId,
          evidence.rows.map((item) => item.evidence_id),
        ),
        ...(actor.entrypoint === 'web'
          ? {
              reviewEvidence: await issueConfirmationEvidence(
                tx,
                projectId,
                events.rows,
              ),
            }
          : {}),
        mergedChildren: children.rows.map(issueDto),
        merges: merges.rows.map((merge) => ({
          id: merge.id,
          masterId: merge.master_id,
          sourceId: merge.source_id,
          rowVersion: merge.row_version,
          actorId: merge.actor_id,
          createdAt: merge.created_at.toISOString(),
          undoneAt: merge.undone_at?.toISOString() ?? null,
        })),
      });
    });
  }
  async handle(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = issueHandlingInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.handle',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.handle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const member = await requireProject(
          tx,
          actor,
          projectId,
          'issues.handle',
        );
        const row = await issueRow(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (row.state === 'closed')
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已关闭历史不进入处理流程；重开由测试明确执行。',
            409,
          );
        const tester = member.roles.includes('tester');
        let owner = row.assignee_id;
        let state = row.state;
        if (input.action === 'claim') {
          if (owner !== null)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '此缺陷已有负责人。',
              409,
            );
          owner = actor.userId;
          state = 'inProgress';
        } else if (input.action === 'assign') {
          if (!tester) forbidden();
          if (input.assigneeId === undefined)
            throw new DomainError(
              'VALIDATION_ERROR',
              '组织指派须明确负责人或待认领。',
              400,
            );
          owner = input.assigneeId;
          state = 'pending';
        } else if (input.action === 'takeover') {
          if (!owner || owner === actor.userId)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '接替针对他人负责的正式缺陷。',
              409,
            );
          owner = actor.userId;
          state = 'inProgress';
        } else {
          if (!tester && owner !== actor.userId) forbidden();
          if (input.action === 'transfer') {
            if (!input.assigneeId)
              throw new DomainError(
                'VALIDATION_ERROR',
                '转交须选择本项目有效接收人。',
                400,
              );
            owner = input.assigneeId;
            state = 'pending';
          } else if (input.action === 'return') {
            owner = null;
            state = 'pending';
          } else if (input.action === 'start-processing') {
            if (!owner)
              throw new DomainError(
                'PRECONDITIONS_MISSING',
                '开始处理前需明确负责人。',
                422,
              );
            state = 'inProgress';
          } else if (input.action === 'ready-for-retest') {
            if (!owner)
              throw new DomainError(
                'PRECONDITIONS_MISSING',
                '提交处理前需明确负责人。',
                422,
              );
            state = 'awaitingRetest';
          }
        }
        await requireAssignee(tx, projectId, owner);
        await tx.query(
          'UPDATE app.issues SET assignee_id=$3,state=$4,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [projectId, id, owner, state],
        );
        await issueEvent(tx, actor, row, input.action, row.assignee_id, owner, {
          note: input.note,
          previousState: row.state,
          newState: state,
        });
        await recordRequirementActivity(tx, projectId, row.requirement_id);
        return { issue: issueDto(await issueRow(tx, projectId, id)) };
      },
      projectId,
    );
  }
  async edit(actor: ActorContext, projectId: string, id: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = issueEditInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.edit',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.create');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const member = await requireProject(
          tx,
          actor,
          projectId,
          'issues.create',
        );
        const row = await issueRow(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (
          !member.roles.includes('tester') &&
          !(
            row.source === 'manualProduct' &&
            row.submitted_by === actor.userId &&
            member.roles.includes('product')
          )
        )
          forbidden();
        await tx.query(
          'UPDATE app.issues SET title=$3,description=$4,severity=$5,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [projectId, id, input.title, input.description, input.severity],
        );
        await issueEvent(
          tx,
          actor,
          row,
          'details-edited',
          row.assignee_id,
          row.assignee_id,
          {
            before: {
              title: row.title,
              description: row.description,
              severity: row.severity,
            },
            after: {
              title: input.title,
              description: input.description,
              severity: input.severity,
            },
          },
        );
        await recordRequirementActivity(tx, projectId, row.requirement_id);
        return { issue: issueDto(await issueRow(tx, projectId, id)) };
      },
      projectId,
    );
  }
  async severity(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = issueSeverityInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.severity',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.handle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const member = await requireProject(
          tx,
          actor,
          projectId,
          'issues.handle',
        );
        const row = await issueRow(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (
          !member.roles.includes('tester') &&
          row.assignee_id !== actor.userId
        )
          forbidden();
        await tx.query(
          'UPDATE app.issues SET severity=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [projectId, id, input.severity],
        );
        await issueEvent(
          tx,
          actor,
          row,
          'severity-changed',
          row.assignee_id,
          row.assignee_id,
          { before: row.severity, after: input.severity },
        );
        await recordRequirementActivity(tx, projectId, row.requirement_id);
        return { issue: issueDto(await issueRow(tx, projectId, id)) };
      },
      projectId,
    );
  }
  async manualVerification(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = manualVerificationInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.manual-verification',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const row = await issueRow(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        if (row.state === 'closed' && input.returnToInProgress)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已关闭记录须明确重开；人工复测记录不会暗中重开。',
            409,
          );
        const verificationId = randomUUID();
        const version = row.requirement_version_id
          ? (
              await tx.query<{ version_no: number }>(
                'SELECT version_no FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2 AND id=$3',
                [projectId, row.requirement_id, row.requirement_version_id],
              )
            ).rows[0]
          : null;
        const scopeSnapshot = manualVerificationScopeSchema.parse({
          issueId: row.id,
          issueRowVersion: row.row_version,
          requirementId: row.requirement_id,
          requirementVersionId: row.requirement_version_id,
          requirementVersionNo: version?.version_no ?? null,
          scopeDescription:
            input.scopeDescription ||
            '沿用记录时缺陷的关联需求版本；未额外声明用例范围。',
        });
        for (const fileId of input.attachmentFileIds) {
          if (
            !(
              await tx.query(
                "SELECT 1 FROM app.file_resources WHERE project_id=$1 AND id=$2 AND owner_scope='project' AND status='verified' AND deleted_at IS NULL FOR SHARE",
                [projectId, fileId],
              )
            ).rowCount
          ) {
            throw new DomainError(
              'FILE_NOT_READY',
              '人工复测附件须是本项目已验证文件。',
              422,
            );
          }
          await tx.query(
            "INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by) VALUES($1,$2,'evidence',$3,$4) ON CONFLICT DO NOTHING",
            [fileId, projectId, verificationId, actor.userId],
          );
        }
        await tx.query(
          "INSERT INTO app.issue_verifications(id,project_id,issue_id,method,outcome,note,attachment_file_ids,actor_id) VALUES($1,$2,$3,'manual',$4,$5,$6,$7)",
          [
            verificationId,
            projectId,
            id,
            input.outcome,
            input.note,
            input.attachmentFileIds,
            actor.userId,
          ],
        );
        const state =
          input.outcome === 'failed' &&
          input.returnToInProgress &&
          row.state !== 'closed'
            ? row.assignee_id
              ? 'inProgress'
              : 'pending'
            : row.state;
        await tx.query(
          'UPDATE app.issues SET state=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [projectId, id, state],
        );
        await issueEvent(
          tx,
          actor,
          row,
          'manual-verification',
          row.assignee_id,
          row.assignee_id,
          { verificationId, outcome: input.outcome, state, scopeSnapshot },
        );
        await recordRequirementActivity(tx, projectId, row.requirement_id);
        return {
          verificationId,
          issue: issueDto(await issueRow(tx, projectId, id)),
        };
      },
      projectId,
    );
  }
}
