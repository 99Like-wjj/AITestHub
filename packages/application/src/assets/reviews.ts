import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  approvalSnapshotSchema,
  precisePreviewSchema,
} from '../../../contracts/src/domain.js';
import {
  addOpinionInputSchema,
  approvalContentSnapshotSchema,
  approvalPreviewInputSchema,
  approveCommitInputSchema,
  optimizationNotesInputSchema,
  removeOpinionInputSchema,
} from '../../../contracts/src/assets.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  assetDto,
  currentOpinions,
  getAsset,
  invalidateDescendants,
  lockSet,
  reviewContext,
  type AssetRow,
  type OpinionRow,
} from './repository.js';

import { uiMeetingGate } from './ui-review.js';

interface ApprovalRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: 'UI' | 'API';
  set_id: string;
  case_id: string;
  case_revision_id: string;
  scenario_id: string;
  scenario_revision_id: string;
  set_revision_id: string;
  opinion_context_digest: string;
  approved_by: string;
  approved_at: Date;
  snapshot: unknown;
}
const storedPreviewItemSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  kind: z.enum(['UI', 'API']),
  requirementVersionId: z.uuid(),
  rowVersion: z.number().int(),
  revisionId: z.uuid(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  contextDigest: z.string(),
});
function approvalDto(row: ApprovalRow) {
  return approvalSnapshotSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    caseId: row.case_id,
    caseRevisionId: row.case_revision_id,
    scenarioRevisionId: row.scenario_revision_id,
    setRevisionId: row.set_revision_id,
    opinionContextDigest: row.opinion_context_digest,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at.toISOString(),
  });
}

