import { randomUUID, createHash } from 'node:crypto';
import {
  resultSubmissionResourceSchema as resultSubmissionSchema,
  resultSubmissionReceiptSchema,
  resultItemSchema,
  resultAmendmentSchema,
  executionScopeSchema,
} from '../../../contracts/src/domain.js';
import {
  finalAssessmentInputSchema,
  supplementaryEvidenceResourceInputSchema as supplementaryEvidenceInputSchema,
} from '../../../contracts/src/ui-results.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { DomainError, forbidden, stale } from '../errors.js';
import { audit } from '../events.js';
import { readRun, semanticDigest } from '../ui-executions/service.js';
import {
  registerEvidence,
  evidenceIdsForReferences,
  linkEvidence,
  missingFiles,
} from './evidence.js';
import { persistReportRevision } from '../reports/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import { assertSafeResultContent } from './safety.js';
import { ensureFailedProblemInTransaction } from '../issues/problems.js';
import type { FilesService } from '../files/service.js';
import { parseSafeResultJson } from './json-file.js';
import { prepareUiResults, missingUiFiles } from './preparation.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import { assertReferencedEvidenceFileBudget } from './submission-budget.js';
import {
  fileResourcePolicies,
  fileIntentDigest,
  assertFilePolicyCounts,
  type FileResourcePolicies,
} from '../files/resource-policy.js';
import { assertLocalUiActor } from './delivery-access.js';
import {
  assertV1UiWriteMode,
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
  bumpUiDeliveryRunMetadata,
} from './delivery-state.js';

interface ResultRow {
  id: string;
  run_id: string;
  run_item_id: string;
  local_result_id: string;
  current_revision_id: string;
  current_assessment_revision_id: string | null;
  content: unknown;
}
interface OriginalJson {
  fileId: string;
  sha256: string;
  bytes: number;
}

