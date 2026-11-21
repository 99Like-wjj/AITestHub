import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  uiResultBatchResourceSchema as uiResultBatchSchema,
  uiBatchReceiptSchema,
  uiBatchPreparationSchema,
} from '../../../contracts/src/ui-delivery.js';
import type {
  UiResultBatch,
  UiResultDescriptor,
  UiEvidenceRefSegment,
} from '../../../contracts/src/ui-delivery.js';
import { resultItemSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { RunRow } from '../ui-executions/service.js';
import { semanticDigest } from '../ui-executions/service.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import {
  registerEvidence,
  evidenceIdsForReferences,
  missingFiles,
} from './evidence.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import { assertReferencedEvidenceFileBudget } from './submission-budget.js';
import {
  fileResourcePolicies,
  assertFilePolicyCounts,
  type FileResourcePolicies,
  type FilePolicySnapshot,
} from '../files/resource-policy.js';
import { assertSafeResultContent } from './safety.js';
import { assertLocalUiActor } from './delivery-access.js';
import {
  authorizeDelivery,
  ensureDeliveryHead,
  uiDeliveryOperations,
} from './delivery-store.js';
import { appendUiOriginal } from './delivery-model.js';
import type { DescriptorRow, OriginalFactReceipt } from './delivery-model.js';
import { readDeliveryJson } from './delivery-json.js';
import type { DeliveryJsonSource } from './delivery-json.js';
import type { FilesService } from '../files/service.js';
import { persistReportRevision } from '../reports/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import { requireProject } from '../access/policy.js';
import {
  requireUiDeliveryReady,
  linkUiDeliverySourcesToReport,
} from './delivery-state.js';

type ItemReceipt = z.infer<
  typeof uiBatchReceiptSchema
>['perItemResults'][number];
function involvedRefs(input: UiResultBatch) {
  return [
    ...new Set([
      ...input.evidenceManifest.map((x) => x.localEvidenceId),
      ...input.items.flatMap((x) => x.evidenceRefs),
      ...input.evidenceSegments.flatMap((x) => x.evidenceRefs),
    ]),
  ];
}
function itemReceipt(
  kind: ItemReceipt['kind'],
  objectId: string,
  runItemId: string | null,
  fact: OriginalFactReceipt | null,
  descriptorId: string | null = null,
): ItemReceipt {
  return {
    kind,
    objectId,
    runItemId,
    status: fact?.status ?? 'pendingAssembly',
    resultId: fact?.resultId ?? null,
    revisionId: fact?.revisionId ?? null,
    descriptorId,
    code: fact?.code ?? null,
  };
}
const conflict = (code: string): OriginalFactReceipt => ({
  status: 'conflict',
  resultId: null,
  revisionId: null,
  code,
  message: null,
});