export class ReviewService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async opinions(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId?: string,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const asset = await getAsset(transaction, projectId, id, true);
      const revision = revisionId ?? asset.current_revision_id;
      if (
        !(
          await transaction.query(
            'SELECT 1 FROM app.asset_revisions WHERE id=$1 AND asset_id=$2',
            [revision, id],
          )
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '没有该目标修订。', 404);
      const opinions = await transaction.query<OpinionRow>(
        'SELECT * FROM app.review_opinions WHERE asset_id=$1 AND revision_id=$2 ORDER BY created_at,id',
        [id, revision],
      );
      const notes = await transaction.query<{
        id: string;
        opinion_id: string;
        source_opinion_revision_id: string;
        target_revision_id: string;
        note: string;
        created_by: string;
        created_at: Date;
      }>(
        `SELECT n.*,COALESCE(n.source_opinion_revision_id,o.revision_id) source_opinion_revision_id,
          COALESCE(n.target_revision_id,o.revision_id) target_revision_id
        FROM app.optimization_notes n JOIN app.review_opinions o ON o.id=n.opinion_id
        WHERE n.asset_id=$1 AND (o.revision_id=$2 OR COALESCE(n.target_revision_id,o.revision_id)=$2)
        ORDER BY n.created_at,n.id`,
        [id, revision],
      );
      return {
        assetId: id,
        revisionId: revision,
        reviewState: asset.review_state,
        currentRevisionId: asset.current_revision_id,
        isCurrentRevision: revision === asset.current_revision_id,
        opinions: opinions.rows.map((row) => ({
          id: row.id,
          body: row.body,
          createdBy: row.created_by,
          createdAt: row.created_at.toISOString(),
          removedAt: row.removed_at?.toISOString() ?? null,
          rowVersion: row.row_version,
        })),
        optimizationNotes: notes.rows.map((row) => ({
          id: row.id,
          opinionId: row.opinion_id,
          sourceOpinionRevisionId: row.source_opinion_revision_id,
          targetRevisionId: row.target_revision_id,
          note: row.note,
          createdBy: row.created_by,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }
  async addOpinion(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = addOpinionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.add-opinion',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => {
        const initial = await getAsset(transaction, projectId, id);
        await lockSet(transaction, projectId, initial.set_id);
        const asset = await getAsset(transaction, projectId, id);
        if (
          !(
            await transaction.query(
              'SELECT 1 FROM app.asset_revisions WHERE asset_id=$1 AND id=$2',
              [id, input.targetRevisionId],
            )
          ).rowCount
        )
          throw new DomainError('NOT_FOUND', '此目标没有该修订。', 404);
        const opinion = (
          await transaction.query<{ id: string }>(
            `INSERT INTO app.review_opinions(project_id,kind,set_id,asset_id,revision_id,body,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              projectId,
              asset.kind,
              asset.set_id,
              id,
              input.targetRevisionId,
              input.body,
              actor.userId,
            ],
          )
        ).rows[0];
        if (!opinion) throw new Error('Opinion insert returned no row');
        if (asset.current_revision_id === input.targetRevisionId) {
          await transaction.query(
            "UPDATE app.test_assets SET review_state='needsOptimization',row_version=row_version+1 WHERE id=$1",
            [id],
          );
          await invalidateDescendants(transaction, asset);
        }
        await recordBusinessActivity(
          transaction,
          projectId,
          asset.requirement_version_id,
        );
        await audit(
          transaction,
          actor,
          'reviews.opinion-added',
          id,
          projectId,
          { opinionId: opinion.id, revisionId: input.targetRevisionId },
        );
        return {
          opinionId: opinion.id,
          asset: assetDto(await getAsset(transaction, projectId, id)),
        };
      },
      projectId,
    );
  }
  async removeOpinion(
    actor: ActorContext,
    projectId: string,
    id: string,
    opinionId: string,
    raw: unknown,
  ) {
    const input = removeOpinionInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.remove-opinion',
      input.commandId,
      { id, opinionId, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'reviews.approve');
      },
      async (transaction) => {
        const initial = await getAsset(transaction, projectId, id);
        await lockSet(transaction, projectId, initial.set_id);
        const asset = await getAsset(transaction, projectId, id);
        const opinion = (
          await transaction.query<OpinionRow>(
            'SELECT * FROM app.review_opinions WHERE id=$1 AND asset_id=$2 FOR UPDATE',
            [opinionId, id],
          )
        ).rows[0];
        if (!opinion)
          throw new DomainError('NOT_FOUND', '此目标没有该意见。', 404);
        if (opinion.row_version !== input.rowVersion || opinion.removed_at)
          stale();
        await transaction.query(
          'UPDATE app.review_opinions SET removed_at=clock_timestamp(),removed_by=$2,row_version=row_version+1 WHERE id=$1',
          [opinionId, actor.userId],
        );
        if (opinion.revision_id === asset.current_revision_id) {
          const remaining = await currentOpinions(transaction, asset);
          await transaction.query(
            'UPDATE app.test_assets SET review_state=$2,row_version=row_version+1 WHERE id=$1',
            [id, remaining.length ? 'needsOptimization' : 'pending'],
          );
          await invalidateDescendants(transaction, asset);
        }
        await recordBusinessActivity(
          transaction,
          projectId,
          asset.requirement_version_id,
        );
        await audit(
          transaction,
          actor,
          'reviews.opinion-removed',
          id,
          projectId,
          { opinionId },
        );
        return { asset: assetDto(await getAsset(transaction, projectId, id)) };
      },
      projectId,
    );
  }
  async optimizationNotes(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = optimizationNotesInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.optimization-notes',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => {
        const initial = await getAsset(transaction, projectId, id);
        await lockSet(transaction, projectId, initial.set_id);
        const asset = await getAsset(transaction, projectId, id);
        if (
          input.rowVersion !== undefined &&
          input.rowVersion !== asset.row_version
        )
          stale();
        const target = (
          await transaction.query<{ revision_no: number }>(
            'SELECT revision_no FROM app.asset_revisions WHERE asset_id=$1 AND id=$2',
            [id, input.targetRevisionId],
          )
        ).rows[0];
        if (!target)
          throw new DomainError('NOT_FOUND', '此目标没有该处理说明修订。', 404);
        for (const note of input.notes) {
          const sourceRevisionId =
            note.sourceOpinionRevisionId ?? input.targetRevisionId;
          const opinion = (
            await transaction.query<{ revision_no: number }>(
              `SELECT r.revision_no FROM app.review_opinions o JOIN app.asset_revisions r ON r.id=o.revision_id
             WHERE o.id=$1 AND o.asset_id=$2 AND o.revision_id=$3 AND o.removed_at IS NULL`,
              [note.opinionId, id, sourceRevisionId],
            )
          ).rows[0];
          if (!opinion)
            throw new DomainError(
              'NOT_FOUND',
              '处理说明必须绑定此目标明确来源修订的有效意见。',
              404,
            );
          if (sourceRevisionId !== input.targetRevisionId) {
            if (input.rowVersion === undefined)
              throw new DomainError(
                'VALIDATION_ERROR',
                '跨修订处理说明必须携带当前rowVersion。',
                400,
              );
            if (opinion.revision_no >= target.revision_no)
              throw new DomainError(
                'VALIDATION_ERROR',
                '来源意见修订必须早于优化目标修订。',
                400,
              );
            if (asset.current_revision_id !== input.targetRevisionId) stale();
          }
          await transaction.query(
            'INSERT INTO app.optimization_notes(project_id,kind,set_id,asset_id,opinion_id,note,created_by,source_opinion_revision_id,target_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              projectId,
              asset.kind,
              asset.set_id,
              id,
              note.opinionId,
              note.note,
              actor.userId,
              sourceRevisionId,
              input.targetRevisionId,
            ],
          );
        }
        if (asset.current_revision_id === input.targetRevisionId) {
          await transaction.query(
            "UPDATE app.test_assets SET review_state='aiOptimized',row_version=row_version+1 WHERE id=$1",
            [id],
          );
          await invalidateDescendants(transaction, asset);
        }
        await recordBusinessActivity(
          transaction,
          projectId,
          asset.requirement_version_id,
        );
        await audit(
          transaction,
          actor,
          'reviews.optimization-noted',
          id,
          projectId,
          {
            revisionId: input.targetRevisionId,
            sourceOpinionRevisionIds: [
              ...new Set(
                input.notes.map(
                  (note) =>
                    note.sourceOpinionRevisionId ?? input.targetRevisionId,
                ),
              ),
            ],
            count: input.notes.length,
          },
        );
        return {
          asset: assetDto(await getAsset(transaction, projectId, id)),
          approvalCreated: false,
        };
      },
      projectId,
    );
  }
  async preview(actor: ActorContext, projectId: string, raw: unknown) {
    const input = approvalPreviewInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.preview',
      input.commandId,
      input,
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'reviews.approve');
      },
      async (transaction) => {
        if (input.kind === 'API')
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '接口用例通过完整调试后保存为可回归。',
            422,
          );
        const items = [];
        for (const id of input.objectIds) {
          const asset = await getAsset(transaction, projectId, id);
          if (asset.kind !== input.kind)
            throw new DomainError('NOT_FOUND', '此类型范围内没有该目标。', 404);
          const context = await this.currentReviewContext(transaction, asset);
          items.push({
            id,
            title: assetDto(asset).title,
            kind: asset.kind,
            requirementVersionId: asset.requirement_version_id,
            rowVersion: asset.row_version,
            revisionId: asset.current_revision_id,
            eligible: context.reasons.length === 0,
            reasons: context.reasons,
            contextDigest: context.digest,
          });
        }
        const previewId = randomUUID();
        const scopeDigest = createHash('sha256')
          .update(canonicalJson(items))
          .digest('hex');
        const createdAt = new Date().toISOString();
        await transaction.query(
          'INSERT INTO app.approval_previews(id,actor_id,project_id,kind,scope_digest,items,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            previewId,
            actor.userId,
            projectId,
            input.kind,
            scopeDigest,
            JSON.stringify(items),
            createdAt,
          ],
        );
        return precisePreviewSchema.parse({
          previewId,
          scopeDigest,
          createdAt,
          items: items.map(
            ({ contextDigest: _contextDigest, ...item }) => item,
          ),
        });
      },
      projectId,
    );
  }
  async commit(actor: ActorContext, projectId: string, raw: unknown) {
    const input = approveCommitInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.approve',
      input.commandId,
      input,
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'reviews.approve');
      },
      async (transaction) => {
        const preview = (
          await transaction.query<{ items: unknown; scope_digest: string }>(
            'SELECT items,scope_digest FROM app.approval_previews WHERE id=$1 AND actor_id=$2 AND project_id=$3',
            [input.previewId, actor.userId, projectId],
          )
        ).rows[0];
        if (!preview)
          throw new DomainError('NOT_FOUND', '当前账号没有该评审预览。', 404);
        const items = storedPreviewItemSchema.array().parse(preview.items);
        if (
          preview.scope_digest !== input.scopeDigest ||
          canonicalJson([...input.objectIds].sort()) !==
            canonicalJson(items.map((item) => item.id).sort())
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '确认对象与预览不一致，请重新预览精确范围。',
            409,
          );
        const setIds = new Set<string>();
        for (const item of items)
          setIds.add((await getAsset(transaction, projectId, item.id)).set_id);
        for (const id of [...setIds].sort())
          await lockSet(transaction, projectId, id);
        const validated = [];
        for (const item of items) {
          const asset = await getAsset(transaction, projectId, item.id);
          if (asset.kind === 'API')
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '接口用例通过完整调试后保存为可回归。',
              422,
            );
          const context = await this.currentReviewContext(transaction, asset);
          validated.push({
            item,
            asset,
            context,
            stale:
              asset.row_version !== item.rowVersion ||
              asset.current_revision_id !== item.revisionId ||
              context.digest !== item.contextDigest,
          });
        }
        const results = [];
        for (const entry of validated) {
          const { item, asset, context } = entry;
          if (entry.stale) {
            results.push({
              id: item.id,
              status: 'conflict',
              code: 'STALE_BASE_REVISION',
              statusCode: 412,
            });
            continue;
          }
          if (!item.eligible || context.reasons.length) {
            results.push({
              id: item.id,
              status: 'skipped',
              code: 'PRECONDITIONS_MISSING',
              reasons: context.reasons,
            });
            continue;
          }
          const snapshot = {
            target: assetDto(asset),
            context: context.chain.map(assetDto),
            opinions: context.context.opinions,
          };
          let approvalSnapshotId: string | null = null;
          if (asset.target_type === 'case') {
            const scenario = context.chain.find(
              (part) => part.target_type === 'scenario',
            );
            const set = context.chain.find(
              (part) => part.target_type === 'set',
            );
            if (!scenario || !set)
              throw new Error('Case approval ancestry is incomplete');
            const approved = (
              await transaction.query<{ id: string }>(
                `INSERT INTO app.approval_snapshots(project_id,kind,set_id,case_id,case_revision_id,scenario_id,scenario_revision_id,set_revision_id,opinion_context_digest,snapshot,approved_by)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
                [
                  projectId,
                  asset.kind,
                  asset.set_id,
                  asset.id,
                  asset.current_revision_id,
                  scenario.id,
                  scenario.current_revision_id,
                  set.current_revision_id,
                  context.digest,
                  JSON.stringify({
                    case: assetDto(asset),
                    scenario: assetDto(scenario),
                    set: assetDto(set),
                    opinions: context.context.opinions,
                    ...('meetingDecisions' in context
                      ? { meetingDecisions: context.meetingDecisions }
                      : {}),
                  }),
                  actor.userId,
                ],
              )
            ).rows[0];
            if (!approved) throw new Error('Approval insert returned no row');
            approvalSnapshotId = approved.id;
          }
          await transaction.query(
            `INSERT INTO app.asset_context_approvals(project_id,kind,set_id,asset_id,revision_id,context_digest,snapshot,approved_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              projectId,
              asset.kind,
              asset.set_id,
              asset.id,
              asset.current_revision_id,
              context.digest,
              JSON.stringify(snapshot),
              actor.userId,
            ],
          );
          await transaction.query(
            "UPDATE app.test_assets SET review_state='approved',row_version=row_version+1 WHERE id=$1",
            [asset.id],
          );
          await recordBusinessActivity(
            transaction,
            projectId,
            asset.requirement_version_id,
          );
          await audit(
            transaction,
            actor,
            'reviews.approved',
            asset.id,
            projectId,
            { approvalSnapshotId, revisionId: asset.current_revision_id },
          );
          results.push({
            id: asset.id,
            status: 'approved',
            approvalSnapshotId,
          });
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
  private async currentReviewContext(
    transaction: SqlExecutor,
    asset: AssetRow,
  ) {
    const context = await reviewContext(transaction, asset);
    if (asset.kind !== 'UI' || asset.target_type !== 'case') return context;
    const gate = await uiMeetingGate(transaction, asset, context.chain);
    return {
      ...context,
      reasons: [...context.reasons, ...gate.reasons],
      digest: createHash('sha256')
        .update(
          canonicalJson({
            baseline: context.digest,
            decisions: gate.history,
            gate: gate.reasons,
          }),
        )
        .digest('hex'),
      meetingDecisions: gate.history,
    };
  }

  async latestApprovedInTransaction(
    transaction: SqlExecutor,
    projectId: string,
    caseId: string,
    kind: 'UI' | 'API',
  ) {
    if (kind !== 'UI')
      throw new DomainError(
        'VALIDATION_ERROR',
        '接口用例的回归资格由接口自动化维护。',
        400,
      );
    const asset = await getAsset(transaction, projectId, caseId);
    if (asset.target_type !== 'case' || asset.kind !== 'UI')
      throw new DomainError('NOT_FOUND', '没有此类型用例。', 404);
    const context = await this.currentReviewContext(transaction, asset);
    const row = (
      await transaction.query<ApprovalRow>(
        'SELECT * FROM app.approval_snapshots WHERE project_id=$1 AND kind=$2 AND case_id=$3 ORDER BY approval_sequence DESC LIMIT 1',
        [projectId, kind, caseId],
      )
    ).rows[0];
    if (context.reasons.length)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        context.reasons.join(' '),
        422,
      );
    if (
      !row ||
      asset.review_state !== 'approved' ||
      row.case_revision_id !== asset.current_revision_id ||
      row.scenario_revision_id !==
        context.chain.find((item) => item.target_type === 'scenario')
          ?.current_revision_id ||
      row.set_revision_id !==
        context.chain.find((item) => item.target_type === 'set')
          ?.current_revision_id
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '此 UI 用例当前修订或适用上下文尚未人工批准。',
        422,
      );
    return {
      approval: approvalDto(row),
      snapshot: approvalContentSnapshotSchema.parse(row.snapshot),
    };
  }
  async getApprovalSnapshotInTransaction(
    transaction: SqlExecutor,
    projectId: string,
    id: string,
  ) {
    const row = (
      await transaction.query<ApprovalRow>(
        'SELECT * FROM app.approval_snapshots WHERE project_id=$1 AND id=$2',
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此项目没有该批准快照。', 404);
    if (row.kind !== 'UI')
      throw new DomainError('NOT_FOUND', '此项目没有该 UI 批准快照。', 404);
    return {
      approval: approvalDto(row),
      snapshot: approvalContentSnapshotSchema.parse(row.snapshot),
    };
  }
  async getApprovalSnapshot(
    actor: ActorContext,
    projectId: string,
    id: string,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      return this.getApprovalSnapshotInTransaction(transaction, projectId, id);
    });
  }
  async latestApproved(
    actor: ActorContext,
    projectId: string,
    caseId: string,
    kind: 'UI' | 'API',
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      return this.latestApprovedInTransaction(
        transaction,
        projectId,
        caseId,
        kind,
      );
    });
  }
}
