import { randomUUID } from 'node:crypto';
import {
  uiDeclareEndInputSchema,
  uiDeclareResumeInputSchema,
  uiExecutionFactReceiptSchema,
  uiExecutionFactSchema,
  uiSealDeliveryInputSchema,
  uiDeliverySealReceiptSchema,
  uiDeliverySealSchema,
} from '../../../contracts/src/ui-delivery.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { OperationService } from '../operations/service.js';
import { semanticDigest } from '../ui-executions/service.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { assertSafeResultContent } from './safety.js';
import { assertLocalUiActor } from './delivery-access.js';
import {
  authorizeDelivery,
  ensureDeliveryHead,
  deliveryHead,
  executionFact,
  coverageSnapshot,
  uiDeliveryOperations,
} from './delivery-store.js';
import type { ExecutionFactRow } from './delivery-model.js';
import { deliveryMissingFiles } from './delivery-state.js';
import { persistReportRevision } from '../reports/service.js';

export function executionFactDto(row: ExecutionFactRow) {
  return uiExecutionFactSchema.parse({
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    kind: row.fact_kind,
    commandId: row.command_id,
    previousFactId: row.previous_fact_id,
    endFactId: row.end_fact_id,
    resumeFactId: row.resume_fact_id,
    endKind: row.end_kind,
    endedAt: row.ended_at?.toISOString() ?? null,
    resumedAt: row.resumed_at?.toISOString() ?? null,
    reason: row.reason,
    provenance: row.provenance,
    legacyState: row.legacy_state,
    receivedAt: row.received_at.toISOString(),
  });
}
export async function pendingDescriptorCount(tx: SqlExecutor, runId: string) {
  return Number(
    (
      await tx.query<{ count: string }>(
        `SELECT count(*)::text count FROM app.ui_result_descriptors d WHERE d.run_id=$1
  AND NOT EXISTS(SELECT 1 FROM app.ui_delivery_assemblies a WHERE a.descriptor_record_id=d.id)
  AND NOT EXISTS(SELECT 1 FROM app.ui_result_descriptors n WHERE n.supersedes_descriptor_id=d.id)`,
        [runId],
      )
    ).rows[0]?.count ?? '0',
  );
}
export function sealDto(row: {
  id: string;
  run_id: string;
  command_id: string;
  ledger_version: string;
  ledger_digest: string;
  coverage_digest: string;
  coverage_count: number;
  end_fact_id: string;
  created_at: Date;
}) {
  return uiDeliverySealSchema.parse({
    id: row.id,
    runId: row.run_id,
    commandId: row.command_id,
    ledgerVersion: row.ledger_version,
    ledgerDigest: row.ledger_digest,
    coverageDigest: row.coverage_digest,
    coverageCount: row.coverage_count,
    endFactId: row.end_fact_id,
    createdAt: row.created_at.toISOString(),
  });
}

