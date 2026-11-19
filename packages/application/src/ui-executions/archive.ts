import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  uiArchiveInputSchema,
  uiArchiveCommitSchema,
  uiArchivePreviewSchema,
  uiArchiveReceiptSchema,
  uiArchiveScopeSchema,
} from '../../../contracts/src/ui-archives.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { assertSafeResultContent } from '../results/safety.js';
import { assertLocalUiActor } from '../results/delivery-access.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { semanticDigest } from './service.js';

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
  constructor(private readonly db: Database) {
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
