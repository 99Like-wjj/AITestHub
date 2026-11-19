import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  lifecyclePreviewInputSchema,
  lifecycleCommitInputSchema,
  singleIssueLifecycleInputSchema,
  type issueResolutionSchema,
  mergeIssuesInputSchema,
  unmergeIssueInputSchema,
} from '../../../contracts/src/issues.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { semanticDigest } from '../ui-executions/service.js';
import { DomainError, stale } from '../errors.js';
import { assertSafeResultContent } from '../results/safety.js';
import { recordRequirementActivity } from '../requirements/service.js';
import {
  issueRow,
  issueDto,
  issueEvent,
  lockIssueProject,
  type IssueRow,
} from './common.js';

type Resolution = z.infer<typeof issueResolutionSchema>;
type LifecycleAction = 'close' | 'reopen';

async function lifecycleBasis(
  tx: SqlExecutor,
  row: IssueRow,
  action: LifecycleAction,
) {
  if (action === 'reopen')
    return {
      eligible: row.state === 'closed',
      reason: row.state === 'closed' ? '' : '当前未关闭',
      verificationId: null,
    };
  if (row.state === 'closed')
    return { eligible: false, reason: '已关闭', verificationId: null };
  if (row.state !== 'awaitingRetest')
    return {
      eligible: false,
      reason: '修复关闭前须明确提交复测',
      verificationId: null,
    };

  // An older automatic retest cannot qualify by delivering its verdict late.
  const latest = (
    await tx.query<{ id: string; outcome: string }>(
      `WITH submitted AS (
        SELECT created_at FROM app.issue_events
        WHERE issue_id=$2 AND action='ready-for-retest'
        ORDER BY created_at DESC,id DESC LIMIT 1
      )
      SELECT v.id,v.outcome FROM app.issue_verifications v
      CROSS JOIN submitted s LEFT JOIN app.runs r ON r.id=v.run_id AND r.project_id=v.project_id
      WHERE v.project_id=$1 AND v.issue_id=$2
        AND (CASE WHEN v.run_id IS NULL THEN v.created_at ELSE r.started_at END) >= s.created_at
      ORDER BY COALESCE(r.ended_at,v.created_at) DESC,v.created_at DESC,v.id DESC LIMIT 1`,
      [row.project_id, row.id],
    )
  ).rows[0];
  return {
    eligible: latest?.outcome === 'passed',
    reason:
      latest?.outcome === 'passed' ? '' : '本次提修后须有通过的最新复测结论',
    verificationId: latest?.id ?? null,
  };
}

