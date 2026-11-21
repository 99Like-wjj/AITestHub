import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  uiArchiveInputSchema,
  uiArchiveCommitSchema,
  uiArchivePreviewSchema,
  uiArchiveReceiptSchema,
  uiArchiveResultReceiptSchema,
  uiArchiveResultSubmissionSchema,
  uiArchiveScopeSchema,
} from '../../../contracts/src/ui-archives.js';
import {
  perItemResultSchema,
  resultSubmissionReceiptSchema,
} from '../../../contracts/src/domain.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { assertSafeResultContent } from '../results/safety.js';
import { assertLocalUiActor } from '../results/delivery-access.js';
import { assertResultStepEvidenceReferences } from '../results/result-scope.js';
import { DomainError, forbidden } from '../errors.js';
import { audit } from '../events.js';
import { readRun, semanticDigest } from './service.js';
import {
  linkEvidence,
  missingFiles,
  registerEvidence,
} from '../results/evidence.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import {
  assertFilePolicyCounts,
  fileIntentDigest,
  fileResourcePolicies,
  type FileResourcePolicies,
} from '../files/resource-policy.js';
import { persistReportRevision } from '../reports/service.js';

type ArchiveInput = z.infer<typeof uiArchiveInputSchema>;
async function inspectArchive(
  tx: SqlExecutor,
  projectId: string,
  input: ArchiveInput,
) {
  const environment = (
    await tx.query<{ id: string; revisionId: string; name: string }>(
      `SELECT c.id,r.id "revisionId",r.content->>'name' name
    FROM app.test_configurations c JOIN app.test_configuration_revisions r ON r.id=c.current_revision_id
    WHERE c.project_id=$1 AND c.id=$2 AND c.kind='environment'`,
      [projectId, input.environmentId],
    )
  ).rows[0];
  if (!environment)
    throw new DomainError('NOT_FOUND', '请从所属项目选择实际执行环境。', 404);
  const rows = input.items.map(
    ({ localItemId, requirementId, requirementVersionId, caseReference }) => ({
      localItemId,
      requirementId,
      requirementVersionId,
      caseId: caseReference?.caseId ?? null,
      revisionId: caseReference?.revisionId ?? null,
    }),
  );
  const matches = (
    await tx.query<{
      localItemId: string;
      requirementTitle: string | null;
      versionExists: boolean;
      match: boolean;
    }>(
      `SELECT x."localItemId",q.title "requirementTitle",
      x."requirementVersionId" IS NULL OR v.id IS NOT NULL "versionExists", a.id IS NOT NULL AND av.id IS NOT NULL "match"
    FROM jsonb_to_recordset($2::jsonb) x("localItemId" text,"requirementId" uuid,
      "requirementVersionId" uuid,"caseId" uuid,"revisionId" uuid)
    LEFT JOIN app.requirements q ON q.project_id=$1 AND q.id=x."requirementId"
    LEFT JOIN app.requirement_versions v ON v.project_id=$1 AND v.requirement_id=q.id AND v.id=x."requirementVersionId"
    LEFT JOIN app.test_assets a ON a.project_id=$1 AND a.kind='UI' AND a.target_type='case' AND a.requirement_version_id=v.id AND a.id=x."caseId"
    LEFT JOIN app.asset_revisions av ON av.project_id=$1 AND av.asset_id=a.id AND av.id=x."revisionId"`,
      [projectId, JSON.stringify(rows)],
    )
  ).rows;
  const byId = new Map(matches.map((row) => [row.localItemId, row]));
  const items = input.items.map((item) => {
    const match = byId.get(item.localItemId);
    if (!match?.requirementTitle || !match.versionExists)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        `归档项 ${item.localItemId} 的需求或版本归属无效。`,
        422,
      );
    return {
      ...item,
      requirementTitle: match.requirementTitle,
      matched: match.match,
      matchReason:
        item.caseReference && !match.match
          ? '用例或修订与需求版本不匹配，按本地条目归档。'
          : null,
    };
  });
  return uiArchivePreviewSchema.parse({
    environment,
    items,
    previewDigest: semanticDigest({ input, environment, items }),
  });
}

