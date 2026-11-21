import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  apiCaseContentSchema,
  executionScopeSchema,
  planSchema,
  scopeItemSchema,
  uiCaseContentSchema,
  uiPlanSchema,
  scenarioContentSchema,
} from '../../../contracts/src/domain.js';
import {
  apiQueueInputSchema,
  apiStartPreviewInputSchema,
  apiStartPreviewSchema,
  createPlanInputSchema,
  revisePlanInputSchema,
  renamePlanInputSchema,
  uiPlanTemplateSchema,
  planOperationLookupSchema,
  planningOperationStatusSchema,
  type CreatePlanInput,
} from '../../../contracts/src/plans.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { getAsset } from '../assets/repository.js';
import { ReviewService } from '../assets/reviews.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import { TestConfigurationService } from '../test-configuration/service.js';
import { capacityPolicies } from '../recovery/capacity-policy.js';

interface PlanRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: 'UI' | 'API';
  row_version: number;
  created_by: string;
  plan_revision_id: string;
  revision_no: number;
  name: string;
  environment_id: string;
  product_build: string | null;
  requirement_version_id: string | null;
  items: unknown;
  ui_snapshot: unknown;
}
interface RequestRow extends QueryResultRow {
  id: string;
  project_id: string;
  plan_id: string;
  plan_revision_id: string;
  source: 'manual' | 'scheduled' | 'debug';
  actor_id: string;
  origin_key_id: string | null;
  selected_case_ids: string[];
  state: 'queued' | 'started' | 'notExecuted' | 'cancelled';
  run_id: string | null;
  reason_code: string | null;
}
interface RunRow extends QueryResultRow {
  id: string;
  run_snapshot_id: string;
  state: string;
  delivery_status: string;
  cleanup_state: string;
  scope_snapshot: unknown;
  created_at: Date;
}
export interface ScheduledStartGuard {
  beforeStartInTransaction(
    transaction: SqlExecutor,
    requestId: string,
  ): Promise<void>;
  startedInTransaction(
    transaction: SqlExecutor,
    requestId: string,
    runId: string,
  ): Promise<void>;
  rejectedInTransaction(
    transaction: SqlExecutor,
    requestId: string,
    error: DomainError,
  ): Promise<void>;
}
const planSelect = `SELECT p.id,p.project_id,p.kind,p.row_version,p.created_by,r.id plan_revision_id,r.revision_no,r.name,r.environment_id,r.product_build,
  r.requirement_version_id,r.items,r.ui_snapshot FROM app.test_plans p JOIN app.plan_revisions r ON r.plan_id=p.id`;
const logicalItemsSchema = z.array(z.strictObject({ caseId: z.uuid() }));
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const sameIds = (left: string[], right: string[]) =>
  canonicalJson([...left].sort()) === canonicalJson([...right].sort());
const requestDto = (row: RequestRow) => ({
  id: row.id,
  planId: row.plan_id,
  planRevisionId: row.plan_revision_id,
  source: row.source,
  state: row.state,
  runId: row.run_id,
  reasonCode: row.reason_code,
});

