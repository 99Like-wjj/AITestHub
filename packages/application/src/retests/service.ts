import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  prepareRetestInputSchema,
  retestGroupTemplateSchema,
  retestPreparationSchema,
  startApiRetestInputSchema,
} from '../../../contracts/src/retests.js';
import {
  executionScopeSchema,
  scopeItemSchema,
  scenarioContentSchema,
  uiCaseContentSchema,
} from '../../../contracts/src/domain.js';
import { reportScopeItemSchema } from '../../../contracts/src/ui-archives.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { getAsset } from '../assets/repository.js';
import {
  getApiProjectAsset,
  getApiProjectCase,
} from '../assets/api-automation.js';
import { OperationService, canonicalJson } from '../operations/service.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { issueRow, lockIssueProject } from '../issues/common.js';
import { assertSafeResultContent } from '../results/safety.js';
import type { PlanService } from '../plans/service.js';
import { associateRetestRun } from './preparation.js';

type Template = z.infer<typeof retestGroupTemplateSchema>;
const semanticDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
interface GroupRow {
  id: string;
  public_snapshot: unknown;
  internal_configuration: unknown;
  preparation_id: string;
  preparation_revision_id: string;
}
export class RetestService {
  readonly operations: OperationService;
  constructor(
    readonly db: Database,
    readonly plans: PlanService,
  ) {
    this.operations = new OperationService(db);
  }
  associateRun(
    actor: ActorContext,
    projectId: string,
    groupId: string,
    raw: unknown,
  ) {
    return associateRetestRun(this.db, this, actor, projectId, groupId, raw);
  }
  async prepare(actor: ActorContext, projectId: string, raw: unknown) {
    assertSafeResultContent(raw);
    const input = prepareRetestInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'retests.prepare',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'runs.organize');
        await lockIssueProject(tx, projectId);
      },
      async (tx) => {
        const groups = new Map<
          string,
          { scope: Template; configurations: Map<string, unknown> }
        >();
        const missing: { code: string; objectId: string; message: string }[] =
          [];
        for (const selected of input.selections) {
          const issue = await issueRow(tx, projectId, selected.issueId);
          if (issue.row_version !== selected.rowVersion) stale();
          const sources = (
            await tx.query<{ snapshot: unknown; run_id: string }>(
              `SELECT ri.snapshot,r.run_id FROM app.issue_result_links l
     JOIN app.results r ON r.id=l.result_id JOIN app.run_items ri ON ri.id=r.run_item_id
     WHERE l.project_id=$1 AND l.issue_id=$2 ORDER BY r.run_id,ri.ordinal`,
              [projectId, issue.id],
            )
          ).rows;
          const sourceItems = sources
            .map((s) => ({
              item: reportScopeItemSchema.parse(s.snapshot),
              runId: s.run_id,
            }))
            .filter((s) => s.item.content.kind === selected.kind);
          const originalVersion =
            issue.requirement_version_id ??
            (new Set(sourceItems.map((s) => s.item.requirementVersionId))
              .size === 1
              ? sourceItems[0]?.item.requirementVersionId
              : null);
          const versionId = selected.requirementVersionId ?? originalVersion;
          const gap = (code: string, message: string) =>
            missing.push({ code, objectId: issue.id, message });
          if (!versionId) {
            gap(
              'REQUIREMENT_VERSION_REQUIRED',
              '此缺陷没有唯一原需求版本；请明确选择需求版本和相关用例或场景。',
            );
            continue;
          }
          if (
            !(
              await tx.query(
                'SELECT 1 FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2 AND id=$3',
                [projectId, issue.requirement_id, versionId],
              )
            ).rowCount
          )
            throw new DomainError(
              'NOT_FOUND',
              '复测需求版本不属于此缺陷对应需求。',
              404,
            );
          const explicit =
            (selected.caseIds?.length ?? 0) > 0 ||
            (selected.scenarioIds?.length ?? 0) > 0;
          if (versionId !== originalVersion && !explicit) {
            gap(
              'NEW_VERSION_MAPPING_REQUIRED',
              '切换需求版本须明确选择新版本中的相关用例或场景，不按名称自动映射。',
            );
            continue;
          }
          const related = sourceItems.filter(
            (s) => s.item.requirementVersionId === versionId,
          );
          let caseIds: string[];
          if (selected.level === 'scenario') {
            const scenarioIds = selected.scenarioIds ?? [
              ...new Set(
                related.flatMap((s) =>
                  'scenarioId' in s.item && s.item.scenarioId
                    ? [s.item.scenarioId]
                    : [],
                ),
              ),
            ];
            if (selected.caseIds?.length)
              throw new DomainError(
                'VALIDATION_ERROR',
                '场景级复测须选择场景，不以用例列表隐式改变层级。',
                400,
              );
            for (const sid of scenarioIds) {
              if (selected.kind === 'API') {
                const a = await getApiProjectAsset(tx, projectId, sid);
                if (
                  a.targetType !== 'scenario' ||
                  (a.requirementVersionId !== null &&
                    a.requirementVersionId !== versionId)
                )
                  throw new DomainError(
                    'BUSINESS_CONFLICT',
                    '接口场景与所选需求版本不一致。',
                    409,
                  );
                continue;
              }
              const a = await getAsset(tx, projectId, sid);
              if (
                a.target_type !== 'scenario' ||
                a.kind !== selected.kind ||
                a.requirement_version_id !== versionId
              )
                throw new DomainError(
                  'BUSINESS_CONFLICT',
                  '场景不属于所选类型及需求版本。',
                  409,
                );
            }
            caseIds = (
              await tx.query<{ id: string }>(
                `SELECT id FROM app.test_assets WHERE project_id=$1 AND kind=$2
      AND (($2='UI' AND requirement_version_id=$3) OR ($2='API' AND set_id IS NULL))
      AND parent_id=ANY($4::uuid[]) AND target_type='case' AND removed_at IS NULL ORDER BY created_at,id`,
                [projectId, selected.kind, versionId, scenarioIds],
              )
            ).rows.map((c) => c.id);
          } else {
            if (selected.scenarioIds?.length)
              throw new DomainError(
                'VALIDATION_ERROR',
                '用例级复测须选择用例。',
                400,
              );
            caseIds = selected.caseIds ?? [
              ...new Set(
                related.flatMap((s) => (s.item.caseId ? [s.item.caseId] : [])),
              ),
            ];
          }
          if (!caseIds.length) {
            gap(
              'NO_RELATED_CASE',
              '没有可固定的相关用例；可人工复测或明确选取、补审相关用例。',
            );
            continue;
          }
          const assets = await Promise.all(
            caseIds.map((id) => getAsset(tx, projectId, id)),
          );
          if (selected.kind === 'UI')
            await tx.query(
              'SELECT id FROM app.test_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
              [[...new Set(assets.map((a) => a.set_id))]],
            );
          else
            await tx.query(
              'SELECT id FROM app.test_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
              [caseIds],
            );
          const environment =
            await this.plans.configurations.executionSnapshotInTransaction(
              tx,
              actor,
              projectId,
              selected.environmentId,
              [],
              [],
            );
          const sourceRunIds = [...new Set(related.map((s) => s.runId))].sort();
          const contextLabel =
            selected.contextLabel ??
            (sourceRunIds.length
              ? `原执行 ${sourceRunIds.join(',')}`
              : '人工缺陷复测');
          const key = semanticDigest({
            kind: selected.kind,
            versionId,
            environmentId: selected.environmentId,
            environmentRevisionId: environment.environment.revisionId,
            productBuild: selected.productBuild,
            // A display fallback is not an execution-context distinction.
            // Explicit contexts stay separate; otherwise preserve actual source runs.
            context:
              selected.contextLabel === undefined
                ? { sourceRunIds }
                : { label: selected.contextLabel },
          });
          let group = groups.get(key);
          if (!group) {
            group = {
              scope: {
                groupId: randomUUID(),
                kind: selected.kind,
                environment: environment.environment,
                productBuild: selected.productBuild,
                context: { label: contextLabel, sourceRunIds },
                items: [],
                missingRequirements: [],
              },
              configurations: new Map(),
            };
          }
          // Empty groups are assembled internally and only validated once at least one eligible item exists.
          for (const asset of assets) {
            if (
              asset.target_type !== 'case' ||
              asset.kind !== selected.kind ||
              (selected.kind === 'UI' &&
                asset.requirement_version_id !== versionId)
            )
              throw new DomainError(
                'BUSINESS_CONFLICT',
                '复测用例与明确选择的需求版本/类型不一致。',
                409,
              );
            try {
              if (selected.kind === 'API') {
                const current = await getApiProjectCase(
                  tx,
                  projectId,
                  asset.id,
                );
                if (
                  current.requirementVersionId !== null &&
                  current.requirementVersionId !== versionId
                )
                  throw new DomainError(
                    'BUSINESS_CONFLICT',
                    '接口用例已关联到其他需求版本。',
                    409,
                  );
                const api = await this.plans.analyseApiCaseInTransaction(
                  tx,
                  actor,
                  projectId,
                  { environment_id: selected.environmentId },
                  asset.id,
                );
                if (!api.eligible) {
                  gap(
                    'CASE_NOT_EXECUTABLE',
                    `${asset.id}：${api.item.reasons.map((r) => r.message).join('；')}`,
                  );
                  continue;
                }
                const { approval, snapshot } = api.approved;
                for (const row of api.rows) {
                  const existing = group.scope.items.find(
                    (item) =>
                      item.caseId === asset.id &&
                      item.approvalSnapshotId === approval.id &&
                      item.dataRow?.id === row.dataRow?.id,
                  );
                  if (existing) {
                    existing.issueIds = [
                      ...new Set([...existing.issueIds, issue.id]),
                    ];
                    continue;
                  }
                  group.scope.items.push(
                    scopeItemSchema.omit({ runItemId: true }).parse({
                      caseId: asset.id,
                      caseRevisionId: approval.caseRevisionId,
                      ...(api.disabledNodeIds.length
                        ? { disabledNodeIds: api.disabledNodeIds }
                        : {}),
                      approvalSnapshotId: approval.id,
                      requirementVersionId: snapshot.case.requirementVersionId,
                      setId: null,
                      scenarioId: snapshot.scenario?.id ?? null,
                      scenario: snapshot.scenario?.content ?? null,
                      content: row.content,
                      ordinal: group.scope.items.length,
                      issueIds: [issue.id],
                      ...(row.dataRow ? { dataRow: row.dataRow } : {}),
                      ...(api.preparationSources.length
                        ? { preparationSources: api.preparationSources }
                        : {}),
                    }),
                  );
                }
                group.configurations.set(asset.id, api.configuration);
                continue;
              }
              const approved =
                await this.plans.reviews.latestApprovedInTransaction(
                  tx,
                  projectId,
                  asset.id,
                  'UI',
                );
              const content = uiCaseContentSchema.parse(
                approved.snapshot.case.content,
              );
              const existing = group.scope.items.find(
                (i) =>
                  i.caseId === asset.id &&
                  i.approvalSnapshotId === approved.approval.id,
              );
              if (existing) {
                existing.issueIds = [
                  ...new Set([...existing.issueIds, issue.id]),
                ];
              } else
                group.scope.items.push(
                  scopeItemSchema.omit({ runItemId: true }).parse({
                    caseId: asset.id,
                    approvalSnapshotId: approved.approval.id,
                    requirementVersionId: versionId,
                    setId: asset.set_id,
                    scenarioId: approved.snapshot.scenario.id,
                    scenario: scenarioContentSchema.parse(
                      approved.snapshot.scenario.content,
                    ),
                    content,
                    ordinal: group.scope.items.length,
                    issueIds: [issue.id],
                  }),
                );
            } catch (error: unknown) {
              if (!(error instanceof DomainError)) throw error;
              gap('CASE_NOT_APPROVED', `${asset.id}：${error.message}`);
            }
          }
          if (group.scope.items.length) {
            group.scope.context.sourceRunIds = [
              ...new Set([
                ...group.scope.context.sourceRunIds,
                ...sourceRunIds,
              ]),
            ].sort();
            groups.set(key, group);
          }
        }
        const preparationId = randomUUID(),
          revisionId = randomUUID();
        await tx.query(
          'INSERT INTO app.retest_preparations(id,project_id,name,created_by,current_revision_id) VALUES($1,$2,$3,$4,$5)',
          [preparationId, projectId, input.name, actor.userId, revisionId],
        );
        await tx.query(
          `INSERT INTO app.retest_preparation_revisions(id,preparation_id,project_id,revision_no,selection,missing_requirements,created_by)
    VALUES($1,$2,$3,1,$4,$5,$6)`,
          [
            revisionId,
            preparationId,
            projectId,
            JSON.stringify(input.selections),
            JSON.stringify(missing),
            actor.userId,
          ],
        );
        for (const group of groups.values()) {
          const scope = retestGroupTemplateSchema.parse({
            ...group.scope,
            missingRequirements: missing,
          });
          await tx.query(
            `INSERT INTO app.retest_groups(id,project_id,preparation_id,preparation_revision_id,kind,environment_id,public_snapshot,internal_configuration)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              scope.groupId,
              projectId,
              preparationId,
              revisionId,
              scope.kind,
              scope.environment.id,
              JSON.stringify(scope),
              JSON.stringify({
                cases: [...group.configurations].map(
                  ([caseId, configuration]) => ({ caseId, configuration }),
                ),
              }),
            ],
          );
          for (const issueId of new Set(scope.items.flatMap((i) => i.issueIds)))
            await tx.query(
              'INSERT INTO app.retest_group_issues(project_id,group_id,issue_id) VALUES($1,$2,$3)',
              [projectId, scope.groupId, issueId],
            );
        }
        await audit(tx, actor, 'retests.prepared', preparationId, projectId, {
          revisionId,
          groupCount: groups.size,
          missingCount: missing.length,
        });
        return this.detailInTransaction(tx, projectId, preparationId);
      },
      projectId,
    );
  }
  private async detailInTransaction(
    tx: SqlExecutor,
    projectId: string,
    id: string,
  ) {
    const p = (
      await tx.query<{
        id: string;
        current_revision_id: string;
        name: string;
        created_by: string;
        created_at: Date;
        missing_requirements: unknown;
      }>(
        `SELECT p.*,r.missing_requirements FROM app.retest_preparations p
   JOIN app.retest_preparation_revisions r ON r.id=p.current_revision_id WHERE p.project_id=$1 AND p.id=$2`,
        [projectId, id],
      )
    ).rows[0];
    if (!p) throw new DomainError('NOT_FOUND', '此项目内没有该复测准备。', 404);
    const groups = await tx.query<{ public_snapshot: unknown }>(
      'SELECT public_snapshot FROM app.retest_groups WHERE project_id=$1 AND preparation_revision_id=$2 ORDER BY created_at,id',
      [projectId, p.current_revision_id],
    );
    return retestPreparationSchema.parse({
      preparationId: id,
      revisionId: p.current_revision_id,
      name: p.name,
      createdBy: p.created_by,
      createdAt: p.created_at.toISOString(),
      groups: groups.rows.map((g) => g.public_snapshot),
      missingRequirements: p.missing_requirements,
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'runs.organize');
      return this.detailInTransaction(tx, projectId, id);
    });
  }
  async list(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<{
        id: string;
        current_revision_id: string;
        name: string;
        created_by: string;
        created_at: Date;
      }>(
        'SELECT * FROM app.retest_preparations WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 200',
        [projectId],
      );
      return {
        preparations: rows.rows.map((p) => ({
          id: p.id,
          revisionId: p.current_revision_id,
          name: p.name,
          createdBy: p.created_by,
          createdAt: p.created_at.toISOString(),
        })),
      };
    });
  }
  async groupInTransaction(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    groupId: string,
  ) {
    await requireProject(tx, actor, projectId, 'runs.organize');
    const row = (
      await tx.query<GroupRow>(
        'SELECT * FROM app.retest_groups WHERE project_id=$1 AND id=$2',
        [projectId, groupId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '没有此项目的固定复测分组。', 404);
    const scope = retestGroupTemplateSchema.parse(row.public_snapshot);
    await this.plans.configurations.executionSnapshotInTransaction(
      tx,
      actor,
      projectId,
      scope.environment.id,
      [],
      [],
    );
    return { row, scope };
  }
  async group(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(
      async (tx) =>
        (await this.groupInTransaction(tx, actor, projectId, id)).scope,
    );
  }
  async startPreview(actor: ActorContext, projectId: string, groupId: string) {
    return this.db.transaction(async (tx) => {
      const { scope: group } = await this.groupInTransaction(
        tx,
        actor,
        projectId,
        groupId,
      );
      if (group.kind !== 'API')
        throw new DomainError('NOT_FOUND', '此分组不是平台接口复测。', 404);
      const active = (
        await tx.query<{ run_id: string }>(
          `SELECT l.run_id FROM app.retest_group_runs l JOIN app.runs r ON r.id=l.run_id
        WHERE l.group_id=$1 AND r.state IN ('prepared','queued','running','stopping','recoveryRequired') ORDER BY l.run_id`,
          [groupId],
        )
      ).rows.map((r) => r.run_id);
      return {
        group,
        scopeDigest: semanticDigest(group),
        existingRunIds: active,
      };
    });
  }
  async startReceipt(
    actor: ActorContext,
    projectId: string,
    commandId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'runs.organize');
      const row = (
        await tx.query<{
          status: 'pending' | 'completed' | 'failed' | 'unknown';
          response: unknown;
        }>(
          `SELECT status,response FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND operation='retests.start-api' AND key=$3`,
          [actor.userId, projectId, commandId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得此本人接口复测command的回执；保持原标识查询，不自动重发。',
          404,
        );
      return { commandId, status: row.status, response: row.response };
    });
  }
  async startApi(
    actor: ActorContext,
    projectId: string,
    groupId: string,
    raw: unknown,
  ) {
    const input = startApiRetestInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'retests.start-api',
      input.commandId,
      { projectId, groupId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'runs.organize');
      },
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `retest-start:${groupId}`,
        ]);
        const { row, scope: template } = await this.groupInTransaction(
          tx,
          actor,
          projectId,
          groupId,
        );
        if (template.kind !== 'API')
          throw new DomainError('NOT_FOUND', '此分组不是平台接口复测。', 404);
        const active = (
          await tx.query<{ run_id: string }>(
            `SELECT l.run_id FROM app.retest_group_runs l JOIN app.runs r ON r.id=l.run_id WHERE l.group_id=$1
    AND r.state IN ('prepared','queued','running','stopping','recoveryRequired') ORDER BY l.run_id`,
            [groupId],
          )
        ).rows.map((r) => r.run_id);
        if (
          canonicalJson([...input.confirmedExistingRunIds].sort()) !==
          canonicalJson(active)
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '此固定复测范围存在执行；先核对当前运行再明确启动新一轮。',
            409,
            { existingRunIds: active.join(',') },
          );
        if (
          input.scopeDigest !== undefined &&
          input.scopeDigest !== semanticDigest(template)
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '接口复测固定范围与已展示内容不一致。',
            409,
          );
        const runId = randomUUID();
        const items = template.items.map((i) => ({
          ...i,
          runItemId: randomUUID(),
        }));
        const base = {
          schemaVersion: 'ath.execution-scope.v1',
          runId,
          sourceType: 'retestPreparation',
          sourceRevisionId: groupId,
          projectId,
          kind: 'API',
          environmentId: template.environment.id,
          environmentRevisionId: template.environment.revisionId,
          productBuild: template.productBuild,
          items,
          missingRequirements: template.missingRequirements,
          retestContext: template.context,
        };
        const scope = executionScopeSchema.parse({
          ...base,
          snapshotDigest: semanticDigest(base),
        });
        const cleanup = items.some(
          (i) => i.content.kind === 'API' && i.content.cleanup.mode !== 'none',
        )
          ? 'pending'
          : 'notConfigured';
        await tx.query(
          `INSERT INTO app.runs(id,run_snapshot_id,project_id,kind,source,source_revision_id,environment_id,environment_revision_id,product_build,created_by,
    state,cleanup_state,scope_snapshot,scope_digest,internal_configuration,origin_key_id,execution_provenance)
    VALUES($1,$2,$3,'API','retest',$4,$5,$6,$7,$8,'prepared',$9,$10,$11,$12,$13,'platform-api')`,
          [
            runId,
            randomUUID(),
            projectId,
            groupId,
            template.environment.id,
            template.environment.revisionId,
            template.productBuild,
            actor.userId,
            cleanup,
            JSON.stringify(scope),
            scope.snapshotDigest,
            JSON.stringify(row.internal_configuration),
            actor.keyId ?? null,
          ],
        );
        for (const item of items)
          await tx.query(
            `INSERT INTO app.run_items(id,project_id,run_id,ordinal,case_id,approval_snapshot_id,snapshot,cleanup_state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              item.runItemId,
              projectId,
              runId,
              item.ordinal,
              item.caseId,
              item.approvalSnapshotId,
              JSON.stringify(item),
              item.content.kind === 'API' &&
              item.content.cleanup.mode !== 'none'
                ? 'pending'
                : 'notConfigured',
            ],
          );
        await tx.query(
          'INSERT INTO app.retest_group_runs(project_id,group_id,run_id) VALUES($1,$2,$3)',
          [projectId, groupId, runId],
        );
        await audit(tx, actor, 'retests.api-started', runId, projectId, {
          groupId,
          snapshotDigest: scope.snapshotDigest,
        });
        return { runId, state: 'prepared' as const, scope };
      },
      projectId,
    );
  }
}