export class IssueLifecycleService {
  private readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async single(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = singleIssueLifecycleInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.lifecycle',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const row = await issueRow(tx, projectId, id, true);
        if (row.row_version !== input.rowVersion) stale();
        const basis =
          input.resolution === 'fixed' || input.action === 'reopen'
            ? await lifecycleBasis(tx, row, input.action)
            : null;
        if (basis && !basis.eligible)
          throw new DomainError('PRECONDITIONS_MISSING', basis.reason, 422);
        return {
          issue: await this.change(
            tx,
            actor,
            row,
            input.action,
            input.note,
            input.resolution,
            basis?.verificationId ?? null,
          ),
        };
      },
      projectId,
    );
  }
  async preview(actor: ActorContext, projectId: string, raw: unknown) {
    const input = lifecyclePreviewInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.lifecycle-preview',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
      },
      async (tx) => {
        const items = [];
        for (const id of input.objectIds) {
          try {
            const row = await issueRow(tx, projectId, id);
            const basis = await lifecycleBasis(tx, row, input.action);
            items.push({
              id,
              title: row.title,
              number: issueDto(row).number,
              rowVersion: row.row_version,
              state: row.state,
              ...basis,
            });
          } catch (error: unknown) {
            if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND')
              throw error;
            items.push({
              id,
              title: '',
              number: '',
              rowVersion: 0,
              state: null,
              eligible: false,
              reason: '此范围内不存在',
              verificationId: null,
            });
          }
        }
        const previewId = randomUUID();
        const scopeDigest = semanticDigest({
          projectId,
          action: input.action,
          items,
        });
        await tx.query(
          'INSERT INTO app.issue_lifecycle_previews(id,project_id,actor_id,action,scope_digest,items) VALUES($1,$2,$3,$4,$5,$6)',
          [
            previewId,
            projectId,
            actor.userId,
            input.action,
            scopeDigest,
            JSON.stringify(items),
          ],
        );
        return {
          previewId,
          action: input.action,
          scopeDigest,
          items: items.map(
            ({ verificationId: _verificationId, ...item }) => item,
          ),
        };
      },
      projectId,
    );
  }
  async commit(actor: ActorContext, projectId: string, raw: unknown) {
    const input = lifecycleCommitInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.lifecycle-commit',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const preview = (
          await tx.query<{
            action: 'close' | 'reopen';
            scope_digest: string;
            items: {
              id: string;
              rowVersion: number;
              eligible: boolean;
              verificationId?: string | null;
            }[];
          }>(
            'SELECT action,scope_digest,items FROM app.issue_lifecycle_previews WHERE id=$1 AND project_id=$2 AND actor_id=$3',
            [input.previewId, projectId, actor.userId],
          )
        ).rows[0];
        if (
          !preview ||
          preview.scope_digest !== input.scopeDigest ||
          input.objectIds.some(
            (id) => !preview.items.some((item) => item.id === id),
          )
        ) {
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '确认集合与精确预览不一致，不会按新筛选扩大范围。',
            409,
          );
        }
        const results = [];
        for (const id of [...input.objectIds].sort()) {
          const expected = preview.items.find((item) => item.id === id);
          if (!expected?.eligible) {
            results.push({
              objectId: id,
              status: 'skipped',
              code: 'NOT_ELIGIBLE',
            });
            continue;
          }
          const row = await issueRow(tx, projectId, id, true);
          if (row.row_version !== expected.rowVersion) {
            results.push({
              objectId: id,
              status: 'conflict',
              code: 'STALE_BASE_REVISION',
            });
            continue;
          }
          const basis = await lifecycleBasis(tx, row, preview.action);
          if (
            !basis.eligible ||
            (preview.action === 'close' &&
              expected.verificationId !== basis.verificationId)
          ) {
            results.push({
              objectId: id,
              status: 'conflict',
              code: 'PRECONDITIONS_CHANGED',
            });
            continue;
          }
          const issue = await this.change(
            tx,
            actor,
            row,
            preview.action,
            '',
            'fixed',
            basis.verificationId,
          );
          results.push({ objectId: id, status: 'accepted', issue });
        }
        return {
          previewId: input.previewId,
          scopeDigest: input.scopeDigest,
          results,
        };
      },
      projectId,
    );
  }
  private async change(
    tx: SqlExecutor,
    actor: ActorContext,
    row: IssueRow,
    action: 'close' | 'reopen',
    note: string,
    resolution: Resolution,
    verificationId: string | null,
  ) {
    if (
      (action === 'close' && row.state === 'closed') ||
      (action === 'reopen' && row.state !== 'closed')
    )
      return issueDto(row);
    const state =
      action === 'close'
        ? 'closed'
        : row.assignee_id
          ? 'inProgress'
          : 'pending';
    await tx.query(
      'UPDATE app.issues SET state=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
      [row.project_id, row.id, state],
    );
    // This event is not a verification record. Closing/reopening never manufactures a retest.
    await issueEvent(
      tx,
      actor,
      row,
      action === 'close' ? 'closed' : 'reopened',
      row.assignee_id,
      row.assignee_id,
      {
        note,
        resolution: action === 'close' ? resolution : null,
        verificationId,
        previousState: row.state,
        newState: state,
      },
    );
    await recordRequirementActivity(tx, row.project_id, row.requirement_id);
    return issueDto(await issueRow(tx, row.project_id, row.id));
  }
  async merge(actor: ActorContext, projectId: string, raw: unknown) {
    const input = mergeIssuesInputSchema.parse(raw);
    if (
      input.sourceIds.includes(input.masterId) ||
      Object.keys(input.sourceRowVersions).length !== input.sourceIds.length ||
      input.sourceIds.some((id) => !(id in input.sourceRowVersions))
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        '主项不能合并自身；每个从项须有准确基准。',
        400,
      );
    }
    return this.operations.execute(
      actor,
      'issues.merge',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const records = new Map<string, IssueRow>();
        for (const id of [...input.sourceIds, input.masterId].sort())
          records.set(id, await issueRow(tx, projectId, id, true));
        const master = records.get(input.masterId);
        if (!master) throw new Error('Missing master');
        if (master.row_version !== input.masterRowVersion) stale();
        if (master.merged_into_id)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '请选择当前合并组的主项，不会静默改向。',
            409,
          );
        const merges = [];
        for (const id of input.sourceIds) {
          const source = records.get(id);
          if (!source) throw new Error('Missing source');
          if (source.row_version !== input.sourceRowVersions[id]) stale();
          if (source.merged_into_id)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '从项已有合并关系，须明确撤销后再调整。',
              409,
            );
          // Follow the current target chain under the project relation lock; never create a cycle.
          let cursor: string | null = master.id;
          const visited = new Set<string>();
          while (cursor) {
            if (cursor === source.id || visited.has(cursor))
              throw new DomainError(
                'BUSINESS_CONFLICT',
                '合并不能形成循环。',
                409,
              );
            visited.add(cursor);
            cursor = (await issueRow(tx, projectId, cursor)).merged_into_id;
          }
          const relation = (
            await tx.query<{ id: string }>(
              'INSERT INTO app.issue_merges(project_id,master_id,source_id,source_before,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
              [
                projectId,
                master.id,
                source.id,
                JSON.stringify(issueDto(source)),
                actor.userId,
              ],
            )
          ).rows[0];
          if (!relation) throw new Error('Merge insert failed');
          await tx.query(
            'UPDATE app.issues SET merged_into_id=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
            [projectId, source.id, master.id],
          );
          await issueEvent(
            tx,
            actor,
            source,
            'merged',
            source.assignee_id,
            source.assignee_id,
            { mergeId: relation.id, masterId: master.id },
          );
          merges.push({
            mergeId: relation.id,
            sourceId: source.id,
            masterId: master.id,
            rowVersion: 1,
          });
        }
        await tx.query(
          'UPDATE app.issues SET row_version=row_version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
          [projectId, master.id],
        );
        await issueEvent(
          tx,
          actor,
          master,
          'merge-sources-added',
          master.assignee_id,
          master.assignee_id,
          { sourceIds: input.sourceIds },
        );
        // Relationship only: all original states/owners and subsequent content remain independent.
        return {
          master: issueDto(await issueRow(tx, projectId, master.id)),
          merges,
        };
      },
      projectId,
    );
  }
  async unmerge(actor: ActorContext, projectId: string, raw: unknown) {
    const input = unmergeIssueInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'issues.unmerge',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'issues.lifecycle');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const relation = (
          await tx.query<{
            id: string;
            master_id: string;
            source_id: string;
            row_version: number;
            undone_at: Date | null;
          }>(
            'SELECT * FROM app.issue_merges WHERE project_id=$1 AND id=$2 FOR UPDATE',
            [projectId, input.mergeId],
          )
        ).rows[0];
        if (!relation)
          throw new DomainError('NOT_FOUND', '没有此合并关系。', 404);
        if (relation.row_version !== input.rowVersion) stale();
        if (relation.undone_at)
          throw new DomainError('BUSINESS_CONFLICT', '此关系已撤销。', 409);
        const source = await issueRow(tx, projectId, relation.source_id, true);
        if (source.merged_into_id !== relation.master_id)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '当前合并关系已变化。',
            409,
          );
        await tx.query(
          'UPDATE app.issues SET merged_into_id=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [source.id],
        );
        await tx.query(
          'UPDATE app.issue_merges SET undone_at=clock_timestamp(),undone_by=$2,row_version=row_version+1 WHERE id=$1',
          [relation.id, actor.userId],
        );
        await issueEvent(
          tx,
          actor,
          source,
          'unmerged',
          source.assignee_id,
          source.assignee_id,
          { mergeId: relation.id, masterId: relation.master_id },
        );
        // Never restore an old copy over the master's newer notes, sources or verification history.
        return {
          mergeId: relation.id,
          source: issueDto(await issueRow(tx, projectId, source.id)),
          rowVersion: input.rowVersion + 1,
        };
      },
      projectId,
    );
  }
}