export class PlanService {
  readonly operations: OperationService;
  readonly reviews: ReviewService;
  private scheduledGuard: ScheduledStartGuard | undefined;
  setScheduledStartGuard(guard: ScheduledStartGuard) {
    this.scheduledGuard = guard;
  }
  constructor(
    readonly db: Database,
    readonly configurations: TestConfigurationService,
  ) {
    this.operations = new OperationService(db);
    this.reviews = new ReviewService(db);
  }
  async operationStatus(actor: ActorContext, projectId: string, raw: unknown) {
    const input = planOperationLookupSchema.parse(raw);
    await this.db.transaction((tx) =>
      requireProject(tx, actor, projectId, 'project.read'),
    );
    const result = await this.operations.get(actor, input);
    if (result.command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '本项目没有该原操作回执。', 404);
    return planningOperationStatusSchema.parse(result);
  }
  private dto(row: PlanRow) {
    return planSchema.parse({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      planRevisionId: row.plan_revision_id,
      name: row.name,
      environmentId: row.environment_id,
      productBuild: row.product_build,
      createdBy: row.created_by,
      rowVersion: row.row_version,
      items: row.items,
      ...(row.kind === 'UI'
        ? { requirementVersionId: row.requirement_version_id }
        : {}),
    });
  }
  private async row(
    transaction: SqlExecutor,
    projectId: string,
    id: string,
    revisionId?: string,
  ): Promise<PlanRow> {
    const row = (
      await transaction.query<PlanRow>(
        `${planSelect} WHERE p.project_id=$1 AND p.id=$2 AND r.id=COALESCE($3::uuid,p.current_revision_id)`,
        [projectId, id, revisionId ?? null],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '此项目范围内没有该计划修订。', 404);
    return row;
  }
  async list(actor: ActorContext, projectId: string, kind?: 'UI' | 'API') {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const rows = await transaction.query<PlanRow>(
        `${planSelect} WHERE p.project_id=$1 AND r.id=p.current_revision_id AND ($2::text IS NULL OR p.kind=$2) ORDER BY p.created_at DESC,p.id LIMIT 200`,
        [projectId, kind ?? null],
      );
      return { plans: rows.rows.map((row) => this.dto(row)) };
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const row = await this.row(transaction, projectId, id);
      const fixed =
        row.kind === 'UI' ? uiPlanTemplateSchema.parse(row.ui_snapshot) : null;
      const environment = fixed
        ? null
        : (
            await transaction.query<{ name: string }>(
              "SELECT name FROM app.test_configurations WHERE project_id=$1 AND id=$2 AND kind='environment'",
              [projectId, row.environment_id],
            )
          ).rows[0];
      const currentCases = fixed
        ? []
        : (
            await transaction.query<{
              id: string;
              title: string;
              requirement_version_id: string;
            }>(
              `SELECT a.id,r.content->>'title' title,a.requirement_version_id FROM app.test_assets a
         JOIN app.asset_revisions r ON r.id=a.current_revision_id
         WHERE a.project_id=$1 AND a.kind='API' AND a.target_type='case' AND a.id=ANY($2::uuid[])`,
              [
                projectId,
                logicalItemsSchema.parse(row.items).map((item) => item.caseId),
              ],
            )
          ).rows;
      const revisions = await transaction.query<{
        id: string;
        revision_no: number;
        created_at: Date;
      }>(
        'SELECT id,revision_no,created_at FROM app.plan_revisions WHERE plan_id=$1 ORDER BY revision_no',
        [id],
      );
      return {
        plan: this.dto(row),
        display: {
          environmentName:
            fixed?.environment.content.name ?? environment?.name ?? null,
          cases: fixed
            ? fixed.items.map((item) => ({
                caseId: item.caseId,
                title: item.content.title,
                requirementVersionId: item.requirementVersionId,
                approvalSnapshotId: item.approvalSnapshotId,
              }))
            : logicalItemsSchema.parse(row.items).map((item) => {
                const current = currentCases.find(
                  (entry) => entry.id === item.caseId,
                );
                return {
                  caseId: item.caseId,
                  title: current?.title ?? null,
                  requirementVersionId: current?.requirement_version_id ?? null,
                  approvalSnapshotId: null,
                };
              }),
        },
        revisions: revisions.rows.map((revision) => ({
          id: revision.id,
          revisionNo: revision.revision_no,
          createdAt: revision.created_at.toISOString(),
        })),
      };
    });
  }
  async uiEligibility(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'plans.write');
      const cases = (
        await transaction.query<{
          id: string;
          set_id: string;
          review_state: string;
        }>(
          "SELECT id,set_id,review_state FROM app.test_assets WHERE project_id=$1 AND kind='UI' AND target_type='case' AND removed_at IS NULL ORDER BY id LIMIT 10000",
          [projectId],
        )
      ).rows;
      const items = [];
      for (const item of cases) {
        let reasons: string[] = [];
        if (item.review_state !== 'approved') {
          reasons = ['当前用例修订待批准。'];
        } else {
          try {
            await this.reviews.latestApprovedInTransaction(
              transaction,
              projectId,
              item.id,
              'UI',
            );
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            reasons = [error.message];
          }
        }
        items.push({
          caseId: item.id,
          setId: item.set_id,
          eligible: reasons.length === 0,
          reasons,
        });
      }
      return { items };
    });
  }
  async rename(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = renamePlanInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'plans.rename',
      input.commandId,
      { projectId, id, ...input },
      (transaction) =>
        requireProject(transaction, actor, projectId, 'plans.write').then(
          () => undefined,
        ),
      async (transaction) => {
        await transaction.query(
          'SELECT id FROM app.test_plans WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, id],
        );
        const current = await this.row(transaction, projectId, id);
        if (
          current.row_version !== input.rowVersion ||
          current.plan_revision_id !== input.basePlanRevisionId
        )
          stale();
        const revisionId = randomUUID();
        // Copy exact frozen bytes in SQL. A name change never rebuilds or upgrades the scope.
        await transaction.query(
          `INSERT INTO app.plan_revisions(id,plan_id,project_id,kind,revision_no,name,environment_id,product_build,requirement_version_id,items,ui_snapshot,created_by)
          SELECT $1,plan_id,project_id,kind,revision_no+1,$2,environment_id,product_build,requirement_version_id,items,ui_snapshot,$3
          FROM app.plan_revisions WHERE id=$4 AND plan_id=$5 AND project_id=$6`,
          [
            revisionId,
            input.name,
            actor.userId,
            current.plan_revision_id,
            id,
            projectId,
          ],
        );
        await transaction.query(
          'UPDATE app.test_plans SET current_revision_id=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [id, revisionId],
        );
        await audit(transaction, actor, 'plans.renamed', id, projectId, {
          sourceRevisionId: current.plan_revision_id,
          planRevisionId: revisionId,
        });
        return { plan: this.dto(await this.row(transaction, projectId, id)) };
      },
      projectId,
    );
  }
  private async build(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    input: CreatePlanInput,
    previous?: PlanRow,
    refreshCaseIds: readonly string[] = [],
  ) {
    const retained = new Map(
      previous?.kind === 'UI'
        ? uiPlanTemplateSchema
            .parse(previous.ui_snapshot)
            .items.map((item) => [item.caseId, item])
        : [],
    );
    const retainedApi = new Set(
      previous?.kind === 'API'
        ? logicalItemsSchema.parse(previous.items).map((item) => item.caseId)
        : [],
    );
    const refresh = new Set(refreshCaseIds);
    if (input.kind === 'UI') {
      const currentIds = input.caseIds.filter(
        (id) => !retained.has(id) || refresh.has(id),
      );
      const sets = await transaction.query<{ set_id: string }>(
        'SELECT DISTINCT set_id FROM app.test_assets WHERE project_id=$1 AND id=ANY($2::uuid[])',
        [projectId, currentIds],
      );
      if (sets.rows.length)
        await transaction.query(
          'SELECT id FROM app.test_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [sets.rows.map((row) => row.set_id)],
        );
    }
    const environment =
      await this.configurations.executionSnapshotInTransaction(
        transaction,
        actor,
        projectId,
        input.environmentId,
        [],
        [],
      );
    const items = [];
    const fixed = [];
    for (const caseId of input.caseIds) {
      if (input.kind === 'API' && retainedApi.has(caseId)) {
        items.push({ caseId });
        continue;
      }
      const kept = retained.get(caseId);
      if (input.kind === 'UI' && kept && !refresh.has(caseId)) {
        items.push({ caseId, approvalSnapshotId: kept.approvalSnapshotId });
        fixed.push({ ...kept, ordinal: fixed.length });
        continue;
      }
      const current = await getAsset(transaction, projectId, caseId);
      if (current.target_type !== 'case' || current.kind !== input.kind)
        throw new DomainError('NOT_FOUND', '计划范围内没有该类型用例。', 404);
      if (input.kind === 'API') {
        await this.reviews.latestApprovedInTransaction(
          transaction,
          projectId,
          caseId,
          'API',
        );
        items.push({ caseId });
        continue;
      }
      if (current.requirement_version_id !== input.requirementVersionId)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          'UI计划不能跨需求版本，跨新版应新建计划。',
          422,
        );
      const approved = await this.reviews.latestApprovedInTransaction(
        transaction,
        projectId,
        caseId,
        'UI',
      );
      const content = uiCaseContentSchema.parse(approved.snapshot.case.content);
      const scenario = scenarioContentSchema.parse(
        approved.snapshot.scenario.content,
      );
      items.push({ caseId, approvalSnapshotId: approved.approval.id });
      fixed.push({
        caseId,
        approvalSnapshotId: approved.approval.id,
        requirementVersionId: current.requirement_version_id,
        setId: current.set_id,
        scenarioId: approved.snapshot.scenario.id,
        scenario,
        content,
        ordinal: fixed.length,
        issueIds: [],
      });
    }
    return {
      items,
      uiSnapshot:
        input.kind === 'UI'
          ? { environment: environment.environment, items: fixed }
          : null,
    };
  }
  async create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createPlanInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'plans.create',
      input.commandId,
      input,
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'plans.write');
      },
      async (transaction) => {
        const built = await this.build(transaction, actor, projectId, input);
        const id = randomUUID();
        const revisionId = randomUUID();
        await transaction.query(
          'INSERT INTO app.test_plans(id,project_id,kind,created_by) VALUES($1,$2,$3,$4)',
          [id, projectId, input.kind, actor.userId],
        );
        await this.insertRevision(
          transaction,
          actor,
          projectId,
          id,
          revisionId,
          1,
          input,
          built,
        );
        await transaction.query(
          'UPDATE app.test_plans SET current_revision_id=$2 WHERE id=$1',
          [id, revisionId],
        );
        await audit(transaction, actor, 'plans.created', id, projectId, {
          kind: input.kind,
          planRevisionId: revisionId,
        });
        return { plan: this.dto(await this.row(transaction, projectId, id)) };
      },
      projectId,
    );
  }
  private async insertRevision(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
    no: number,
    input: CreatePlanInput,
    built: Awaited<ReturnType<PlanService['build']>>,
  ) {
    await transaction.query(
      `INSERT INTO app.plan_revisions(id,plan_id,project_id,kind,revision_no,name,environment_id,product_build,requirement_version_id,items,ui_snapshot,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        revisionId,
        id,
        projectId,
        input.kind,
        no,
        input.name,
        input.environmentId,
        input.productBuild,
        input.requirementVersionId ?? null,
        JSON.stringify(built.items),
        built.uiSnapshot === null ? null : JSON.stringify(built.uiSnapshot),
        actor.userId,
      ],
    );
  }
  async revise(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = revisePlanInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'plans.revise',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'plans.write');
      },
      async (transaction) => {
        await transaction.query(
          'SELECT id FROM app.test_plans WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, id],
        );
        const current = await this.row(transaction, projectId, id);
        if (
          current.row_version !== input.rowVersion ||
          current.plan_revision_id !== input.basePlanRevisionId
        )
          stale();
        if (
          current.kind !== input.kind ||
          (current.kind === 'UI' &&
            current.requirement_version_id !== input.requirementVersionId)
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '计划类型或UI需求版本不能原地升级，请新建独立计划。',
            422,
          );
        const built = await this.build(
          transaction,
          actor,
          projectId,
          input,
          current,
          input.refreshCaseIds,
        );
        const revisionId = randomUUID();
        await this.insertRevision(
          transaction,
          actor,
          projectId,
          id,
          revisionId,
          current.revision_no + 1,
          input,
          built,
        );
        await transaction.query(
          'UPDATE app.test_plans SET current_revision_id=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [id, revisionId],
        );
        await audit(transaction, actor, 'plans.revised', id, projectId, {
          planRevisionId: revisionId,
        });
        return { plan: this.dto(await this.row(transaction, projectId, id)) };
      },
      projectId,
    );
  }
  async uiScopeInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'runs.organize');
    const row = await this.row(transaction, projectId, id, revisionId);
    if (row.kind !== 'UI')
      throw new DomainError('NOT_FOUND', '没有此UI计划修订。', 404);
    await this.configurations.executionSnapshotInTransaction(
      transaction,
      actor,
      projectId,
      row.environment_id,
      [],
      [],
    );
    return {
      plan: uiPlanSchema.parse(this.dto(row)),
      scope: uiPlanTemplateSchema.parse(row.ui_snapshot),
    };
  }
  async getUiScopeInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    planRevisionId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'runs.organize');
    const revision = (
      await transaction.query<{ plan_id: string }>(
        "SELECT plan_id FROM app.plan_revisions WHERE project_id=$1 AND id=$2 AND kind='UI'",
        [projectId, planRevisionId],
      )
    ).rows[0];
    if (!revision)
      throw new DomainError('NOT_FOUND', '没有此UI计划历史修订。', 404);
    return this.uiScopeInTransaction(
      transaction,
      actor,
      projectId,
      revision.plan_id,
      planRevisionId,
    );
  }
  async uiScope(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
  ) {
    return this.db.transaction((transaction) =>
      this.uiScopeInTransaction(transaction, actor, projectId, id, revisionId),
    );
  }
  async analyseApiCaseInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    row: { environment_id: string },
    caseId: string,
  ) {
    try {
      const approved = await this.reviews.latestApprovedInTransaction(
        transaction,
        projectId,
        caseId,
        'API',
      );
      const content = apiCaseContentSchema.parse(
        approved.snapshot.case.content,
      );
      const requests = [
        ...content.steps,
        ...(content.cleanup.mode === 'none'
          ? []
          : content.cleanup.steps.flatMap((step) =>
              step.type === 'http' ? [step.request] : [],
            )),
      ];
      const purposeIds = requests.flatMap((step) =>
        step.purposeRef ? [step.purposeRef] : [],
      );
      const profileIds = requests.flatMap((step) =>
        step.authProfileRef ? [step.authProfileRef] : [],
      );
      const connectionIds =
        content.cleanup.mode === 'none'
          ? []
          : content.cleanup.steps.flatMap((step) =>
              step.type === 'sql' ? [step.connectionId] : [],
            );
      if (
        content.cleanup.mode !== 'none' &&
        content.cleanup.steps.some(
          (step) =>
            step.type === 'sql' && step.environmentId !== row.environment_id,
        )
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          'SQL清理环境与本轮环境不一致。',
          422,
        );
      const configuration =
        await this.configurations.executionSnapshotInTransaction(
          transaction,
          actor,
          projectId,
          row.environment_id,
          purposeIds,
          connectionIds,
          profileIds,
        );
      for (const step of requests)
        if (step.authProfileRef) {
          const profile = configuration.profiles.find(
            (profile) => profile.id === step.authProfileRef,
          );
          if (
            profile?.content.kind === 'authProfile' &&
            profile.content.authentication.mode === 'login' &&
            !step.purposeRef
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '登录认证请求必须明确其自身用途，不能借用其他步骤的账号。',
              422,
            );
          if (
            step.purposeRef &&
            configuration.bindings.find(
              (binding) => binding.purpose.id === step.purposeRef,
            )?.profile?.id !== step.authProfileRef
          )
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '请求显式认证配置与所选环境用途绑定不一致。',
              422,
            );
        }
      return {
        eligible: true as const,
        item: {
          caseId,
          title: approved.snapshot.case.title,
          eligible: true,
          approvalSnapshotId: approved.approval.id,
          reasons: [],
        },
        approved,
        configuration,
        content,
      };
    } catch (error: unknown) {
      if (!(error instanceof DomainError)) throw error;
      return {
        eligible: false as const,
        item: {
          caseId,
          title: '缺口用例',
          eligible: false,
          approvalSnapshotId: null,
          reasons: [{ code: error.code, message: error.message }],
        },
        approved: null,
        configuration: null,
        content: null,
      };
    }
  }
  private async overlap(
    transaction: SqlExecutor,
    projectId: string,
    planId: string,
  ) {
    const runs = await transaction.query<{ id: string }>(
      "SELECT id FROM app.runs WHERE project_id=$1 AND plan_id=$2 AND state IN ('prepared','queued','running','stopping','recoveryRequired') ORDER BY id",
      [projectId, planId],
    );
    const requests = await transaction.query<{ id: string }>(
      "SELECT id FROM app.api_execution_requests WHERE project_id=$1 AND plan_id=$2 AND state='queued' ORDER BY id",
      [projectId, planId],
    );
    return {
      runIds: runs.rows.map((row) => row.id),
      requestIds: requests.rows.map((row) => row.id),
    };
  }
  async startPreview(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = apiStartPreviewInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'api-runs.start-preview',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'runs.organize');
      },
      async (transaction) => {
        const plan = await this.row(
          transaction,
          projectId,
          id,
          input.planRevisionId,
        );
        if (plan.kind !== 'API')
          throw new DomainError('NOT_FOUND', '没有此接口计划修订。', 404);
        const items = [];
        for (const item of logicalItemsSchema.parse(plan.items))
          items.push(
            (
              await this.analyseApiCaseInTransaction(
                transaction,
                actor,
                projectId,
                plan,
                item.caseId,
              )
            ).item,
          );
        const overlap = await this.overlap(transaction, projectId, id);
        const previewId = randomUUID();
        const createdAt = new Date().toISOString();
        const payload = {
          previewId,
          planId: id,
          planRevisionId: input.planRevisionId,
          source: input.source,
          existingRunIds: overlap.runIds,
          existingRequestIds: overlap.requestIds,
          items,
          createdAt,
        };
        const scopeDigest = digest(payload);
        await transaction.query(
          'INSERT INTO app.api_start_previews(id,actor_id,project_id,plan_id,plan_revision_id,source,scope_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            previewId,
            actor.userId,
            projectId,
            id,
            input.planRevisionId,
            input.source,
            scopeDigest,
            JSON.stringify({ ...payload, scopeDigest }),
          ],
        );
        return apiStartPreviewSchema.parse({ ...payload, scopeDigest });
      },
      projectId,
    );
  }
  async queue(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = apiQueueInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'api-runs.queue',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'runs.organize');
      },
      async (transaction) => {
        await transaction.query(
          'SELECT id FROM app.test_plans WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, id],
        );
        const stored = (
          await transaction.query<{ payload: unknown; scope_digest: string }>(
            'SELECT payload,scope_digest FROM app.api_start_previews WHERE id=$1 AND actor_id=$2 AND project_id=$3 AND plan_id=$4',
            [input.previewId, actor.userId, projectId, id],
          )
        ).rows[0];
        if (!stored)
          throw new DomainError('NOT_FOUND', '当前账号没有该开始预览。', 404);
        const preview = apiStartPreviewSchema.parse(stored.payload);
        if (input.scopeDigest !== stored.scope_digest) stale();
        const selected = new Set(input.selectedCaseIds);
        const eligible = preview.items
          .filter((item) => item.eligible)
          .map((item) => item.caseId);
        if (input.selectedCaseIds.some((id) => !eligible.includes(id)))
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '只能明确选择预览中可执行的有效子集，不会自动跳过缺口。',
            422,
          );
        const overlap = await this.overlap(transaction, projectId, id);
        if (
          !sameIds(overlap.runIds, preview.existingRunIds) ||
          !sameIds(overlap.requestIds, preview.existingRequestIds)
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '在途轮次已变化，请重新查看精确重叠范围。',
            409,
          );
        if (
          !sameIds(overlap.runIds, input.confirmedExistingRunIds) ||
          !sameIds(overlap.requestIds, input.confirmedExistingRequestIds)
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '存在同计划在途轮次，需要明确确认精确重叠范围。',
            422,
          );
        const plan = await this.row(
          transaction,
          projectId,
          id,
          preview.planRevisionId,
        );
        const selectedOrdered = logicalItemsSchema
          .parse(plan.items)
          .map((item) => item.caseId)
          .filter((id) => selected.has(id));
        if (selectedOrdered.length !== selected.size)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '所选范围不属于该固定计划修订。',
            422,
          );
        const requestId = randomUUID();
        await transaction.query(
          `INSERT INTO app.api_execution_requests(id,project_id,plan_id,plan_revision_id,source,actor_id,origin_key_id,selected_case_ids,accepted_overlap)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            requestId,
            projectId,
            id,
            preview.planRevisionId,
            preview.source,
            actor.userId,
            actor.keyId ?? null,
            selectedOrdered,
            JSON.stringify(overlap),
          ],
        );
        await audit(
          transaction,
          actor,
          'api-runs.queued',
          requestId,
          projectId,
          {
            planId: id,
            source: preview.source,
            selectedCount: selectedOrdered.length,
          },
        );
        const request = (
          await transaction.query<RequestRow>(
            'SELECT * FROM app.api_execution_requests WHERE id=$1',
            [requestId],
          )
        ).rows[0];
        if (!request)
          throw new Error('Execution request insert returned no row');
        return { request: requestDto(request) };
      },
      projectId,
    );
  }
  async requestStatus(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const request = (
        await transaction.query<RequestRow>(
          'SELECT * FROM app.api_execution_requests WHERE project_id=$1 AND id=$2',
          [projectId, id],
        )
      ).rows[0];
      if (!request) throw new DomainError('NOT_FOUND', '没有该执行请求。', 404);
      return { request: requestDto(request) };
    });
  }
  async boundApiPlanInTransaction(
    transaction: SqlExecutor,
    projectId: string,
    id: string,
    revisionId: string,
    environmentId: string,
  ) {
    const plan = await this.row(transaction, projectId, id, revisionId);
    if (plan.kind !== 'API' || plan.environment_id !== environmentId)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '定时须绑定同项目的确切API计划修订及该修订的环境。',
        422,
      );
    return {
      id: plan.id,
      revisionId: plan.plan_revision_id,
      name: plan.name,
      createdBy: plan.created_by,
      environmentId: plan.environment_id,
      caseIds: logicalItemsSchema.parse(plan.items).map((item) => item.caseId),
    };
  }
  async copyApiForScheduleInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
    name: string,
    environmentId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'plans.write');
    const source = await this.row(transaction, projectId, id, revisionId);
    if (source.kind !== 'API')
      throw new DomainError('NOT_FOUND', '此项目没有该API计划。', 404);
    await this.configurations.executionSnapshotInTransaction(
      transaction,
      actor,
      projectId,
      environmentId,
      [],
      [],
    );
    const input = createPlanInputSchema.parse({
      commandId: randomUUID(),
      kind: 'API',
      name,
      environmentId,
      productBuild: source.product_build,
      caseIds: logicalItemsSchema
        .parse(source.items)
        .map((item) => item.caseId),
    });
    const nextId = randomUUID(),
      nextRevisionId = randomUUID();
    await transaction.query(
      "INSERT INTO app.test_plans(id,project_id,kind,created_by) VALUES($1,$2,'API',$3)",
      [nextId, projectId, actor.userId],
    );
    await this.insertRevision(
      transaction,
      actor,
      projectId,
      nextId,
      nextRevisionId,
      1,
      input,
      { items: logicalItemsSchema.parse(source.items), uiSnapshot: null },
    );
    await transaction.query(
      'UPDATE app.test_plans SET current_revision_id=$2 WHERE id=$1',
      [nextId, nextRevisionId],
    );
    await audit(
      transaction,
      actor,
      'plans.copied-for-schedule',
      nextId,
      projectId,
      {
        sourcePlanId: id,
        sourcePlanRevisionId: revisionId,
        planRevisionId: nextRevisionId,
      },
    );
    return this.boundApiPlanInTransaction(
      transaction,
      projectId,
      nextId,
      nextRevisionId,
      environmentId,
    );
  }
  /** Internal timer bridge: one complete logical plan, no subset or external side effect. */
  async queueScheduledInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
    requestId: string,
  ) {
    await requireProject(transaction, actor, projectId, 'runs.organize');
    await transaction.query(
      'SELECT id FROM app.test_plans WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [projectId, id],
    );
    const plan = await this.row(transaction, projectId, id, revisionId);
    if (plan.kind !== 'API')
      throw new DomainError('NOT_FOUND', '没有该API计划。', 404);
    try {
      await capacityPolicies.read(transaction);
    } catch (error: unknown) {
      if (!(error instanceof DomainError)) throw error;
      return {
        accepted: false as const,
        reason: 'preconditionsMissing' as const,
        details: { capacityPolicyUnavailable: true, message: error.message },
      };
    }
    const overlap = await this.overlap(transaction, projectId, id);
    if (overlap.runIds.length || overlap.requestIds.length)
      return {
        accepted: false as const,
        reason: 'overlapSkipped' as const,
        details: overlap,
      };
    const caseIds = logicalItemsSchema
        .parse(plan.items)
        .map((item) => item.caseId),
      gaps = [];
    for (const caseId of caseIds) {
      const analysed = await this.analyseApiCaseInTransaction(
        transaction,
        actor,
        projectId,
        plan,
        caseId,
      );
      if (!analysed.eligible) gaps.push(analysed.item);
    }
    if (gaps.length)
      return {
        accepted: false as const,
        reason: 'preconditionsMissing' as const,
        details: { items: gaps },
      };
    await transaction.query(
      `INSERT INTO app.api_execution_requests(id,project_id,plan_id,plan_revision_id,source,actor_id,origin_key_id,selected_case_ids)
      VALUES($1,$2,$3,$4,'scheduled',$5,NULL,$6)`,
      [requestId, projectId, id, revisionId, actor.userId, caseIds],
    );
    await audit(
      transaction,
      actor,
      'api-runs.scheduled-queued',
      requestId,
      projectId,
      { planId: id, planRevisionId: revisionId, selectedCount: caseIds.length },
    );
    return { accepted: true as const, requestId };
  }
  async validateScheduledPreparedInTransaction(
    transaction: SqlExecutor,
    runId: string,
  ) {
    const request = (
      await transaction.query<{ id: string }>(
        "SELECT id FROM app.api_execution_requests WHERE run_id=$1 AND source='scheduled' FOR UPDATE",
        [runId],
      )
    ).rows[0];
    if (!request || !this.scheduledGuard)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '定时来源未登记或调度控制面尚未就绪，不自动启动。',
        422,
      );
    await this.scheduledGuard.beforeStartInTransaction(transaction, request.id);
  }
  async rejectUnclaimedScheduledInTransaction(
    transaction: SqlExecutor,
    runId: string,
    error: DomainError,
  ) {
    const request = (
      await transaction.query<{ id: string }>(
        "SELECT id FROM app.api_execution_requests WHERE run_id=$1 AND source='scheduled' FOR UPDATE",
        [runId],
      )
    ).rows[0];
    if (
      !request ||
      (
        await transaction.query(
          'SELECT 1 FROM app.api_worker_grants WHERE run_id=$1',
          [runId],
        )
      ).rowCount
    )
      return;
    await transaction.query(
      "UPDATE app.api_execution_requests SET state='notExecuted',reason_code=$2 WHERE id=$1",
      [request.id, error.code],
    );
    await transaction.query(
      "UPDATE app.runs SET state='terminated',ended_at=clock_timestamp() WHERE id=$1",
      [runId],
    );
    await transaction.query(
      "UPDATE app.run_items SET state='notExecuted',outcome='notExecuted',cleanup_state=CASE WHEN cleanup_state='pending' THEN 'skipped' ELSE cleanup_state END WHERE run_id=$1 AND state='pending'",
      [runId],
    );
    await this.scheduledGuard?.rejectedInTransaction(
      transaction,
      request.id,
      error,
    );
  }
  /** Internal dispatcher entry. Never sends HTTP/SQL; re-delivery only returns the original run. */
  async startQueued(id: string) {
    return this.db.transaction((transaction) =>
      this.startQueuedInTransaction(transaction, id),
    );
  }
  async startQueuedInTransaction(transaction: SqlExecutor, id: string) {
    const request = (
      await transaction.query<RequestRow>(
        'SELECT * FROM app.api_execution_requests WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!request) throw new DomainError('NOT_FOUND', '没有该执行请求。', 404);
    if (request.state !== 'queued')
      return {
        request: requestDto(request),
        run: request.run_id
          ? await this.publicRunInTransaction(
              transaction,
              request.project_id,
              request.run_id,
            )
          : null,
      };
    const actor: ActorContext = {
      userId: request.actor_id,
      entrypoint: 'worker',
      requestId: randomUUID(),
      ...(request.origin_key_id ? { keyId: request.origin_key_id } : {}),
    };
    await transaction.query('SAVEPOINT start_request_work');
    try {
      if (request.source === 'scheduled') {
        if (!this.scheduledGuard)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '调度控制面未就绪，不自动启动定时请求。',
            422,
          );
        await this.scheduledGuard.beforeStartInTransaction(transaction, id);
      }
      await requireProject(
        transaction,
        actor,
        request.project_id,
        'runs.organize',
      );
      const plan = await this.row(
        transaction,
        request.project_id,
        request.plan_id,
        request.plan_revision_id,
      );
      const cases = logicalItemsSchema
        .parse(plan.items)
        .map((item) => item.caseId);
      if (
        request.selected_case_ids.some((id) => !cases.includes(id)) ||
        (request.source === 'scheduled' &&
          !sameIds(request.selected_case_ids, cases))
      )
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '执行请求范围不符合计划，定时不能自动选择子集。',
          422,
        );
      const sets = await transaction.query<{ set_id: string }>(
        'SELECT DISTINCT set_id FROM app.test_assets WHERE project_id=$1 AND id=ANY($2::uuid[])',
        [request.project_id, request.selected_case_ids],
      );
      if (sets.rows.length)
        await transaction.query(
          'SELECT id FROM app.test_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [sets.rows.map((row) => row.set_id)],
        );
      const analysed = [];
      for (const caseId of request.selected_case_ids) {
        const item = await this.analyseApiCaseInTransaction(
          transaction,
          actor,
          request.project_id,
          plan,
          caseId,
        );
        if (!item.eligible)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '真正开始时出现批准或环境缺口，整轮不自动缩小范围。',
            422,
          );
        analysed.push(item);
      }
      const first = analysed[0];
      if (!first)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '执行范围不能为空。',
          422,
        );
      const runId = randomUUID();
      const snapshotId = randomUUID();
      const items = analysed.map((entry, ordinal) =>
        scopeItemSchema.parse({
          runItemId: randomUUID(),
          caseId: entry.approved.approval.caseId,
          approvalSnapshotId: entry.approved.approval.id,
          requirementVersionId:
            entry.approved.snapshot.case.requirementVersionId,
          setId: entry.approved.snapshot.case.setId,
          scenarioId: entry.approved.snapshot.scenario.id,
          scenario: entry.approved.snapshot.scenario.content,
          content: entry.content,
          ordinal,
          issueIds: [],
        }),
      );
      const scopeBase = {
        schemaVersion: 'ath.execution-scope.v1',
        runId,
        sourceType: request.source === 'debug' ? 'debug' : 'plan',
        sourceRevisionId: plan.plan_revision_id,
        projectId: request.project_id,
        kind: 'API',
        environmentId: plan.environment_id,
        environmentRevisionId: first.configuration.environment.revisionId,
        productBuild: plan.product_build,
        items,
        missingRequirements: [],
      };
      const scope = executionScopeSchema.parse({
        ...scopeBase,
        snapshotDigest: digest(scopeBase),
      });
      const cleanup = analysed.some(
        (entry) => entry.content.cleanup.mode !== 'none',
      )
        ? 'pending'
        : 'notConfigured';
      await transaction.query(
        `INSERT INTO app.runs(id,run_snapshot_id,project_id,kind,source,source_revision_id,plan_id,environment_id,environment_revision_id,product_build,created_by,
        state,cleanup_state,scope_snapshot,scope_digest,internal_configuration,started_at) VALUES($1,$2,$3,'API',$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$12,$13,$14,clock_timestamp())`,
        [
          runId,
          snapshotId,
          request.project_id,
          request.source,
          plan.plan_revision_id,
          plan.id,
          plan.environment_id,
          first.configuration.environment.revisionId,
          plan.product_build,
          actor.userId,
          cleanup,
          JSON.stringify(scope),
          scope.snapshotDigest,
          JSON.stringify({
            cases: analysed.map((entry) => ({
              caseId: entry.approved.approval.caseId,
              configuration: entry.configuration,
            })),
          }),
        ],
      );
      for (const [index, item] of items.entries())
        await transaction.query(
          `INSERT INTO app.run_items(id,project_id,run_id,ordinal,case_id,approval_snapshot_id,snapshot,cleanup_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            item.runItemId,
            request.project_id,
            runId,
            item.ordinal,
            item.caseId,
            item.approvalSnapshotId,
            JSON.stringify(item),
            analysed[index]?.content.cleanup.mode === 'none'
              ? 'notConfigured'
              : 'pending',
          ],
        );
      await transaction.query(
        "UPDATE app.api_execution_requests SET state='started',run_id=$2,started_at=clock_timestamp() WHERE id=$1",
        [id, runId],
      );
      await audit(
        transaction,
        actor,
        'api-runs.snapshot-fixed',
        runId,
        request.project_id,
        { requestId: id, runSnapshotId: snapshotId, caseCount: items.length },
      );
      if (request.source === 'scheduled')
        await this.scheduledGuard?.startedInTransaction(transaction, id, runId);
      const updated = (
        await transaction.query<RequestRow>(
          'SELECT * FROM app.api_execution_requests WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!updated) throw new Error('Execution request disappeared');
      const result = {
        request: requestDto(updated),
        run: await this.publicRunInTransaction(
          transaction,
          request.project_id,
          runId,
        ),
      };
      await transaction.query('RELEASE SAVEPOINT start_request_work');
      return result;
    } catch (error: unknown) {
      if (!(error instanceof DomainError)) throw error;
      await transaction.query('ROLLBACK TO SAVEPOINT start_request_work');
      await transaction.query('RELEASE SAVEPOINT start_request_work');
      await transaction.query(
        "UPDATE app.api_execution_requests SET state='notExecuted',reason_code=$2 WHERE id=$1",
        [id, error.code],
      );
      if (request.source === 'scheduled')
        await this.scheduledGuard?.rejectedInTransaction(
          transaction,
          id,
          error,
        );
      const updated = (
        await transaction.query<RequestRow>(
          'SELECT * FROM app.api_execution_requests WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!updated) throw new Error('Execution request disappeared');
      return { request: requestDto(updated), run: null };
    }
  }
  async publicRunInTransaction(
    transaction: SqlExecutor,
    projectId: string,
    id: string,
  ) {
    const row = (
      await transaction.query<RunRow>(
        'SELECT id,run_snapshot_id,state,delivery_status,cleanup_state,scope_snapshot,created_at FROM app.runs WHERE project_id=$1 AND id=$2',
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有该运行。', 404);
    return {
      id: row.id,
      runSnapshotId: row.run_snapshot_id,
      state: row.state,
      deliveryStatus: row.delivery_status,
      cleanupState: row.cleanup_state,
      scope: executionScopeSchema.parse(row.scope_snapshot),
      createdAt: row.created_at.toISOString(),
    };
  }
  async run(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      return {
        run: await this.publicRunInTransaction(transaction, projectId, id),
      };
    });
  }
}