export class UiDeliveryLifecycle {
  private readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async declareEnd(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiDeclareEndInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      uiDeliveryOperations.end,
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
        );
      },
      async (tx) => {
        const run = await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
          true,
        );
        if (run.row_version !== input.rowVersion) stale();
        const head = await ensureDeliveryHead(tx, run),
          previous = head.last_execution_fact_id
            ? await executionFact(tx, run.id, head.last_execution_fact_id)
            : null;
        if (previous?.fact_kind === 'end')
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '原段已有结束事实；补传不更改它，继续执行需先明确声明原轮恢复。',
            409,
          );
        if (previous?.fact_kind === 'resume') {
          if (input.resumeFactId !== previous.id)
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '本次结束未绑定当前恢复事实。',
              409,
            );
          if (
            previous.resumed_at &&
            Date.parse(input.endedAt) < previous.resumed_at.getTime()
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '结束时间早于本段恢复时间，请核对实际记录。',
              422,
            );
        } else if (input.resumeFactId !== null)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '首段结束不能借用其他恢复事实。',
            409,
          );
        const id = randomUUID(),
          at = new Date(),
          sequence = (BigInt(head.execution_version) + 1n).toString(),
          state = input.endKind === 'normal' ? 'completed' : input.endKind;
        const fact = uiExecutionFactSchema.parse({
          id,
          runId: run.id,
          sequence,
          kind: 'end',
          commandId: input.commandId,
          previousFactId: previous?.id ?? null,
          endFactId: null,
          resumeFactId: previous?.id ?? null,
          endKind: input.endKind,
          endedAt: input.endedAt,
          resumedAt: null,
          reason: input.reason,
          provenance: run.execution_provenance,
          legacyState: null,
          receivedAt: at.toISOString(),
        });
        const receipt = uiExecutionFactReceiptSchema.parse({
          runId: run.id,
          snapshotDigest: run.scope_digest,
          mode: head.mode,
          rowVersion: run.row_version + 1,
          headRowVersion: head.row_version + 1,
          state,
          fact,
          localExecutionStartedRemotely: false,
        });
        await tx.query(
          `INSERT INTO app.ui_execution_facts(id,project_id,run_id,owner_id,scope_digest,sequence,fact_kind,command_id,semantic_digest,previous_fact_id,resume_fact_id,end_kind,ended_at,reason,provenance,payload,receipt,received_at)
        VALUES($1,$2,$3,$4,$5,$6,'end',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            id,
            projectId,
            run.id,
            actor.userId,
            run.scope_digest,
            sequence,
            input.commandId,
            semanticDigest(input),
            previous?.id ?? null,
            previous?.id ?? null,
            input.endKind,
            input.endedAt,
            input.reason,
            run.execution_provenance,
            JSON.stringify(input),
            JSON.stringify(receipt),
            at,
          ],
        );
        await tx.query(
          'UPDATE app.ui_delivery_heads SET execution_version=$2,last_execution_fact_id=$3,last_end_fact_id=$3,latest_seal_id=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
          [run.id, sequence, id],
        );
        await tx.query(
          "UPDATE app.runs SET state=$2,ended_at=$3,delivery_status='incomplete',row_version=row_version+1 WHERE id=$1",
          [run.id, state, input.endedAt],
        );
        await persistReportRevision(
          tx,
          actor,
          projectId,
          run.id,
          'ui-v2-execution-end',
        );
        await audit(tx, actor, 'ui-execution.end-declared', run.id, projectId, {
          factId: id,
          endKind: input.endKind,
          resumeFactId: input.resumeFactId,
        });
        return receipt;
      },
      projectId,
    );
  }
  async declareResume(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiDeclareResumeInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      uiDeliveryOperations.resume,
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
        );
      },
      async (tx) => {
        const run = await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
          true,
        );
        if (run.row_version !== input.rowVersion) stale();
        const head = await ensureDeliveryHead(tx, run);
        if (
          head.last_execution_fact_id !== input.endFactId ||
          head.last_end_fact_id !== input.endFactId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '恢复须绑定当前段原结束事实，不能扩成另run或再次恢复。',
            409,
          );
        const previous = await executionFact(tx, run.id, input.endFactId);
        if (
          !previous ||
          previous.fact_kind !== 'end' ||
          !['terminated', 'interrupted'].includes(run.state)
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '只可明确恢复尚未完成的原终止/中断轮；已正常结束的复测应新建执行。',
            422,
          );
        if (
          previous.ended_at &&
          Date.parse(input.resumedAt) < previous.ended_at.getTime()
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '恢复时间早于原结束时间，请核对实际记录。',
            422,
          );
        const id = randomUUID(),
          at = new Date(),
          sequence = (BigInt(head.execution_version) + 1n).toString(),
          mode =
            head.mode === 'legacyDeliveryOnly' ? 'legacyResumed' : head.mode;
        const fact = uiExecutionFactSchema.parse({
          id,
          runId: run.id,
          sequence,
          kind: 'resume',
          commandId: input.commandId,
          previousFactId: previous.id,
          endFactId: previous.id,
          resumeFactId: null,
          endKind: null,
          endedAt: null,
          resumedAt: input.resumedAt,
          reason: input.reason,
          provenance: run.execution_provenance,
          legacyState: null,
          receivedAt: at.toISOString(),
        });
        const receipt = uiExecutionFactReceiptSchema.parse({
          runId: run.id,
          snapshotDigest: run.scope_digest,
          mode,
          rowVersion: run.row_version + 1,
          headRowVersion: head.row_version + 1,
          state: 'running',
          fact,
          localExecutionStartedRemotely: false,
        });
        await tx.query(
          `INSERT INTO app.ui_execution_facts(id,project_id,run_id,owner_id,scope_digest,sequence,fact_kind,command_id,semantic_digest,previous_fact_id,end_fact_id,resumed_at,reason,provenance,payload,receipt,received_at)
        VALUES($1,$2,$3,$4,$5,$6,'resume',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            id,
            projectId,
            run.id,
            actor.userId,
            run.scope_digest,
            sequence,
            input.commandId,
            semanticDigest(input),
            previous.id,
            previous.id,
            input.resumedAt,
            input.reason,
            run.execution_provenance,
            JSON.stringify(input),
            JSON.stringify(receipt),
            at,
          ],
        );
        await tx.query(
          'UPDATE app.ui_delivery_heads SET mode=$2,execution_version=$3,last_execution_fact_id=$4,last_resume_fact_id=$4,latest_seal_id=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
          [run.id, mode, sequence, id],
        );
        await tx.query(
          "UPDATE app.runs SET state='running',ended_at=NULL,delivery_status='incomplete',row_version=row_version+1 WHERE id=$1",
          [run.id],
        );
        await audit(
          tx,
          actor,
          'ui-execution.resume-declared',
          run.id,
          projectId,
          {
            factId: id,
            endFactId: previous.id,
            localExecutionStartedRemotely: false,
          },
        );
        return receipt;
      },
      projectId,
    );
  }
  async seal(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiSealDeliveryInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      uiDeliveryOperations.seal,
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
        );
      },
      async (tx) => {
        const run = await authorizeDelivery(
            tx,
            actor,
            projectId,
            input.runId,
            input.snapshotDigest,
            true,
          ),
          head = await deliveryHead(tx, run.id, true);
        if (!head)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '没有v2接收账本；请保留原批次，不能凭范围生成封账。',
            422,
          );
        if (
          head.ledger_version !== input.expectedLedgerVersion ||
          head.ledger_digest !== input.expectedLedgerDigest
        )
          stale();
        if (
          head.last_execution_fact_id !== input.endFactId ||
          head.last_end_fact_id !== input.endFactId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '封账须绑定当前结束事实，不能复活旧段或封正在恢复的段。',
            409,
          );
        const end = await executionFact(tx, run.id, input.endFactId);
        if (!end || end.fact_kind !== 'end')
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '缺少明确结束依据。',
            422,
          );
        const coverage = await coverageSnapshot(tx, run),
          pending = await pendingDescriptorCount(tx, run.id);
        if (
          coverage.missing.length ||
          coverage.reported !== coverage.scope.items.length ||
          pending
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '累计明细未覆盖全部固定项或仍有未组装描述，不自动补未执行。',
            422,
            {
              notReported: coverage.missing.length,
              pendingDescriptors: pending,
            },
          );
        const id = randomUUID(),
          at = new Date(),
          missing = await deliveryMissingFiles(tx, run.id);
        const seal = uiDeliverySealSchema.parse({
          id,
          runId: run.id,
          commandId: input.commandId,
          ledgerVersion: head.ledger_version,
          ledgerDigest: head.ledger_digest,
          coverageDigest: coverage.digest,
          coverageCount: coverage.reported,
          endFactId: input.endFactId,
          createdAt: at.toISOString(),
        });
        const existingReport = (
          await tx.query<{ id: string }>(
            'SELECT id FROM app.reports WHERE run_id=$1',
            [run.id],
          )
        ).rows[0];
        const report = existingReport
          ? { reportId: existingReport.id }
          : await persistReportRevision(
              tx,
              actor,
              projectId,
              run.id,
              'ui-v2-seal-facts-ready',
            );
        const deliveryStatus = missing.length ? 'incomplete' : 'complete';
        const receipt = uiDeliverySealReceiptSchema.parse({
          runId: run.id,
          snapshotDigest: run.scope_digest,
          seal,
          deliveryStatus,
          missingFileCount: missing.length,
          reportId: report.reportId,
          executionStateChanged: false,
        });
        await tx.query(
          `INSERT INTO app.ui_delivery_seals(id,project_id,run_id,owner_id,scope_digest,command_id,semantic_digest,ledger_version,ledger_digest,coverage_digest,coverage_count,coverage_snapshot,end_fact_id,missing_file_ids,payload,receipt,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            id,
            projectId,
            run.id,
            actor.userId,
            run.scope_digest,
            input.commandId,
            semanticDigest(input),
            head.ledger_version,
            head.ledger_digest,
            coverage.digest,
            coverage.reported,
            JSON.stringify(coverage.snapshot),
            input.endFactId,
            missing,
            JSON.stringify(input),
            JSON.stringify(receipt),
            at,
          ],
        );
        await tx.query(
          'UPDATE app.ui_delivery_heads SET latest_seal_id=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
          [run.id, id],
        );
        await persistReportRevision(
          tx,
          actor,
          projectId,
          run.id,
          'ui-v2-delivery-sealed',
        );
        await tx.query(
          'UPDATE app.runs SET delivery_status=$2,row_version=row_version+1 WHERE id=$1',
          [run.id, deliveryStatus],
        );
        await audit(
          tx,
          actor,
          'results.ui-delivery-sealed',
          run.id,
          projectId,
          {
            sealId: id,
            coverageCount: coverage.reported,
            endFactId: input.endFactId,
            missingFileCount: missing.length,
          },
        );
        return receipt;
      },
      projectId,
    );
  }
}
