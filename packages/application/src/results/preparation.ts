import { reportExecutionScopeSchema } from '../../../contracts/src/ui-archives.js';
import {
  resultSubmissionResourceSchema as resultSubmissionSchema,
  resultItemSchema,
} from '../../../contracts/src/domain.js';
import { resultPreparationSchema } from '../../../contracts/src/preparation.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, forbidden } from '../errors.js';
import { readRun, semanticDigest } from '../ui-executions/service.js';
import { canonicalJson } from '../operations/service.js';
import { assertSafeResultContent } from './safety.js';
import { missingFiles } from './evidence.js';
import { assertSubmissionFileBudget } from '../files/submission-budget.js';
import {
  fileResourcePolicies,
  fileIntentDigest,
  assertFilePolicyCounts,
  type FileResourcePolicies,
} from '../files/resource-policy.js';
import {
  uiDeliveryReady,
  uiDeliveryGate,
  deliveryMissingFiles,
  projectUiDelivery,
} from './delivery-state.js';

export async function prepareUiResults(
  db: Pick<Database, 'transaction'>,
  actor: ActorContext,
  projectId: string,
  raw: unknown,
  policies: FileResourcePolicies = fileResourcePolicies,
) {
  assertSafeResultContent(raw);
  const input = resultSubmissionSchema.parse(raw);
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'results.submit');
    const run = await readRun(tx, projectId, input.runId);
    if (run.kind !== 'UI' || run.created_by !== actor.userId) forbidden();
    const original = (
      await tx.query<{ semantic_digest: string }>(
        'SELECT semantic_digest FROM app.result_submissions WHERE run_id=$1 AND actor_id=$2 AND submission_id=$3',
        [run.id, actor.userId, input.submissionId],
      )
    ).rows[0];
    if (original && original.semantic_digest !== semanticDigest(input))
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '原提交标识已绑定不同载荷；不能借旧默认预检新内容。',
        409,
      );
    const existing = Boolean(original);
    const policy = await policies.read(tx, {
      ownerId: actor.userId,
      projectId,
      namespace: 'results.submit',
      key: input.submissionId,
      payloadDigest: fileIntentDigest(input),
      existing,
    });
    assertFilePolicyCounts(policy, input.evidenceManifest.length);
    if (
      (await uiDeliveryReady(tx)) &&
      (
        await tx.query('SELECT 1 FROM app.ui_delivery_heads WHERE run_id=$1', [
          run.id,
        ])
      ).rowCount
    ) {
      const original = (
        await tx.query<{ semantic_digest: string }>(
          'SELECT semantic_digest FROM app.result_submissions WHERE run_id=$1 AND actor_id=$2 AND submission_id=$3',
          [run.id, actor.userId, input.submissionId],
        )
      ).rows[0];
      if (original?.semantic_digest !== semanticDigest(input))
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '此run已启用v2；仅可预检原v1已存载荷，新增内容使用v2累计交付。',
          409,
        );
    }
    if (input.snapshotDigest !== run.scope_digest)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '结果不是基于此执行的固定范围。',
        409,
      );
    const scope = reportExecutionScopeSchema.parse(run.scope_snapshot),
      scopeIds = new Set(scope.items.map((item) => item.runItemId)),
      ids = [
        ...input.items.map((item) => item.runItemId),
        ...input.notExecutedItemIds,
      ];
    if (ids.some((id) => !scopeIds.has(id)))
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '结果包含固定范围以外的项。',
        409,
      );
    if (input.completion === 'complete' && ids.length !== scopeIds.size)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '完整提交须覆盖全部固定项，包括明确未执行项。',
        422,
      );
    await assertSubmissionFileBudget(
      tx,
      projectId,
      input.evidenceManifest.map((item) => item.fileId),
      policy,
    );
    const absent = new Set(await deliveryMissingFiles(tx, run.id));
    for (const item of input.evidenceManifest) {
      const file = (
        await tx.query<{
          declared_sha256: string;
          declared_bytes: string;
          run_id: string | null;
          status: string;
          deleted_at: Date | null;
        }>(
          "SELECT declared_sha256,declared_bytes::text,run_id,status,deleted_at FROM app.file_resources WHERE id=$1 AND project_id=$2 AND owner_scope='project'",
          [item.fileId, projectId],
        )
      ).rows[0];
      if (!file || file.deleted_at)
        throw new DomainError(
          'NOT_FOUND',
          '清单文件不在本项目可用登记中。',
          404,
        );
      if (file.run_id !== null && file.run_id !== run.id)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '证据文件属于另一执行。',
          409,
        );
      if (
        file.declared_sha256 !== item.sha256 ||
        file.declared_bytes !== item.bytes
      )
        throw new DomainError(
          'FILE_HASH_MISMATCH',
          '证据字节数或摘要与登记不一致。',
          409,
        );
      if (file.status !== 'verified') absent.add(item.fileId);
      const prior = (
        await tx.query<{ manifest: unknown }>(
          'SELECT manifest FROM app.run_evidence WHERE run_id=$1 AND local_evidence_id=$2',
          [run.id, item.localEvidenceId],
        )
      ).rows[0];
      if (prior && canonicalJson(prior.manifest) !== canonicalJson(item))
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原本地证据标识已绑定另一内容。',
          409,
        );
    }
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
      ],
      statuses: ReturnType<typeof resultPreparationSchema.parse>['items'] = [];
    for (const item of items) {
      const prior = (
        await tx.query<{ semantic_digest: string }>(
          'SELECT v.semantic_digest FROM app.results r JOIN app.result_revisions v ON v.id=r.current_revision_id WHERE r.run_id=$1 AND r.run_item_id=$2',
          [run.id, item.runItemId],
        )
      ).rows[0];
      const collision =
        !prior &&
        (
          await tx.query(
            'SELECT 1 FROM app.results WHERE run_id=$1 AND local_result_id=$2',
            [run.id, item.localResultId],
          )
        ).rowCount;
      if (prior)
        statuses.push({
          runItemId: item.runItemId,
          status:
            prior.semantic_digest === semanticDigest(item)
              ? 'skipped'
              : 'conflict',
          ...(prior.semantic_digest === semanticDigest(item)
            ? {}
            : { code: 'EXPLICIT_AMENDMENT_REQUIRED' }),
        });
      else
        statuses.push({
          runItemId: item.runItemId,
          status: collision ? 'conflict' : 'new',
          ...(collision ? { code: 'LOCAL_RESULT_ID_CONFLICT' } : {}),
        });
    }
    return resultPreparationSchema.parse({
      projectId,
      runId: run.id,
      submissionId: input.submissionId,
      semanticDigest: semanticDigest(input),
      snapshotDigest: run.scope_digest,
      items: statuses,
      missingFileIds: [...absent].sort(),
      scopeItems: scope.items.length,
      submittedItems: ids.length,
      readOnly: true,
    });
  });
}
export async function missingUiFiles(
  db: Pick<Database, 'transaction'>,
  actor: ActorContext,
  projectId: string,
  runId: string,
) {
  return db.transaction(async (tx) => {
    await requireProject(tx, actor, projectId, 'results.submit');
    const run = await readRun(tx, projectId, runId);
    if (run.kind !== 'UI' || run.created_by !== actor.userId) forbidden();
    const gate = await uiDeliveryGate(tx, run.id),
      missing = gate.versioned
        ? await deliveryMissingFiles(tx, run.id)
        : await missingFiles(tx, run.id);
    const count = gate.versioned
      ? Number(
          (
            await tx.query<{ count: string }>(
              'SELECT count(*)::text count FROM app.results WHERE run_id=$1',
              [run.id],
            )
          ).rows[0]?.count ?? '0',
        )
      : 0;
    return {
      runId,
      missingFileIds: missing,
      deliveryStatus:
        projectUiDelivery(
          gate,
          count,
          reportExecutionScopeSchema.parse(run.scope_snapshot).items.length,
          missing.length,
        ) ?? run.delivery_status,
    };
  });
}