export class UiArchiveService {
  private readonly operations: OperationService;
  constructor(
    private readonly db: Database,
    private readonly policies: FileResourcePolicies = fileResourcePolicies,
  ) {
    this.operations = new OperationService(db);
  }
  async preview(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiArchiveInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      return inspectArchive(tx, projectId, input);
    });
  }
  async receipt(actor: ActorContext, projectId: string, commandId: string) {
    const { command } = await this.operations.get(actor, {
      operation: 'results.ui-archive.create',
      key: commandId,
    });
    if (command.projectId !== projectId || command.status !== 'completed')
      throw new DomainError('NOT_FOUND', '尚未取得本项目的原归档回执。', 404);
    return uiArchiveReceiptSchema.parse(command.response);
  }

  private async registeredScope(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    runId: string,
    lock: boolean | 'share',
  ) {
    const run = await readRun(tx, projectId, runId, lock);
    if (
      run.source !== 'uiArchive' ||
      run.kind !== 'UI' ||
      run.created_by !== actor.userId
    )
      forbidden();
    const scope = uiArchiveScopeSchema.parse(run.scope_snapshot);
    if (
      scope.runId !== run.id ||
      scope.projectId !== projectId ||
      scope.snapshotDigest !== run.scope_digest
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '归档执行与固定范围不一致。',
        409,
      );
    return scope;
  }

  /** Publish only actual results of an explicitly registered independent archive. */
  async submitResults(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const input = uiArchiveResultSubmissionSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.ui-archive.submit',
      input.submissionId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        const scope = await this.registeredScope(
          tx,
          actor,
          projectId,
          input.runId,
          true,
        );
        const declared = new Map(
          scope.items.map((item) => [item.runItemId, item.declaredOutcome]),
        );
        if (
          Date.parse(input.endedAt) !== Date.parse(scope.endedAt) ||
          input.snapshotDigest !== scope.snapshotDigest ||
          input.items.some(
            (item) => declared.get(item.runItemId) !== item.originalOutcome,
          )
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '归档结果须匹配登记的范围、结束时间及结论。',
            409,
          );
        if (input.items.length !== declared.size)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '归档须明确提交全部登记项，包含已登记的未执行项。',
            422,
          );
        for (const item of input.items)
          assertResultStepEvidenceReferences(item);

        // The prior table also contains historical V1 receipts. Never repurpose an old submission ID.
        if (
          (
            await tx.query(
              'SELECT 1 FROM app.result_submissions WHERE actor_id=$1 AND submission_id=$2',
              [actor.userId, input.submissionId],
            )
          ).rowCount
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '提交标识已有历史回执，请先核对原结果。',
            409,
          );

        const originals = new Map(
          (
            await tx.query<{
              run_item_id: string;
              revision_id: string;
              semantic_digest: string;
            }>(
              `SELECT r.run_item_id,v.id revision_id,v.semantic_digest
           FROM app.results r JOIN app.result_revisions v ON v.result_id=r.id AND v.revision_no=1
           WHERE r.project_id=$1 AND r.run_id=$2`,
              [projectId, input.runId],
            )
          ).rows.map((row) => [row.run_item_id, row]),
        );
        const ordered = input.items.map((item) => ({
          item,
          digest: semanticDigest(item),
        }));
        if (
          ordered.some(({ item, digest }) => {
            const original = originals.get(item.runItemId);
            return original && original.semantic_digest !== digest;
          })
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '已有不同的原始归档结果；更正须指明原修订和原因。',
            409,
          );

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
          input.evidenceManifest.map((entry) => entry.fileId),
          policy,
          'callerCounted',
        );
        const evidence = await registerEvidence(
          tx,
          actor,
          projectId,
          input.runId,
          input.evidenceManifest,
        );
        const perItemResults: z.infer<typeof perItemResultSchema>[] = [];
        let accepted = 0;
        for (const { item, digest } of ordered) {
          const original = originals.get(item.runItemId);
          if (original) {
            perItemResults.push({
              objectId: item.runItemId,
              status: 'skipped',
              revisionId: original.revision_id,
            });
            continue;
          }
          const resultId = randomUUID(),
            revisionId = randomUUID();
          await tx.query(
            `INSERT INTO app.results(id,project_id,run_id,run_item_id,local_result_id,current_revision_id,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              resultId,
              projectId,
              input.runId,
              item.runItemId,
              item.localResultId,
              revisionId,
              actor.userId,
            ],
          );
          await tx.query(
            `INSERT INTO app.result_revisions(id,result_id,revision_no,content,semantic_digest,actor_id)
             VALUES($1,$2,1,$3,$4,$5)`,
            [revisionId, resultId, JSON.stringify(item), digest, actor.userId],
          );
          const fileLinks = item.evidenceRefs.map((id) => {
            const link = evidence.get(id);
            if (!link)
              throw new Error('Validated archive evidence was not registered');
            return link;
          });
          await linkEvidence(tx, actor, resultId, fileLinks, 'original');
          await tx.query(
            `UPDATE app.run_items SET state=$4,outcome=$5,side_effect_certainty=$6,started_at=$7,ended_at=$8
             WHERE id=$1 AND run_id=$2 AND project_id=$3`,
            [
              item.runItemId,
              input.runId,
              projectId,
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
        // Do not advance formal execution, create approval or generate a candidate automatically.
        if (accepted)
          await tx.query(
            'UPDATE app.runs SET row_version=row_version+1 WHERE id=$1',
            [input.runId],
          );
        const report = await persistReportRevision(
          tx,
          actor,
          projectId,
          input.runId,
          'independent-ui-archive-results',
        );
        const digest = semanticDigest(input);
        const receipt = resultSubmissionReceiptSchema.parse({
          submissionId: input.submissionId,
          semanticDigest: digest,
          resultsAccepted: accepted,
          missingFileIds: report.facts.missingFileIds,
          deliveryStatus: report.facts.deliveryStatus,
          reportId: report.reportId,
          reportUrl: report.reportUrl,
          perItemResults,
        });
        await tx.query(
          'INSERT INTO app.result_submissions(run_id,actor_id,submission_id,semantic_digest,payload,receipt) VALUES($1,$2,$3,$4,$5,$6)',
          [
            input.runId,
            actor.userId,
            input.submissionId,
            digest,
            JSON.stringify(input),
            JSON.stringify(receipt),
          ],
        );
        await audit(
          tx,
          actor,
          'results.ui-archive.submitted',
          input.runId,
          projectId,
          {
            submissionId: input.submissionId,
            reportId: receipt.reportId,
            accepted,
            deliveryStatus: receipt.deliveryStatus,
          },
        );
        return receipt;
      },
      projectId,
    );
  }

  async resultReceipt(
    actor: ActorContext,
    projectId: string,
    runId: string,
    submissionId: string,
  ) {
    assertLocalUiActor(actor);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'results.submit');
      const scope = await this.registeredScope(
        tx,
        actor,
        projectId,
        runId,
        'share',
      );
      const row = (
        await tx.query<{ receipt: unknown }>(
          'SELECT receipt FROM app.result_submissions WHERE run_id=$1 AND actor_id=$2 AND submission_id=$3',
          [runId, actor.userId, submissionId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得此独立归档结果的原提交回执。',
          404,
        );
      const count =
        (
          await tx.query<{ rows: number }>(
            'SELECT count(*)::integer rows FROM app.results WHERE project_id=$1 AND run_id=$2',
            [projectId, runId],
          )
        ).rows[0]?.rows ?? 0;
      const missingFileIds = await missingFiles(tx, runId);
      return uiArchiveResultReceiptSchema.parse({
        receipt: row.receipt,
        currentDelivery: {
          missingFileIds,
          status:
            count === scope.items.length && !missingFileIds.length
              ? 'complete'
              : 'incomplete',
        },
      });
    });
  }

  async commit(actor: ActorContext, projectId: string, raw: unknown) {
    assertLocalUiActor(actor);
    assertSafeResultContent(raw);
    const { commandId, input, previewDigest } =
      uiArchiveCommitSchema.parse(raw);
    return this.operations.execute(
      actor,
      'results.ui-archive.create',
      commandId,
      { projectId, input, previewDigest },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'results.submit');
      },
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify([
            'uiArchive',
            projectId,
            actor.userId,
            input.localExecutionId,
          ]),
        ]);
        const digest = semanticDigest(input);
        const existing = (
          await tx.query<{
            id: string;
            scope_snapshot: unknown;
            digest: string;
          }>(
            `SELECT id,scope_snapshot,internal_configuration->>'archiveInputDigest' digest
          FROM app.runs WHERE project_id=$1 AND created_by=$2 AND source='uiArchive' AND local_execution_id=$3`,
            [projectId, actor.userId, input.localExecutionId],
          )
        ).rows[0];
        if (existing) {
          if (existing.digest !== digest)
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              '此本地执行身份已绑定另一份归档范围，请核对原记录。',
              409,
            );
          return uiArchiveReceiptSchema.parse({
            runId: existing.id,
            scope: existing.scope_snapshot,
          });
        }
        const preview = await inspectArchive(tx, projectId, input);
        if (preview.previewDigest !== previewDigest)
          throw new DomainError(
            'STALE_BASE_REVISION',
            '归档环境或引用已变化，重新预览后确认。',
            412,
          );
        const runId = randomUUID();
        const scopeFields = {
          schemaVersion: 'ath.ui-archive-scope.v1',
          sourceType: 'uiArchive',
          kind: 'UI',
          sourceRevisionId: runId,
          runId,
          projectId,
          title: input.title,
          localExecutionId: input.localExecutionId,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          environmentId: input.environmentId,
          environmentRevisionId: preview.environment.revisionId,
          productBuild: input.productBuild,
          items: preview.items.map((item, ordinal) => ({
            runItemId: randomUUID(),
            localItemId: item.localItemId,
            requirementId: item.requirementId,
            requirementVersionId: item.requirementVersionId,
            caseId: item.matched ? item.caseReference?.caseId : null,
            caseRevisionId: item.matched
              ? item.caseReference?.revisionId
              : null,
            approvalSnapshotId: null,
            scenario: { title: item.scenario },
            content: { kind: 'UI', title: item.title },
            ordinal,
            declaredOutcome: item.originalOutcome,
            issueIds: [],
          })),
        };
        const scope = uiArchiveScopeSchema.parse({
          ...scopeFields,
          snapshotDigest: semanticDigest(scopeFields),
        });
        await tx.query(
          `INSERT INTO app.runs(id,run_snapshot_id,project_id,kind,source,source_revision_id,environment_id,
          environment_revision_id,product_build,created_by,state,scope_snapshot,scope_digest,internal_configuration,
          local_execution_id,execution_provenance,started_at,ended_at)
          VALUES($1,$2,$3,'UI','uiArchive',$1,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13,$14)`,
          [
            runId,
            randomUUID(),
            projectId,
            input.environmentId,
            preview.environment.revisionId,
            input.productBuild,
            actor.userId,
            JSON.stringify(scope),
            scope.snapshotDigest,
            JSON.stringify({ archiveInputDigest: digest }),
            input.localExecutionId,
            input.executionProvenance,
            input.startedAt,
            input.endedAt,
          ],
        );
        for (const item of scope.items)
          await tx.query(
            `INSERT INTO app.run_items(id,project_id,run_id,ordinal,case_id,approval_snapshot_id,snapshot)
            VALUES($1,$2,$3,$4,$5,NULL,$6)`,
            [
              item.runItemId,
              projectId,
              runId,
              item.ordinal,
              item.caseId,
              JSON.stringify(item),
            ],
          );
        await audit(tx, actor, 'run.ui-archive.registered', runId, projectId, {
          items: scope.items.length,
        });
        return uiArchiveReceiptSchema.parse({ runId, scope });
      },
      projectId,
    );
  }
}