export class ResultService {
  private readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly policies: FileResourcePolicies = fileResourcePolicies,
  ) {
    this.operations = new OperationService(db);
  }
  prepareUi(actor: ActorContext, projectId: string, raw: unknown) {
    return prepareUiResults(this.db, actor, projectId, raw, this.policies);
  }
  missingUiFiles(actor: ActorContext, projectId: string, runId: string) {
    return missingUiFiles(this.db, actor, projectId, runId);
  }

  async submitUiFile(
    actor: ActorContext,
    projectId: string,
    fileId: string,
    files: FilesService,
  ) {
    assertLocalUiActor(actor);
    await this.db.transaction((tx) =>
      requireProject(tx, actor, projectId, 'results.submit'),
    );
    const metadata = (await files.metadata(actor, fileId)).file;
    if (metadata.ownerScope !== 'project' || metadata.projectId !== projectId)
      throw new DomainError('FORBIDDEN', '结果文件须属于此项目。', 403);
    if (
      metadata.mediaType !== 'application/json' ||
      BigInt(metadata.bytes) > 16n * 1024n * 1024n
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '结果文件须是至多16MiB的UTF-8 JSON。',
        400,
      );
    const downloaded = await files.download(actor, fileId);
    const chunks: Buffer[] = [];
    let length = 0;
    let input: unknown;
    try {
      for await (const chunk of downloaded.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 16 * 1024 * 1024)
          throw new Error('Result payload too large');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== Number(metadata.bytes) ||
        createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
      )
        throw new Error('Result bytes differ from verified registration');
      input = parseSafeResultJson(bytes);
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'VALIDATION_ERROR',
        '结果文件不能读取为完整UTF-8 JSON；请核对原资源状态和内容。',
        400,
      );
    } finally {
      downloaded.body.destroy();
    }
    const parsed = resultSubmissionSchema.parse(input);
    if (metadata.runId !== null && metadata.runId !== parsed.runId)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '结果JSON与文件登记的执行归属不一致。',
        409,
      );
    return this.submitUiInternal(actor, projectId, parsed, {
      fileId,
      sha256: metadata.sha256,
      bytes: length,
    });
  }

  async submitUi(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    return this.submitUiInternal(actor, projectId, raw);
  }
  private async bindOriginalJson(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    input: ReturnType<typeof resultSubmissionSchema.parse>,
    source: OriginalJson,
    receipt: ReturnType<typeof resultSubmissionReceiptSchema.parse>,
  ) {
    if (
      !receipt.reportId ||
      !receipt.perItemResults.some(
        (item) => item.status === 'accepted' || item.status === 'skipped',
      )
    )
      return;
    await requireProject(tx, actor, projectId, 'results.submit');
    const submission = (
      await tx.query<{ semantic_digest: string }>(
        'SELECT semantic_digest FROM app.result_submissions WHERE actor_id=$1 AND submission_id=$2 AND run_id=$3 FOR UPDATE',
        [actor.userId, input.submissionId, input.runId],
      )
    ).rows[0];
    if (!submission || submission.semantic_digest !== semanticDigest(input))
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '没有与该原JSON一致的已受理结果回执，不能伪造报告关联。',
        409,
      );
    if (
      (
        await tx.query(
          "SELECT 1 FROM app.audit_events WHERE action='results.original-json-linked' AND actor_id=$1 AND project_id=$2 AND object_id=$3 AND payload->>'submissionId'=$4 LIMIT 1",
          [actor.userId, projectId, receipt.reportId, input.submissionId],
        )
      ).rowCount
    )
      return;
    const policy = await this.policies.read(tx, {
      ownerId: actor.userId,
      projectId,
      namespace: 'results.submit',
      key: input.submissionId,
      payloadDigest: fileIntentDigest(input),
      existing: true,
    });
    assertFilePolicyCounts(policy, input.evidenceManifest.length);
    await assertSubmissionFileBudget(
      tx,
      projectId,
      [...input.evidenceManifest.map((item) => item.fileId), source.fileId],
      policy,
      'callerCounted',
    );
    const file = (
      await tx.query<{ declared_sha256: string; declared_bytes: string }>(
        "SELECT declared_sha256,declared_bytes::text FROM app.file_resources WHERE id=$1 AND project_id=$2 AND owner_scope='project' AND status='verified' AND deleted_at IS NULL AND (run_id IS NULL OR run_id=$3) FOR SHARE",
        [source.fileId, projectId, input.runId],
      )
    ).rows[0];
    if (
      !file ||
      file.declared_sha256 !== source.sha256 ||
      Number(file.declared_bytes) !== source.bytes
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '原JSON资源已失效或摘要变化，未绑定报告。',
        422,
      );
    if (
      !(
        await tx.query(
          'SELECT 1 FROM app.reports WHERE id=$1 AND project_id=$2 AND run_id=$3',
          [receipt.reportId, projectId, input.runId],
        )
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', '没有该项目执行报告。', 404);
    await tx.query(
      "INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by) VALUES($1,$2,'report',$3,$4) ON CONFLICT DO NOTHING",
      [source.fileId, projectId, receipt.reportId, actor.userId],
    );
    await audit(
      tx,
      actor,
      'results.original-json-linked',
      receipt.reportId,
      projectId,
      {
        fileId: source.fileId,
        sha256: source.sha256,
        bytes: source.bytes,
        submissionId: input.submissionId,
        runId: input.runId,
        resultsAccepted: receipt.resultsAccepted,
        hasConflicts: receipt.perItemResults.some(
          (item) => item.status === 'conflict',
        ),
      },
    );
  }
  private async submitUiInternal(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
    source?: OriginalJson,
  ) {
    assertSafeResultContent(raw);
    const input = resultSubmissionSchema.parse(raw);
    const digest = semanticDigest(input);
    let originalChecked = false;
    const receipt = await this.operations.execute(
      actor,
      'results.submit',
      input.submissionId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        const run = await readRun(tx, projectId, input.runId, true);
        if (run.kind !== 'UI' || run.created_by !== actor.userId) forbidden();
        await assertV1UiWriteMode(tx, run.id);
        if (input.snapshotDigest !== run.scope_digest)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '结果不是基于此执行的固定范围。',
            409,
          );
        const scope = executionScopeSchema.parse(run.scope_snapshot);
        const scopeIds = new Set(scope.items.map((item) => item.runItemId));
        const allIds = [
          ...input.items.map((item) => item.runItemId),
          ...input.notExecutedItemIds,
        ];
        if (allIds.some((id) => !scopeIds.has(id)))
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '结果包含固定范围以外的用例项；额外问题需使用独立问题记录。',
            409,
          );
        if (
          input.completion === 'complete' &&
          new Set(allIds).size !== scopeIds.size
        ) {
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '完整结束必须明确覆盖全部固定项，包含明确未执行的内容。',
            422,
          );
        }
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'results.submit',
          key: input.submissionId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        assertFilePolicyCounts(policy, input.evidenceManifest.length);
        await assertSubmissionFileBudget(
          tx,
          projectId,
          [
            ...input.evidenceManifest.map((item) => item.fileId),
            ...(source ? [source.fileId] : []),
          ],
          policy,
          'callerCounted',
        );
        await registerEvidence(
          tx,
          actor,
          projectId,
          run.id,
          input.evidenceManifest,
        );
        const items = [
          ...input.items,
          ...input.notExecutedItemIds.map((runItemId) =>
            resultItemSchema.parse({
              runItemId,
              localResultId: `notExecuted:${runItemId}`,
              originalOutcome: 'notExecuted',
              actualObservations: '客户端明确声明此固定项未执行。',
              reason: '未执行',
              sideEffectCertainty: 'notApplicable',
              evidenceRefs: [],
              endedAt: input.endedAt,
            }),
          ),
        ];
        const perItemResults: {
          objectId: string;
          status: 'accepted' | 'skipped' | 'conflict';
          revisionId?: string;
          code?: string;
          message?: string;
        }[] = [];
        let accepted = 0;
        for (const item of items) {
          const itemDigest = semanticDigest(item);
          const previous = (
            await tx.query<ResultRow & { semantic_digest: string }>(
              `SELECT r.*,v.content,v.semantic_digest FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id
             WHERE r.project_id=$1 AND r.run_id=$2 AND r.run_item_id=$3 FOR UPDATE OF r`,
              [projectId, run.id, item.runItemId],
            )
          ).rows[0];
          if (previous) {
            if (previous.semantic_digest === itemDigest)
              perItemResults.push({
                objectId: item.runItemId,
                status: 'skipped',
                revisionId: previous.current_revision_id,
                message: '此内容已接收，未重复生成结果。',
              });
            else
              perItemResults.push({
                objectId: item.runItemId,
                status: 'conflict',
                code: 'EXPLICIT_AMENDMENT_REQUIRED',
                message: '已有原始结果；更正须指明结果修订与原因。',
              });
            continue;
          }
          if (
            (
              await tx.query(
                'SELECT 1 FROM app.results WHERE run_id=$1 AND local_result_id=$2',
                [run.id, item.localResultId],
              )
            ).rowCount
          ) {
            perItemResults.push({
              objectId: item.runItemId,
              status: 'conflict',
              code: 'LOCAL_RESULT_ID_CONFLICT',
              message: '此执行的本地结果标识已用于另一项。',
            });
            continue;
          }
          const evidenceIds = await evidenceIdsForReferences(
            tx,
            run.id,
            item.evidenceRefs,
          );
          const id = randomUUID();
          const revisionId = randomUUID();
          await tx.query(
            'INSERT INTO app.results(id,project_id,run_id,run_item_id,local_result_id,current_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              id,
              projectId,
              run.id,
              item.runItemId,
              item.localResultId,
              revisionId,
              actor.userId,
            ],
          );
          await tx.query(
            'INSERT INTO app.result_revisions(id,result_id,revision_no,content,semantic_digest,actor_id) VALUES($1,$2,1,$3,$4,$5)',
            [revisionId, id, JSON.stringify(item), itemDigest, actor.userId],
          );
          await linkEvidence(tx, actor, id, evidenceIds, 'original');
          await ensureFailedProblemInTransaction(
            tx,
            actor,
            projectId,
            id,
            revisionId,
          );
          await tx.query(
            `UPDATE app.run_items SET state=$2,outcome=$3,side_effect_certainty=$4,started_at=$5,ended_at=$6 WHERE id=$1`,
            [
              item.runItemId,
              item.originalOutcome === 'notExecuted'
                ? 'notExecuted'
                : 'completed',
              item.originalOutcome,
              item.sideEffectCertainty,
              item.startedAt ?? null,
              item.endedAt ?? input.endedAt,
            ],
          );
          accepted++;
          perItemResults.push({
            objectId: item.runItemId,
            status: 'accepted',
            revisionId,
          });
        }
        const hasConflicts = perItemResults.some(
          (item) => item.status === 'conflict',
        );
        const receivedCount = Number(
          (
            await tx.query<{ count: string }>(
              'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
              [run.id],
            )
          ).rows[0]?.count ?? '0',
        );
        const state =
          accepted === 0
            ? run.state
            : receivedCount === scope.items.length &&
                !hasConflicts &&
                input.completion === 'complete'
              ? 'completed'
              : 'terminated';
        await tx.query(
          'UPDATE app.runs SET state=$2,ended_at=CASE WHEN $5 THEN $3::timestamptz ELSE ended_at END,delivery_status=$4,row_version=row_version+1 WHERE id=$1',
          [
            run.id,
            state,
            input.endedAt,
            receivedCount
              ? 'incomplete'
              : input.evidenceManifest.length
                ? 'receiving'
                : 'notSubmitted',
            accepted > 0,
          ],
        );
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          run.id,
          'result-submission',
        );
        const missingFileIds = await missingFiles(tx, run.id);
        const receipt = resultSubmissionReceiptSchema.parse({
          submissionId: input.submissionId,
          semanticDigest: digest,
          resultsAccepted: accepted,
          missingFileIds,
          deliveryStatus: receivedCount
            ? report.facts.deliveryStatus
            : input.evidenceManifest.length
              ? 'receiving'
              : 'notSubmitted',
          reportId: report.reportId,
          reportUrl: report.reportUrl,
          perItemResults,
        });
        await tx.query(
          'INSERT INTO app.result_submissions(run_id,actor_id,submission_id,semantic_digest,payload,receipt) VALUES($1,$2,$3,$4,$5,$6)',
          [
            run.id,
            actor.userId,
            input.submissionId,
            digest,
            JSON.stringify(input),
            JSON.stringify(receipt),
          ],
        );
        if (source) {
          await this.bindOriginalJson(
            tx,
            actor,
            projectId,
            input,
            source,
            receipt,
          );
          originalChecked = true;
        }
        if (accepted > 0)
          for (const versionId of new Set(
            scope.items.map((item) => item.requirementVersionId),
          ))
            await recordBusinessActivity(tx, projectId, versionId);
        await audit(tx, actor, 'results.submitted', run.id, projectId, {
          accepted,
          hasConflicts,
          deliveryStatus: receipt.deliveryStatus,
          reportId: receipt.reportId,
        });
        return receipt;
      },
      projectId,
    );
    // A direct-body submission may later deliver its first original file. The immutable receipt proves acceptance;
    // locking that submission and the first-link audit makes replay attach at most one original, without resubmitting facts.
    if (source && !originalChecked)
      await this.db.transaction((tx) =>
        this.bindOriginalJson(tx, actor, projectId, input, source, receipt),
      );
    return receipt;
  }

  async receipt(actor: ActorContext, projectId: string, submissionId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      const row = (
        await tx.query<{ receipt: unknown; run_id: string }>(
          `SELECT s.receipt,s.run_id FROM app.result_submissions s JOIN app.runs r ON r.id=s.run_id
         WHERE r.project_id=$1 AND s.actor_id=$2 AND s.submission_id=$3`,
          [projectId, actor.userId, submissionId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '没有此账号在本项目提交的回执。',
          404,
        );
      const run = await readRun(tx, projectId, row.run_id);
      const scope = executionScopeSchema.parse(run.scope_snapshot);
      const gate = await uiDeliveryGate(tx, run.id);
      const missingFileIds = gate.versioned
        ? await deliveryMissingFiles(tx, run.id)
        : await missingFiles(tx, run.id);
      const count = Number(
        (
          await tx.query<{ count: string }>(
            'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
            [run.id],
          )
        ).rows[0]?.count ?? '0',
      );
      return {
        receipt: resultSubmissionReceiptSchema.parse(row.receipt),
        currentDelivery: {
          missingFileIds,
          status:
            projectUiDelivery(
              gate,
              count,
              scope.items.length,
              missingFileIds.length,
            ) ??
            (count === scope.items.length && missingFileIds.length === 0
              ? 'complete'
              : 'incomplete'),
        },
      };
    });
  }

  async amend(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = resultAmendmentSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.amend',
      input.amendmentId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        const run = await readRun(tx, projectId, input.runId, true);
        if (run.kind !== 'UI')
          throw new DomainError(
            'FORBIDDEN',
            '平台接口原始采集事实不通过本地UI更正通道修改，请使用独立人工最终结论。',
            403,
          );
        const row = await this.result(tx, projectId, input.resultId, true);
        if (
          row.run_id !== input.runId ||
          row.run_item_id !== input.replacement.runItemId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '更正不能改变结果所属执行或范围项。',
            409,
          );
        if (row.current_revision_id !== input.baseResultRevisionId) stale();
        if (row.local_result_id !== input.replacement.localResultId)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '更正须保持本地结果标识。',
            409,
          );
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'results.amend',
          key: input.amendmentId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        await assertReferencedEvidenceFileBudget(
          tx,
          projectId,
          row.run_id,
          input.replacement.evidenceRefs,
          policy,
        );
        const evidenceIds = await evidenceIdsForReferences(
          tx,
          row.run_id,
          input.replacement.evidenceRefs,
        );
        const previous = (
          await tx.query<{ revision_no: number }>(
            'SELECT revision_no FROM app.result_revisions WHERE id=$1',
            [row.current_revision_id],
          )
        ).rows[0];
        const revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.result_revisions(id,result_id,revision_no,amendment_id,content,semantic_digest,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            revisionId,
            row.id,
            (previous?.revision_no ?? 0) + 1,
            input.amendmentId,
            JSON.stringify(input.replacement),
            semanticDigest(input.replacement),
            input.reason,
            actor.userId,
          ],
        );
        await tx.query(
          'UPDATE app.results SET current_revision_id=$2 WHERE id=$1',
          [row.id, revisionId],
        );
        await linkEvidence(tx, actor, row.id, evidenceIds, 'original');
        await ensureFailedProblemInTransaction(
          tx,
          actor,
          projectId,
          row.id,
          revisionId,
        );
        await tx.query(
          'UPDATE app.run_items SET outcome=$2,side_effect_certainty=$3,state=$4 WHERE id=$1',
          [
            row.run_item_id,
            input.replacement.originalOutcome,
            input.replacement.sideEffectCertainty,
            input.replacement.originalOutcome === 'notExecuted'
              ? 'notExecuted'
              : 'completed',
          ],
        );
        await bumpUiDeliveryRunMetadata(tx, row.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          row.run_id,
          'explicit-result-amendment',
        );
        await audit(tx, actor, 'results.amended', row.id, projectId, {
          revisionId,
        });
        return { resultId: row.id, revisionId, reportId: report.reportId };
      },
      projectId,
    );
  }

  async assess(
    actor: ActorContext,
    projectId: string,
    resultId: string,
    raw: unknown,
  ) {
    assertSafeResultContent(raw);
    const input = finalAssessmentInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.assess',
      input.commandId,
      { projectId, resultId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.assess');
      },
      async (tx) => {
        const unlocked = await this.result(tx, projectId, resultId);
        await readRun(tx, projectId, unlocked.run_id, true);
        const row = await this.result(tx, projectId, resultId, true);
        if (
          row.current_assessment_revision_id !== input.baseAssessmentRevisionId
        )
          stale();
        if (row.current_revision_id !== input.baseResultRevisionId) stale();
        const revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.result_assessments(id,result_id,result_revision_id,base_revision_id,final_outcome,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            revisionId,
            row.id,
            input.baseResultRevisionId,
            input.baseAssessmentRevisionId,
            input.finalOutcome,
            input.reason,
            actor.userId,
          ],
        );
        await tx.query(
          'UPDATE app.results SET current_assessment_revision_id=$2 WHERE id=$1',
          [row.id, revisionId],
        );
        await bumpUiDeliveryRunMetadata(tx, row.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          row.run_id,
          'manual-final-assessment',
        );
        await audit(tx, actor, 'results.assessed', row.id, projectId, {
          assessmentRevisionId: revisionId,
          finalOutcome: input.finalOutcome,
        });
        return {
          resultId,
          assessmentRevisionId: revisionId,
          reportId: report.reportId,
        };
      },
      projectId,
    );
  }

  async addEvidence(actor: ActorContext, projectId: string, raw: unknown) {
    const input = supplementaryEvidenceInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.evidence-addition',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        const initialRead = await this.result(tx, projectId, input.resultId);
        await readRun(tx, projectId, initialRead.run_id, true);
        const initial = await this.result(tx, projectId, input.resultId, true);
        const manifest = input.evidenceManifest.map((item) => ({
          ...item,
          source: 'manualAddition' as const,
        }));
        const policy = await this.policies.accept(tx, {
          ownerId: actor.userId,
          projectId,
          namespace: 'results.evidence-addition',
          key: input.commandId,
          payloadDigest: fileIntentDigest(input),
          existing: false,
        });
        assertFilePolicyCounts(policy, manifest.length);
        await assertSubmissionFileBudget(
          tx,
          projectId,
          manifest.map((item) => item.fileId),
          policy,
        );
        const evidence = await registerEvidence(
          tx,
          actor,
          projectId,
          initial.run_id,
          manifest,
        );
        const cumulative = (
          await tx.query<{ file_id: string; id: string }>(
            `SELECT e.id,e.file_id FROM app.run_evidence e WHERE e.run_id=$1 AND (e.id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM app.result_evidence_links l WHERE l.result_id=$3 AND l.evidence_id=e.id)) ORDER BY e.id FOR SHARE`,
            [initial.run_id, [...evidence.values()], initial.id],
          )
        ).rows;
        if (cumulative.length > 1000)
          throw new DomainError(
            'FILE_TOO_LARGE',
            '单结果累计证据身份超过1000项结构范围。',
            413,
          );
        await assertSubmissionFileBudget(
          tx,
          projectId,
          cumulative.map((row) => row.file_id),
          policy,
          'case',
        );
        const linkedBefore = new Set(
          (
            await tx.query<{ evidence_id: string }>(
              'SELECT evidence_id FROM app.result_evidence_links WHERE result_id=$1 AND evidence_id=ANY($2::uuid[])',
              [initial.id, [...evidence.values()]],
            )
          ).rows.map((item) => item.evidence_id),
        );
        await linkEvidence(
          tx,
          actor,
          initial.id,
          [...evidence.values()],
          'manualAddition',
        );
        if ([...evidence.values()].some((id) => !linkedBefore.has(id)))
          await bumpUiDeliveryRunMetadata(tx, initial.run_id);
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          initial.run_id,
          'manual-evidence-addition',
        );
        await audit(
          tx,
          actor,
          'results.evidence-added',
          initial.id,
          projectId,
          { count: evidence.size },
        );
        return {
          resultId: initial.id,
          evidenceAdded: evidence.size,
          resultRevisionId: initial.current_revision_id,
          reportId: report.reportId,
        };
      },
      projectId,
    );
  }

  async detail(actor: ActorContext, projectId: string, resultId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const result = await this.result(tx, projectId, resultId);
      const history = await tx.query<{
        id: string;
        revision_no: number;
        content: unknown;
        reason: string | null;
        actor_id: string;
        created_at: Date;
      }>(
        'SELECT id,revision_no,content,reason,actor_id,created_at FROM app.result_revisions WHERE result_id=$1 ORDER BY revision_no DESC',
        [resultId],
      );
      const assessments = await tx.query<{
        id: string;
        final_outcome: string;
        reason: string;
        actor_id: string;
        created_at: Date;
      }>(
        'SELECT id,final_outcome,reason,actor_id,created_at FROM app.result_assessments WHERE result_id=$1 ORDER BY created_at DESC,id',
        [resultId],
      );
      const evidence = await tx.query<{
        id: string;
        file_id: string;
        manifest: unknown;
        source: string;
      }>(
        `SELECT e.id,e.file_id,e.manifest,l.source FROM app.result_evidence_links l JOIN app.run_evidence e ON e.id=l.evidence_id
         WHERE l.result_id=$1 ORDER BY l.created_at,e.id`,
        [resultId],
      );
      return {
        result: {
          id: result.id,
          runId: result.run_id,
          runItemId: result.run_item_id,
          revisionId: result.current_revision_id,
          assessmentRevisionId: result.current_assessment_revision_id,
          content: resultItemSchema.parse(result.content),
          history: history.rows.map((row) => ({
            id: row.id,
            revisionNo: row.revision_no,
            content: resultItemSchema.parse(row.content),
            reason: row.reason,
            actorId: row.actor_id,
            createdAt: row.created_at.toISOString(),
          })),
          assessments: assessments.rows.map((row) => ({
            id: row.id,
            finalOutcome: row.final_outcome,
            reason: row.reason,
            actorId: row.actor_id,
            createdAt: row.created_at.toISOString(),
          })),
          evidence: evidence.rows.map((row) => ({
            id: row.id,
            fileId: row.file_id,
            manifest: row.manifest,
            source: row.source,
          })),
        },
      };
    });
  }

  private async result(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    lock = false,
  ): Promise<ResultRow> {
    const row = (
      await tx.query<ResultRow>(
        `SELECT r.*,v.content FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id
       WHERE r.project_id=$1 AND r.id=$2${lock ? ' FOR UPDATE OF r' : ''}`,
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该结果。', 404);
    return row;
  }
}

/**
 * Trusted API-worker archival port only; never register as an HTTP/MCP/AI command.
 * The control plane validates its run grant and source attempt. Already-sent facts must
 * remain recordable after revocation, so this does not require the old actor to stay active.
 */
export async function recordApiCaseInTransaction(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  runItemId: string,
  raw: unknown,
) {
  assertSafeResultContent(raw);
  const item = resultItemSchema.parse(raw);
  const run = await readRun(tx, projectId, runId, true);
  if (
    run.kind !== 'API' ||
    run.created_by !== actor.userId ||
    item.runItemId !== runItemId
  ) {
    throw new DomainError(
      'BUSINESS_CONFLICT',
      '接口事实归属与受控执行不一致。',
      409,
    );
  }
  if (!['passed', 'failed', 'notExecuted'].includes(item.originalOutcome))
    throw new DomainError(
      'VALIDATION_ERROR',
      '接口原始结论仅通过/失败/未执行。',
      400,
    );
  const target = (
    await tx.query(
      'SELECT 1 FROM app.run_items WHERE project_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',
      [projectId, runId, runItemId],
    )
  ).rowCount;
  if (!target)
    throw new DomainError('NOT_FOUND', '没有此固定接口执行项。', 404);
  const digest = semanticDigest(item);
  const previous = (
    await tx.query<{
      id: string;
      current_revision_id: string;
      semantic_digest: string;
    }>(
      `SELECT r.id,r.current_revision_id,v.semantic_digest FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id
     WHERE r.run_item_id=$1`,
      [runItemId],
    )
  ).rows[0];
  if (previous) {
    if (previous.semantic_digest !== digest)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '接口原始事实已落盘，未知窗口不得以新回执覆盖或重放。',
        409,
      );
    return {
      resultId: previous.id,
      revisionId: previous.current_revision_id,
      replayed: true,
    };
  }
  const evidenceIds = await evidenceIdsForReferences(
    tx,
    runId,
    item.evidenceRefs,
  );
  const resultId = randomUUID();
  const revisionId = randomUUID();
  await tx.query(
    'INSERT INTO app.results(id,project_id,run_id,run_item_id,local_result_id,current_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      resultId,
      projectId,
      runId,
      runItemId,
      item.localResultId,
      revisionId,
      actor.userId,
    ],
  );
  await tx.query(
    'INSERT INTO app.result_revisions(id,result_id,revision_no,content,semantic_digest,actor_id) VALUES($1,$2,1,$3,$4,$5)',
    [revisionId, resultId, JSON.stringify(item), digest, actor.userId],
  );
  await linkEvidence(tx, actor, resultId, evidenceIds, 'original');
  await ensureFailedProblemInTransaction(
    tx,
    actor,
    projectId,
    resultId,
    revisionId,
  );
  await tx.query(
    'UPDATE app.run_items SET outcome=$2,side_effect_certainty=$3,state=$4,ended_at=$5 WHERE id=$1',
    [
      runItemId,
      item.originalOutcome,
      item.sideEffectCertainty,
      item.originalOutcome === 'notExecuted' ? 'notExecuted' : 'completed',
      item.endedAt ?? null,
    ],
  );
  await tx.query(
    "UPDATE app.runs SET execution_provenance='platform-api' WHERE id=$1",
    [runId],
  );
  await audit(tx, actor, 'results.api-fact-recorded', resultId, projectId, {
    runId,
    runItemId,
  });
  return { resultId, revisionId, replayed: false };
}