export class UiDeliveryBatches {
  private readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly policies: FileResourcePolicies = fileResourcePolicies,
  ) {
    this.operations = new OperationService(db);
  }
  private async files(
    tx: SqlExecutor,
    projectId: string,
    run: RunRow,
    input: UiResultBatch,
    policy: FilePolicySnapshot,
    source?: DeliveryJsonSource,
  ) {
    const refs = involvedRefs(input),
      manifest = new Map(
        input.evidenceManifest.map((x) => [x.localEvidenceId, x]),
      );
    assertFilePolicyCounts(policy, refs.length);
    const prior = (
      await tx.query<{
        local_evidence_id: string;
        file_id: string;
        manifest: unknown;
      }>(
        'SELECT local_evidence_id,file_id,manifest FROM app.run_evidence WHERE run_id=$1 AND local_evidence_id=ANY($2::text[])',
        [run.id, refs],
      )
    ).rows;
    const old = new Map(prior.map((x) => [x.local_evidence_id, x])),
      ids: string[] = [];
    for (const ref of refs) {
      const declared = manifest.get(ref),
        existing = old.get(ref);
      if (
        declared &&
        existing &&
        canonicalJson(existing.manifest) !== canonicalJson(declared)
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原本地证据标识已绑定另一内容。',
          409,
        );
      const fileId = declared?.fileId ?? existing?.file_id;
      if (!fileId)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '本批引用尚未在同run登记的证据。',
          422,
        );
      const file = (
        await tx.query<{
          run_id: string | null;
          declared_sha256: string;
          declared_bytes: string;
          status: string;
        }>(
          `SELECT run_id,declared_sha256,declared_bytes::text,status FROM app.file_resources
        WHERE id=$1 AND project_id=$2 AND owner_scope='project' AND deleted_at IS NULL FOR SHARE`,
          [fileId, projectId],
        )
      ).rows[0];
      if (!file)
        throw new DomainError('NOT_FOUND', '证据不在本项目可用登记中。', 404);
      if (
        file.run_id !== run.id &&
        !(file.run_id === null && existing?.file_id === fileId)
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          'v2新证据须固定属于原run，旧NULL资源仅可恢复原run既有证据身份。',
          409,
        );
      if (
        declared &&
        (declared.sha256 !== file.declared_sha256 ||
          declared.bytes !== file.declared_bytes)
      )
        throw new DomainError(
          'FILE_HASH_MISMATCH',
          '本批证据与原登记的摘要或长度不符。',
          409,
        );
      ids.push(fileId);
    }
    if (source && source.runId !== run.id)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        'v2原JSON必须登记到原run。',
        409,
      );
    const budget = await assertSubmissionFileBudget(
      tx,
      projectId,
      [...ids, ...(source ? [source.fileId] : [])],
      policy,
      'callerCounted',
    );
    return { refs, fileIds: [...new Set(ids)], ...budget };
  }
  async prepareBatch(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiResultBatchSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const run = await authorizeDelivery(
          tx,
          actor,
          projectId,
          input.runId,
          input.snapshotDigest,
        ),
        head = await ensureDeliveryHead(tx, run),
        policy = await this.batchPolicy(tx, actor, projectId, input, false),
        budget = await this.files(tx, projectId, run, input, policy);
      this.scope(run, input);
      return uiBatchPreparationSchema.parse({
        runId: run.id,
        batchId: input.batchId,
        snapshotDigest: run.scope_digest,
        semanticDigest: semanticDigest(input),
        mode: head.mode,
        rowVersion: run.row_version,
        headRowVersion: head.row_version,
        ledgerVersion: head.ledger_version,
        ledgerDigest: head.ledger_digest,
        involvedEvidence: budget.refs.length,
        uniqueFiles: budget.uniqueFiles,
        declaredBytes: budget.declaredBytes,
        sourceJsonIncluded: false,
        executionStateChanged: false,
        persisted: false,
      });
    });
  }
  private scope(run: RunRow, input: UiResultBatch) {
    const ids = new Set(
      (run.scope_snapshot as { items: { runItemId: string }[] }).items.map(
        (x) => x.runItemId,
      ),
    );
    for (const id of [
      ...input.items.map((x) => x.runItemId),
      ...input.explicitNotExecutedItems.map((x) => x.runItemId),
      ...input.descriptors.map((x) => x.core.runItemId),
    ])
      if (!ids.has(id))
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '批次包含固定scope以外的项。',
          409,
        );
  }
  receiveBatch(actor: ActorContext, projectId: string, raw: unknown) {
    return this.receiveInternal(actor, projectId, raw);
  }
  private async batchPolicy(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    input: UiResultBatch,
    accept: boolean,
  ) {
    const original = (
      await tx.query<{ semantic_digest: string }>(
        'SELECT semantic_digest FROM app.ui_delivery_batches WHERE owner_id=$1 AND run_id=$2 AND batch_id=$3',
        [actor.userId, input.runId, input.batchId],
      )
    ).rows[0];
    if (original && original.semantic_digest !== semanticDigest(input))
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '原批次标识已绑定不同载荷；不能借旧默认预检新内容。',
        409,
      );
    const existing = Boolean(original);
    const identity = {
      ownerId: actor.userId,
      projectId,
      namespace: 'ui.batch' as const,
      key: input.batchId,
      payloadDigest: semanticDigest(input),
      existing,
    };
    return accept
      ? this.policies.accept(tx, identity)
      : this.policies.read(tx, identity);
  }
  private async receiveInternal(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
    source?: DeliveryJsonSource,
  ) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiResultBatchSchema.parse(raw),
      digest = semanticDigest(input);
    let linked = false;
    const receipt = await this.operations.execute(
      actor,
      uiDeliveryOperations.batch,
      input.batchId,
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
        this.scope(run, input);
        const policy = await this.batchPolicy(
            tx,
            actor,
            projectId,
            input,
            true,
          ),
          head = await ensureDeliveryHead(tx, run),
          budget = await this.files(tx, projectId, run, input, policy, source),
          batchRecordId = randomUUID();
        await registerEvidence(
          tx,
          actor,
          projectId,
          run.id,
          input.evidenceManifest,
        );
        const perItem: ItemReceipt[] = [];
        for (const item of input.items)
          perItem.push(
            await this.fullItem(tx, actor, projectId, run, item, 'result'),
          );
        for (const item of input.explicitNotExecutedItems) {
          const full = resultItemSchema.parse({
            runItemId: item.runItemId,
            localResultId: item.localResultId,
            originalOutcome: 'notExecuted',
            actualObservations: `客户端明确声明未执行：${item.reason}`,
            reason: item.reason,
            sideEffectCertainty: 'notApplicable',
            evidenceRefs: [],
            ...(item.endedAt ? { endedAt: item.endedAt } : {}),
          });
          perItem.push(
            await this.fullItem(tx, actor, projectId, run, full, 'notExecuted'),
          );
        }
        for (const descriptor of input.descriptors)
          perItem.push(
            await this.descriptor(
              tx,
              actor,
              projectId,
              run,
              batchRecordId,
              descriptor,
            ),
          );
        for (const segment of input.evidenceSegments)
          perItem.push(
            await this.segment(
              tx,
              actor,
              projectId,
              run,
              batchRecordId,
              segment,
            ),
          );
        const version = (BigInt(head.ledger_version) + 1n).toString(),
          ledgerDigest = semanticDigest({
            previousVersion: head.ledger_version,
            previousDigest: head.ledger_digest,
            batchId: input.batchId,
            payloadDigest: digest,
            items: perItem,
          });
        await tx.query(
          'UPDATE app.ui_delivery_heads SET ledger_version=$2,ledger_digest=$3,latest_seal_id=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
          [run.id, version, ledgerDigest],
        );
        await tx.query(
          "UPDATE app.runs SET delivery_status='receiving',row_version=row_version+1 WHERE id=$1",
          [run.id],
        );
        const resultsAccepted = perItem.filter(
          (x) => x.status === 'accepted' && x.resultId !== null,
        ).length;
        const mayReport =
          head.last_execution_fact_id !== null &&
          head.last_execution_fact_id === head.last_end_fact_id;
        const report =
          mayReport && resultsAccepted > 0
            ? await persistReportRevision(
                tx,
                actor,
                projectId,
                run.id,
                'ui-v2-data-batch',
              )
            : {
                reportId:
                  (
                    await tx.query<{ id: string }>(
                      'SELECT id FROM app.reports WHERE run_id=$1',
                      [run.id],
                    )
                  ).rows[0]?.id ?? null,
              };
        const missing = new Set(await missingFiles(tx, run.id)),
          missingInBatch = budget.fileIds.filter((x) => missing.has(x));
        const result = uiBatchReceiptSchema.parse({
          batchId: input.batchId,
          runId: run.id,
          snapshotDigest: run.scope_digest,
          semanticDigest: digest,
          resultsAccepted,
          ledgerVersion: version,
          ledgerDigest,
          deliveryStatus: 'incomplete',
          missingFilesScope: 'batch',
          missingFileIds: missingInBatch,
          reportId: report.reportId,
          perItemResults: perItem,
          executionStateChanged: false,
        });
        await tx.query(
          `INSERT INTO app.ui_delivery_batches(id,project_id,run_id,owner_id,scope_digest,batch_id,semantic_digest,ledger_version,payload,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            batchRecordId,
            projectId,
            run.id,
            actor.userId,
            run.scope_digest,
            input.batchId,
            digest,
            version,
            JSON.stringify(input),
            JSON.stringify(result),
          ],
        );
        for (const [ordinal, item] of perItem.entries())
          await tx.query(
            `INSERT INTO app.ui_delivery_batch_items(batch_record_id,run_id,project_id,item_ordinal,item_kind,object_id,run_item_id,status,result_id,result_revision_id,descriptor_record_id,semantic_digest,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT id FROM app.ui_result_descriptors WHERE run_id=$2 AND descriptor_id=$11),$12,$13)`,
            [
              batchRecordId,
              run.id,
              projectId,
              ordinal,
              item.kind,
              item.objectId,
              item.runItemId,
              item.status,
              item.resultId,
              item.revisionId,
              item.descriptorId,
              semanticDigest(item),
              JSON.stringify(item),
            ],
          );
        if (source) {
          await this.linkSource(
            tx,
            actor,
            projectId,
            run,
            input,
            batchRecordId,
            source,
            false,
          );
          linked = true;
        }
        if (resultsAccepted)
          for (const versionId of new Set(
            (
              run.scope_snapshot as {
                items: { requirementVersionId: string }[];
              }
            ).items.map((x) => x.requirementVersionId),
          ))
            await recordBusinessActivity(tx, projectId, versionId);
        await audit(
          tx,
          actor,
          'results.ui-delivery-batch-received',
          run.id,
          projectId,
          {
            batchId: input.batchId,
            ledgerVersion: version,
            resultsAccepted,
            hasConflicts: perItem.some((x) => x.status === 'conflict'),
          },
        );
        return result;
      },
      projectId,
    );
    if (source && !linked)
      await this.db.transaction(async (tx) => {
        const run = await authorizeDelivery(
            tx,
            actor,
            projectId,
            input.runId,
            input.snapshotDigest,
            true,
          ),
          batch = (
            await tx.query<{ id: string; semantic_digest: string }>(
              'SELECT id,semantic_digest FROM app.ui_delivery_batches WHERE owner_id=$1 AND batch_id=$2 AND run_id=$3',
              [actor.userId, input.batchId, run.id],
            )
          ).rows[0];
        if (!batch || batch.semantic_digest !== digest)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '原JSON没有匹配的原批次回执。',
            409,
          );
        await this.files(
          tx,
          projectId,
          run,
          input,
          await this.batchPolicy(tx, actor, projectId, input, false),
          source,
        );
        await this.linkSource(
          tx,
          actor,
          projectId,
          run,
          input,
          batch.id,
          source,
        );
      });
    return uiBatchReceiptSchema.parse(receipt);
  }
  async receiveBatchFile(
    actor: ActorContext,
    projectId: string,
    fileId: string,
    files: FilesService,
  ) {
    assertLocalUiActor(actor);
    await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      await requireUiDeliveryReady(tx);
    });
    const read = await readDeliveryJson(actor, projectId, fileId, files);
    return this.receiveInternal(actor, projectId, read.value, read.source);
  }
  private async fullItem(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    run: RunRow,
    item: ReturnType<typeof resultItemSchema.parse>,
    kind: 'result' | 'notExecuted',
  ) {
    const pending = (
      await tx.query(
        `SELECT d.id FROM app.ui_result_descriptors d WHERE d.run_id=$1 AND d.run_item_id=$2
      AND NOT EXISTS(SELECT 1 FROM app.ui_delivery_assemblies a WHERE a.descriptor_record_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM app.ui_result_descriptors n WHERE n.supersedes_descriptor_id=d.id)`,
        [run.id, item.runItemId],
      )
    ).rowCount;
    if (pending)
      return itemReceipt(
        kind,
        item.runItemId,
        item.runItemId,
        conflict('PENDING_DESCRIPTOR_EXISTS'),
      );
    return itemReceipt(
      kind,
      item.runItemId,
      item.runItemId,
      await appendUiOriginal(tx, actor, projectId, run.id, item),
    );
  }
  private async linkSource(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    run: RunRow,
    input: UiResultBatch,
    batchRecordId: string,
    source: DeliveryJsonSource,
    bumpArtifactVersion = true,
  ) {
    if (source.runId !== run.id)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        'v2原JSON资源必须绑定原run。',
        409,
      );
    const prior = (
      await tx.query(
        'SELECT 1 FROM app.ui_delivery_batch_sources WHERE batch_record_id=$1',
        [batchRecordId],
      )
    ).rowCount;
    if (prior) return;
    const valid = (
      await tx.query(
        "SELECT 1 FROM app.file_resources WHERE id=$1 AND project_id=$2 AND run_id=$3 AND status='verified' AND deleted_at IS NULL AND declared_sha256=$4 AND declared_bytes=$5 FOR SHARE",
        [source.fileId, projectId, run.id, source.sha256, String(source.bytes)],
      )
    ).rowCount;
    if (!valid)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原JSON资源已失效，未关联批次。',
        422,
      );
    await tx.query(
      'INSERT INTO app.ui_delivery_batch_sources(batch_record_id,project_id,run_id,owner_id,file_id,bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        batchRecordId,
        projectId,
        run.id,
        actor.userId,
        source.fileId,
        source.bytes,
        source.sha256,
      ],
    );
    await tx.query(
      "INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by) VALUES($1,$2,'uiResultBatch',$3,$4) ON CONFLICT DO NOTHING",
      [source.fileId, projectId, batchRecordId, actor.userId],
    );
    if (bumpArtifactVersion) {
      await tx.query(
        'UPDATE app.runs SET row_version=row_version+1 WHERE id=$1',
        [run.id],
      );
      await tx.query(
        'UPDATE app.ui_delivery_heads SET row_version=row_version+1,updated_at=clock_timestamp() WHERE run_id=$1',
        [run.id],
      );
    }
    const report = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.reports WHERE project_id=$1 AND run_id=$2',
        [projectId, run.id],
      )
    ).rows[0];
    if (report)
      await linkUiDeliverySourcesToReport(
        tx,
        actor.userId,
        projectId,
        run.id,
        report.id,
      );
    await audit(
      tx,
      actor,
      'results.ui-delivery-json-linked',
      run.id,
      projectId,
      {
        batchId: input.batchId,
        fileId: source.fileId,
        sha256: source.sha256,
        bytes: source.bytes,
      },
    );
  }
  private async descriptor(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    run: RunRow,
    batchId: string,
    input: UiResultDescriptor,
  ): Promise<ItemReceipt> {
    const digest = semanticDigest(input),
      prior = (
        await tx.query<DescriptorRow>(
          'SELECT * FROM app.ui_result_descriptors WHERE run_id=$1 AND descriptor_id=$2',
          [run.id, input.descriptorId],
        )
      ).rows[0];
    if (prior) {
      if (prior.semantic_digest !== digest)
        return itemReceipt(
          'descriptor',
          input.descriptorId,
          input.core.runItemId,
          conflict('IDEMPOTENCY_CONFLICT'),
          input.descriptorId,
        );
      const assembled = await this.assembly(
        tx,
        actor,
        projectId,
        run,
        batchId,
        prior,
      );
      return itemReceipt(
        'descriptor',
        input.descriptorId,
        input.core.runItemId,
        assembled,
        input.descriptorId,
      );
    }
    if (
      (
        await tx.query(
          'SELECT 1 FROM app.results WHERE run_id=$1 AND run_item_id=$2',
          [run.id, input.core.runItemId],
        )
      ).rowCount
    )
      return itemReceipt(
        'descriptor',
        input.descriptorId,
        input.core.runItemId,
        conflict('EXPLICIT_AMENDMENT_REQUIRED'),
        input.descriptorId,
      );
    const active = (
      await tx.query<DescriptorRow>(
        `SELECT d.* FROM app.ui_result_descriptors d WHERE d.run_id=$1 AND d.run_item_id=$2
      AND NOT EXISTS(SELECT 1 FROM app.ui_result_descriptors n WHERE n.supersedes_descriptor_id=d.id) ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
        [run.id, input.core.runItemId],
      )
    ).rows[0];
    if (active) {
      if (
        !input.supersedes ||
        input.supersedes.descriptorId !== active.descriptor_id ||
        input.supersedes.semanticDigest !== active.semantic_digest
      )
        return itemReceipt(
          'descriptor',
          input.descriptorId,
          input.core.runItemId,
          conflict('PENDING_DESCRIPTOR_EXISTS'),
          input.descriptorId,
        );
      if (input.supersedes.rowVersion !== run.row_version)
        return itemReceipt(
          'descriptor',
          input.descriptorId,
          input.core.runItemId,
          conflict('STALE_BASE_REVISION'),
          input.descriptorId,
        );
    } else if (input.supersedes)
      return itemReceipt(
        'descriptor',
        input.descriptorId,
        input.core.runItemId,
        conflict('DESCRIPTOR_BASE_MISSING'),
        input.descriptorId,
      );
    await tx.query('SAVEPOINT ui_delivery_descriptor');
    try {
      await this.policies.accept(tx, {
        ownerId: actor.userId,
        projectId,
        namespace: 'ui.descriptor',
        key: `${run.id}:${input.descriptorId}`,
        payloadDigest: digest,
        existing: false,
      });
      const row = (
        await tx.query<DescriptorRow>(
          `INSERT INTO app.ui_result_descriptors(project_id,run_id,owner_id,descriptor_id,batch_record_id,run_item_id,local_result_id,core,refs_count,segment_count,full_refs_digest,item_digest,semantic_digest,supersedes_descriptor_id,supersession_reason,superseded_digest,supersession_row_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [
            projectId,
            run.id,
            actor.userId,
            input.descriptorId,
            batchId,
            input.core.runItemId,
            input.core.localResultId,
            JSON.stringify(input.core),
            input.expectedRefCount,
            input.segmentCount,
            input.fullRefsDigest,
            input.itemDigest,
            digest,
            active?.id ?? null,
            input.supersedes?.reason ?? null,
            input.supersedes?.semanticDigest ?? null,
            input.supersedes?.rowVersion ?? null,
          ],
        )
      ).rows[0]!;
      const fact = await this.assembly(tx, actor, projectId, run, batchId, row);
      await tx.query('RELEASE SAVEPOINT ui_delivery_descriptor');
      return itemReceipt(
        'descriptor',
        input.descriptorId,
        input.core.runItemId,
        fact,
        input.descriptorId,
      );
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT ui_delivery_descriptor');
      await tx.query('RELEASE SAVEPOINT ui_delivery_descriptor');
      if (error instanceof DomainError)
        return itemReceipt(
          'descriptor',
          input.descriptorId,
          input.core.runItemId,
          conflict(error.code),
          input.descriptorId,
        );
      throw error;
    }
  }
  private async segment(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    run: RunRow,
    batchId: string,
    input: UiEvidenceRefSegment,
  ): Promise<ItemReceipt> {
    const key = `${input.descriptorId}:${input.segmentIndex}`,
      descriptor = (
        await tx.query<DescriptorRow>(
          'SELECT * FROM app.ui_result_descriptors WHERE run_id=$1 AND descriptor_id=$2',
          [run.id, input.descriptorId],
        )
      ).rows[0];
    if (!descriptor)
      return itemReceipt(
        'segment',
        key,
        null,
        conflict('DESCRIPTOR_NOT_FOUND'),
        input.descriptorId,
      );
    if (
      (
        await tx.query(
          'SELECT 1 FROM app.ui_result_descriptors WHERE supersedes_descriptor_id=$1',
          [descriptor.id],
        )
      ).rowCount
    )
      return itemReceipt(
        'segment',
        key,
        descriptor.run_item_id,
        conflict('DESCRIPTOR_SUPERSEDED'),
        input.descriptorId,
      );
    if (
      input.segmentIndex >= descriptor.segment_count ||
      input.startIndex + input.evidenceRefs.length > descriptor.refs_count
    )
      return itemReceipt(
        'segment',
        key,
        descriptor.run_item_id,
        conflict('SEGMENT_RANGE_MISMATCH'),
        input.descriptorId,
      );
    const prior = (
      await tx.query<{ semantic_digest: string }>(
        'SELECT semantic_digest FROM app.ui_result_ref_segments WHERE descriptor_record_id=$1 AND segment_index=$2',
        [descriptor.id, input.segmentIndex],
      )
    ).rows[0];
    if (prior) {
      if (prior.semantic_digest !== semanticDigest(input))
        return itemReceipt(
          'segment',
          key,
          descriptor.run_item_id,
          conflict('IDEMPOTENCY_CONFLICT'),
          input.descriptorId,
        );
      return itemReceipt(
        'segment',
        key,
        descriptor.run_item_id,
        await this.assembly(tx, actor, projectId, run, batchId, descriptor),
        input.descriptorId,
      );
    }
    const overlap = (
      await tx.query(
        `SELECT 1 FROM app.ui_result_ref_segments WHERE descriptor_record_id=$1 AND start_index<$2 AND start_index+jsonb_array_length(evidence_refs)>$3`,
        [
          descriptor.id,
          input.startIndex + input.evidenceRefs.length,
          input.startIndex,
        ],
      )
    ).rowCount;
    if (overlap)
      return itemReceipt(
        'segment',
        key,
        descriptor.run_item_id,
        conflict('SEGMENT_OVERLAP'),
        input.descriptorId,
      );
    await tx.query('SAVEPOINT ui_delivery_segment');
    try {
      await evidenceIdsForReferences(tx, run.id, input.evidenceRefs);
      await tx.query(
        'INSERT INTO app.ui_result_ref_segments(run_id,descriptor_record_id,batch_record_id,segment_index,start_index,evidence_refs,semantic_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          run.id,
          descriptor.id,
          batchId,
          input.segmentIndex,
          input.startIndex,
          JSON.stringify(input.evidenceRefs),
          semanticDigest(input),
        ],
      );
      const fact = await this.assembly(
        tx,
        actor,
        projectId,
        run,
        batchId,
        descriptor,
      );
      await tx.query('RELEASE SAVEPOINT ui_delivery_segment');
      return itemReceipt(
        'segment',
        key,
        descriptor.run_item_id,
        fact,
        input.descriptorId,
      );
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT ui_delivery_segment');
      await tx.query('RELEASE SAVEPOINT ui_delivery_segment');
      if (error instanceof DomainError)
        return itemReceipt(
          'segment',
          key,
          descriptor.run_item_id,
          conflict(error.code),
          input.descriptorId,
        );
      throw error;
    }
  }
  private async assembly(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    run: RunRow,
    batchId: string,
    descriptor: DescriptorRow,
  ): Promise<OriginalFactReceipt | null> {
    const prior = (
      await tx.query<{ result_id: string; result_revision_id: string }>(
        'SELECT result_id,result_revision_id FROM app.ui_delivery_assemblies WHERE descriptor_record_id=$1',
        [descriptor.id],
      )
    ).rows[0];
    if (prior)
      return {
        status: 'skipped',
        resultId: prior.result_id,
        revisionId: prior.result_revision_id,
        code: null,
        message: null,
      };
    const rows = (
      await tx.query<{
        segment_index: number;
        start_index: number;
        evidence_refs: string[];
      }>(
        'SELECT segment_index,start_index,evidence_refs FROM app.ui_result_ref_segments WHERE descriptor_record_id=$1 ORDER BY segment_index',
        [descriptor.id],
      )
    ).rows;
    if (rows.length !== descriptor.segment_count) return null;
    const refs: string[] = [];
    for (const [index, row] of rows.entries()) {
      if (row.segment_index !== index || row.start_index !== refs.length)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '结果引用片段存在空洞或顺序冲突。',
          409,
        );
      refs.push(...row.evidence_refs);
    }
    if (
      refs.length !== descriptor.refs_count ||
      new Set(refs).size !== refs.length ||
      semanticDigest(refs) !== descriptor.full_refs_digest
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '完整引用清单与原描述摘要不符。',
        409,
      );
    const item = resultItemSchema.parse({
      ...(descriptor.core as Record<string, unknown>),
      evidenceRefs: refs,
    });
    if (semanticDigest(item) !== descriptor.item_digest)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '完整原始结果与原描述语义摘要不符。',
        409,
      );
    const policy = await this.policies.read(tx, {
      ownerId: actor.userId,
      projectId,
      namespace: 'ui.descriptor',
      key: `${run.id}:${descriptor.descriptor_id}`,
      payloadDigest: descriptor.semantic_digest,
      existing: true,
    });
    await assertReferencedEvidenceFileBudget(
      tx,
      projectId,
      run.id,
      refs,
      policy,
    );
    const fact = await appendUiOriginal(tx, actor, projectId, run.id, item);
    if (fact.resultId && fact.revisionId && fact.status !== 'conflict')
      await tx.query(
        'INSERT INTO app.ui_delivery_assemblies(descriptor_record_id,run_id,run_item_id,result_id,result_revision_id,batch_record_id,full_refs_digest,item_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          descriptor.id,
          run.id,
          descriptor.run_item_id,
          fact.resultId,
          fact.revisionId,
          batchId,
          descriptor.full_refs_digest,
          descriptor.item_digest,
        ],
      );
    return fact;
  }
}
