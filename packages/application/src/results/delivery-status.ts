import {
  uiDeliveryStatusQuerySchema,
  uiDeliveryStatusSchema,
  uiBatchReceiptSchema,
} from '../../../contracts/src/ui-delivery.js';
import { idSchema, commandIdSchema } from '../../../contracts/src/base.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { semanticDigest, readRun } from '../ui-executions/service.js';
import { DomainError } from '../errors.js';
import {
  deliveryHead,
  executionFact,
  coverageSnapshot,
} from './delivery-store.js';
import {
  executionFactDto,
  sealDto,
  pendingDescriptorCount,
} from './delivery-lifecycle.js';
import {
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
} from './delivery-state.js';
import type { ExecutionFactRow } from './delivery-model.js';
import { requireProject } from '../access/policy.js';
import { requireUiDeliveryReady } from './delivery-state.js';

export class UiDeliveryStatus {
  constructor(readonly db: Database) {}
  async batchReceipt(actor: ActorContext, projectId: string, batchId: string) {
    commandIdSchema.parse(batchId);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      await requireUiDeliveryReady(tx);
      const row = (
        await tx.query<{ run_id: string; receipt: unknown }>(
          'SELECT run_id,receipt FROM app.ui_delivery_batches WHERE owner_id=$1 AND project_id=$2 AND batch_id=$3',
          [actor.userId, projectId, batchId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '当前没有本人在本项目可读的原批次回执；不能据此重发SUT。',
          404,
        );
      const run = await readRun(tx, projectId, row.run_id);
      if (run.kind !== 'UI' || run.created_by !== actor.userId)
        throw new DomainError('FORBIDDEN', '原批次回执仅本人当前可读。', 403);
      return uiBatchReceiptSchema.parse(row.receipt);
    });
  }
  async status(
    actor: ActorContext,
    projectId: string,
    runId: string,
    raw: unknown = {},
  ) {
    idSchema.parse(runId);
    const input = uiDeliveryStatusQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      await requireUiDeliveryReady(tx);
      const run = await readRun(tx, projectId, runId, 'share');
      if (run.kind !== 'UI')
        throw new DomainError('FORBIDDEN', '此入口只读取UI累计交付。', 403);
      const head = await deliveryHead(tx, run.id),
        coverage = await coverageSnapshot(tx, run),
        pending = await pendingDescriptorCount(tx, run.id),
        missing = await deliveryMissingFiles(tx, run.id),
        gate = await uiDeliveryGate(tx, run.id);
      const getFact = async (id: string | null | undefined) => {
        const row = id ? await executionFact(tx, run.id, id) : null;
        return row ? executionFactDto(row) : null;
      };
      const lastFact = await getFact(head?.last_execution_fact_id),
        lastEndFact = await getFact(head?.last_end_fact_id),
        lastResumeFact = await getFact(head?.last_resume_fact_id);
      const latestSealRow = head?.latest_seal_id
        ? (
            await tx.query<Parameters<typeof sealDto>[0]>(
              'SELECT * FROM app.ui_delivery_seals WHERE run_id=$1 AND id=$2',
              [run.id, head.latest_seal_id],
            )
          ).rows[0]
        : undefined;
      const ended =
        (
          await tx.query<{ ended_at: Date | null }>(
            'SELECT ended_at FROM app.runs WHERE id=$1',
            [run.id],
          )
        ).rows[0]?.ended_at ?? null;
      const batchCount = Number(
        (
          await tx.query<{ count: string }>(
            'SELECT count(*)::text count FROM app.ui_delivery_batches WHERE run_id=$1',
            [run.id],
          )
        ).rows[0]?.count ?? '0',
      );
      const deliveryStatus =
        projectUiDelivery(
          gate,
          coverage.reported,
          coverage.scope.items.length,
          missing.length,
        ) ??
        (coverage.reported
          ? coverage.missing.length === 0 && missing.length === 0
            ? 'complete'
            : 'incomplete'
          : run.delivery_status);
      const page = await this.page(
        tx,
        run.id,
        input,
        coverage.scope.items.map((x) => x.runItemId),
      );
      const reportId =
        (
          await tx.query<{ id: string }>(
            'SELECT id FROM app.reports WHERE project_id=$1 AND run_id=$2',
            [projectId, run.id],
          )
        ).rows[0]?.id ?? null;
      return uiDeliveryStatusSchema.parse({
        protocolVersion: 'ath.ui-delivery.v2',
        runId: run.id,
        projectId,
        snapshotDigest: run.scope_digest,
        mode: head?.mode ?? null,
        rowVersion: run.row_version,
        headRowVersion: head?.row_version ?? null,
        executionState: run.state,
        executionProvenance: run.execution_provenance,
        endedAt: ended?.toISOString() ?? null,
        reportId,
        progressSequence: run.progress_sequence,
        completedItems: run.completed_items,
        progressClosedAt: run.progress_closed_at?.toISOString() ?? null,
        lastProgressAt: run.last_progress_at?.toISOString() ?? null,
        ledgerVersion: head?.ledger_version ?? '0',
        ledgerDigest:
          head?.ledger_digest ??
          semanticDigest({
            schemaVersion: 'ath.ui-delivery-ledger.v2',
            runId: run.id,
            snapshotDigest: run.scope_digest,
          }),
        batchCount,
        totalItems: coverage.scope.items.length,
        reportedItems: coverage.reported,
        notReportedItems: coverage.missing.length,
        pendingDescriptors: pending,
        missingFileCount: missing.length,
        lastFact,
        lastEndFact,
        lastResumeFact,
        latestSeal: latestSealRow ? sealDto(latestSealRow) : null,
        deliveryStatus,
        page,
      });
    });
  }
  private async page(
    tx: SqlExecutor,
    runId: string,
    input: ReturnType<typeof uiDeliveryStatusQuerySchema.parse>,
    scopeIds: string[],
  ) {
    const params = [runId, input.afterId ?? null, input.limit + 1] as const;
    let rows: { id: string; [key: string]: unknown }[] = [];
    if (input.pageKind === 'items') {
      if (
        input.afterId &&
        !(
          await tx.query(
            'SELECT 1 FROM app.run_items WHERE run_id=$1 AND id=$2 AND id=ANY($3::uuid[])',
            [runId, input.afterId, scopeIds],
          )
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '本固定范围没有此分页游标。', 404);
      rows = (
        await tx.query<{
          id: string;
          result_id: string | null;
          original_revision_id: string | null;
          current_revision_id: string | null;
          original_outcome: string | null;
          pending: boolean;
        }>(
          `SELECT i.id,r.id result_id,v.id original_revision_id,r.current_revision_id,v.content->>'originalOutcome' original_outcome,
        EXISTS(SELECT 1 FROM app.ui_result_descriptors d WHERE d.run_id=i.run_id AND d.run_item_id=i.id AND NOT EXISTS(SELECT 1 FROM app.ui_delivery_assemblies a WHERE a.descriptor_record_id=d.id) AND NOT EXISTS(SELECT 1 FROM app.ui_result_descriptors n WHERE n.supersedes_descriptor_id=d.id)) pending
        FROM app.run_items i LEFT JOIN app.results r ON r.run_item_id=i.id LEFT JOIN app.result_revisions v ON v.result_id=r.id AND v.revision_no=1
        WHERE i.run_id=$1 AND ($2::uuid IS NULL OR (i.ordinal,i.id)>(SELECT ordinal,id FROM app.run_items WHERE run_id=$1 AND id=$2)) AND i.id=ANY($4::uuid[]) ORDER BY i.ordinal,i.id LIMIT $3`,
          [...params, scopeIds],
        )
      ).rows;
      const page = rows.slice(0, input.limit);
      return {
        kind: 'items' as const,
        items: page.map((x) => ({
          runItemId: x.id,
          status: x.result_id
            ? 'reported'
            : x.pending
              ? 'pendingAssembly'
              : 'notReported',
          resultId: x.result_id,
          originalRevisionId: x.original_revision_id,
          currentRevisionId: x.current_revision_id,
          originalOutcome: x.original_outcome,
        })),
        hasMore: rows.length > input.limit,
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    }
    if (input.pageKind === 'files') {
      const sql = `WITH refs AS(SELECT file_id,true evidence,false source FROM app.run_evidence WHERE run_id=$1 UNION ALL SELECT file_id,false,true FROM app.ui_delivery_batch_sources WHERE run_id=$1), files AS(SELECT file_id,bool_or(evidence) evidence,bool_or(source) source FROM refs GROUP BY file_id)
        SELECT f.id,CASE WHEN files.evidence AND files.source THEN 'both' WHEN files.evidence THEN 'evidence' ELSE 'sourceJson' END source,CASE WHEN f.deleted_at IS NOT NULL THEN 'unavailable' ELSE f.status END status FROM files JOIN app.file_resources f ON f.id=files.file_id`;
      if (
        input.afterId &&
        !(
          await tx.query(`SELECT 1 FROM (${sql}) q WHERE q.id=$2`, [
            runId,
            input.afterId,
          ])
        ).rowCount
      )
        throw new DomainError('NOT_FOUND', '本执行文件列表没有此游标。', 404);
      rows = (
        await tx.query<{ id: string; source: string; status: string }>(
          `${sql} WHERE ($2::uuid IS NULL OR f.id>$2) ORDER BY f.id LIMIT $3`,
          params,
        )
      ).rows;
      const page = rows.slice(0, input.limit);
      return {
        kind: 'files' as const,
        items: page.map((x) => ({
          fileId: x.id,
          source: x.source,
          status: x.status,
        })),
        hasMore: rows.length > input.limit,
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    }
    const table =
      input.pageKind === 'batches'
        ? 'app.ui_delivery_batches'
        : input.pageKind === 'facts'
          ? 'app.ui_execution_facts'
          : 'app.ui_result_descriptors';
    if (
      input.afterId &&
      !(
        await tx.query(`SELECT 1 FROM ${table} WHERE run_id=$1 AND id=$2`, [
          runId,
          input.afterId,
        ])
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', '本执行没有此分页游标。', 404);
    if (input.pageKind === 'batches') {
      rows = (
        await tx.query<{
          id: string;
          batch_id: string;
          semantic_digest: string;
          ledger_version: string;
          received_at: Date;
          source_file_id: string | null;
        }>(
          `SELECT b.*,s.file_id source_file_id FROM app.ui_delivery_batches b LEFT JOIN app.ui_delivery_batch_sources s ON s.batch_record_id=b.id WHERE b.run_id=$1 AND ($2::uuid IS NULL OR b.ledger_version>(SELECT ledger_version FROM app.ui_delivery_batches WHERE run_id=$1 AND id=$2)) ORDER BY b.ledger_version LIMIT $3`,
          params,
        )
      ).rows;
      const page = rows.slice(0, input.limit);
      return {
        kind: 'batches' as const,
        items: page.map((x) => ({
          id: x.id,
          batchId: x.batch_id,
          semanticDigest: x.semantic_digest,
          ledgerVersion: x.ledger_version,
          receivedAt: (x.received_at as Date).toISOString(),
          sourceFileId: x.source_file_id,
        })),
        hasMore: rows.length > input.limit,
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    }
    if (input.pageKind === 'facts') {
      const facts = (
        await tx.query<ExecutionFactRow>(
          `SELECT * FROM app.ui_execution_facts WHERE run_id=$1 AND ($2::uuid IS NULL OR sequence>(SELECT sequence FROM app.ui_execution_facts WHERE run_id=$1 AND id=$2)) ORDER BY sequence LIMIT $3`,
          params,
        )
      ).rows;
      const page = facts.slice(0, input.limit);
      return {
        kind: 'facts' as const,
        items: page.map(executionFactDto),
        hasMore: facts.length > input.limit,
        nextCursor: facts.length > input.limit ? page.at(-1)!.id : null,
      };
    }
    rows = (
      await tx.query<{
        id: string;
        descriptor_id: string;
        run_item_id: string;
        local_result_id: string;
        refs_count: number;
        segment_count: number;
        semantic_digest: string;
        full_refs_digest: string;
        item_digest: string;
        received_ref_count: number;
        received_segment_count: number;
        state: string;
        supersedes: string | null;
        superseded_by: string | null;
      }>(
        `SELECT d.*,p.descriptor_id supersedes,n.descriptor_id superseded_by,COALESCE(s.refs,0)::integer received_ref_count,COALESCE(s.segments,0)::integer received_segment_count,
      CASE WHEN n.id IS NOT NULL THEN 'superseded' WHEN a.descriptor_record_id IS NOT NULL THEN 'assembled' ELSE 'pending' END state
      FROM app.ui_result_descriptors d LEFT JOIN app.ui_result_descriptors p ON p.id=d.supersedes_descriptor_id LEFT JOIN app.ui_result_descriptors n ON n.supersedes_descriptor_id=d.id LEFT JOIN app.ui_delivery_assemblies a ON a.descriptor_record_id=d.id
      LEFT JOIN LATERAL(SELECT sum(jsonb_array_length(evidence_refs)) refs,count(*) segments FROM app.ui_result_ref_segments WHERE descriptor_record_id=d.id)s ON true
      WHERE d.run_id=$1 AND ($2::uuid IS NULL OR (d.created_at,d.id)>(SELECT created_at,id FROM app.ui_result_descriptors WHERE run_id=$1 AND id=$2)) ORDER BY d.created_at,d.id LIMIT $3`,
        params,
      )
    ).rows;
    const page = rows.slice(0, input.limit);
    return {
      kind: 'descriptors' as const,
      items: page.map((x) => ({
        id: x.id,
        descriptorId: x.descriptor_id,
        runItemId: x.run_item_id,
        localResultId: x.local_result_id,
        expectedRefCount: x.refs_count,
        receivedRefCount: x.received_ref_count,
        segmentCount: x.segment_count,
        receivedSegmentCount: x.received_segment_count,
        semanticDigest: x.semantic_digest,
        fullRefsDigest: x.full_refs_digest,
        itemDigest: x.item_digest,
        state: x.state,
        supersedesDescriptorId: x.supersedes,
        supersededByDescriptorId: x.superseded_by,
      })),
      hasMore: rows.length > input.limit,
      nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
    };
  }
}
