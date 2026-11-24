import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  apiAutomationArchiveInputSchema,
  apiAutomationCreateCaseInputSchema,
  apiAutomationCreateScenarioInputSchema,
  apiAutomationGetInputSchema,
  apiAutomationListInputSchema,
  apiAutomationListSchema,
  apiAutomationReviseCaseInputSchema,
  apiAutomationReviseScenarioInputSchema,
  apiAutomationRevisionsInputSchema,
  apiAutomationRevisionsSchema,
  apiProjectAssetSchema,
  apiProjectScenarioContentSchema,
  type ApiProjectAsset,
  type ApiProjectScenarioContent,
} from '../../../contracts/src/api-automation.js';
import {
  apiCaseContentSchema,
  apiFlowNodes,
  type ApiCaseContent,
  type ApiFlowNode,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject, requireProjectDraftWrite } from '../access/policy.js';
import { requireApiInterfaceRevision } from '../api-catalog/service.js';
import { requireValidStageSettings } from '../api-execution/stage-actions.js';
import { requireApiSharedScriptRevision } from '../api-execution/shared-scripts.js';
import { getApprovedApiDatabaseRead } from '../api-execution/database-reads.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  lockRequirementForTestAsset,
  requirementBasisJoins,
  requirementBasisProjection,
  requirementOwnerOfVersion,
} from '../requirements/material-lock.js';
import { assertSafeModelInput } from '../security/model-input.js';

type ApiProjectTarget = ApiProjectAsset['targetType'];
type ApiProjectContent = ApiProjectScenarioContent | ApiCaseContent;
type BaseRevision = { baseRevisionId: string; rowVersion: number };

interface ApiProjectAssetRow extends QueryResultRow {
  id: string;
  project_id: string;
  target_type: ApiProjectTarget;
  parent_id: string | null;
  effective_requirement_id: string | null;
  requirement_basis: unknown;
  revision_id: string;
  revision_no: number;
  row_version: number;
  removed_at: Date | null;
  content: unknown;
}

const effectiveRequirementVersion = `CASE WHEN a.target_type='scenario' THEN r.requirement_version_id
  ELSE parent.requirement_version_id END`;
const selectAsset = `SELECT a.id,a.project_id,a.target_type,a.parent_id,a.row_version,a.removed_at,
  r.id revision_id,r.revision_no,r.content,
  ${effectiveRequirementVersion} effective_requirement_id,${requirementBasisProjection}
  FROM app.test_assets a
  JOIN app.asset_revisions r ON r.asset_id=a.id AND r.project_id=a.project_id AND r.kind='API'
  LEFT JOIN app.test_assets parent ON parent.id=a.parent_id AND parent.project_id=a.project_id
  ${requirementBasisJoins('a.project_id', `COALESCE(r.basis_requirement_version_id,${effectiveRequirementVersion})`)}
  WHERE a.project_id=$1 AND a.kind='API' AND a.set_id IS NULL`;

function apiProjectAssetDto(row: ApiProjectAssetRow): ApiProjectAsset {
  const content =
    row.target_type === 'scenario'
      ? apiProjectScenarioContentSchema.parse(row.content)
      : apiCaseContentSchema.parse(row.content);
  return apiProjectAssetSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: 'API',
    targetType: row.target_type,
    parentId: row.parent_id,
    requirementVersionId: row.effective_requirement_id,
    ...(row.requirement_basis
      ? { requirementBasis: row.requirement_basis }
      : {}),
    title: content.title,
    revisionId: row.revision_id,
    revisionNo: row.revision_no,
    rowVersion: row.row_version,
    removedAt: row.removed_at?.toISOString() ?? null,
    content,
  });
}

export async function getApiProjectAsset(
  tx: SqlExecutor,
  projectId: string,
  assetId: string,
  options: {
    revisionId?: string | undefined;
    includeArchived?: boolean;
    lock?: boolean;
  } = {},
): Promise<ApiProjectAsset> {
  const row = (
    await tx.query<ApiProjectAssetRow>(
      `${selectAsset} AND a.id=$2 AND r.id=COALESCE($3::uuid,a.current_revision_id)
      AND ($4 OR a.removed_at IS NULL)${options.lock ? ' FOR UPDATE OF a' : ''}`,
      [
        projectId,
        assetId,
        options.revisionId ?? null,
        options.includeArchived ?? false,
      ],
    )
  ).rows[0];
  if (!row)
    throw new DomainError('NOT_FOUND', '当前项目没有该接口资产或修订。', 404);
  return apiProjectAssetDto(row);
}

function checkScenario(
  asset: ApiProjectAsset,
): asserts asset is Extract<ApiProjectAsset, { targetType: 'scenario' }> {
  if (asset.targetType !== 'scenario')
    throw new DomainError('NOT_FOUND', '当前项目没有该接口场景。', 404);
}

export async function getApiProjectCase(
  tx: SqlExecutor,
  projectId: string,
  assetId: string,
  options?: {
    revisionId?: string | undefined;
    includeArchived?: boolean;
    lock?: boolean;
  },
) {
  const asset = await getApiProjectAsset(tx, projectId, assetId, options);
  if (asset.targetType !== 'case')
    throw new DomainError('NOT_FOUND', '当前项目没有该接口用例。', 404);
  return asset;
}

function guardContent(content: ApiProjectContent) {
  try {
    assertSafeModelInput(content);
  } catch {
    throw new DomainError(
      'VALIDATION_ERROR',
      '接口草稿含疑似明文凭据，请使用配置引用。',
      400,
    );
  }
}

export function assertSingleApiCase(content: ApiCaseContent) {
  if (
    content.scenarioId === null &&
    (content.flow.length !== 1 ||
      content.flow[0]?.type !== 'request' ||
      content.preparations?.length)
  ) {
    throw new DomainError(
      'VALIDATION_ERROR',
      '单接口用例须包含一条请求。多步骤编排请使用场景用例。',
      400,
    );
  }
}

export function assertAuthoredApiCase(content: ApiCaseContent) {
  assertSingleApiCase(content);
  if (
    apiFlowNodes(content.flow).some(
      (node) =>
        node.stageSource ||
        (node.type === 'group' && node.sourceCase) ||
        (node.type === 'script' && node.sharedScriptSource),
    )
  )
    throw new DomainError(
      'VALIDATION_ERROR',
      '请使用固定用例引用和前后置配置，由服务生成只读来源快照。',
      400,
    );
}

export async function validateApiCaseSources(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  content: ApiCaseContent,
  ownId?: string,
): Promise<void> {
  let nodesChecked = 0;
  const check = async (
    owner: string,
    authored: ApiCaseContent,
    chain: readonly string[],
  ): Promise<void> => {
    if (chain.length > 8)
      throw new DomainError('VALIDATION_ERROR', '固定用例引用最多八层。', 400);
    const steps = apiFlowNodes(authored.flow);
    nodesChecked += steps.length;
    if (nodesChecked > 200)
      throw new DomainError(
        'VALIDATION_ERROR',
        '固定用例引用展开后最多二百个节点。',
        400,
      );
    await validateInterfaceSources(tx, actor, owner, authored);
    if (authored.stageSettings)
      await requireValidStageSettings(tx, owner, authored.stageSettings);
    for (const step of authored.steps)
      if (step.stageSettings)
        await requireValidStageSettings(tx, owner, step.stageSettings);
    await getApiFlowReadConnectionIds(tx, owner, steps);
    for (const node of steps) {
      if (node.type === 'sharedScript')
        await requireApiSharedScriptRevision(tx, owner, node);
      if (node.type !== 'case') continue;
      if (chain.includes(node.caseId))
        throw new DomainError(
          'VALIDATION_ERROR',
          '固定用例引用构成循环。',
          400,
        );
      if (node.projectId !== owner)
        await requireProject(tx, actor, node.projectId, 'project.read');
      const child = await getApiProjectCase(tx, node.projectId, node.caseId, {
        revisionId: node.revisionId,
      });
      await check(node.projectId, child.content, [...chain, child.id]);
    }
  };
  await check(projectId, content, ownId ? [ownId] : []);
}

/** Freeze only connections used by project-approved observational queries. */
export async function getApiFlowReadConnectionIds(
  tx: SqlExecutor,
  projectId: string,
  nodes: readonly ApiFlowNode[],
): Promise<string[]> {
  const connections = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'databaseRead') continue;
    const { definition } = await getApprovedApiDatabaseRead(
      tx,
      projectId,
      node.queryId,
    );
    const provided = new Set(Object.keys(node.parameters));
    const expected = new Set(
      definition.filters.map(({ parameter }) => parameter),
    );
    if (
      provided.size !== expected.size ||
      [...provided].some((key) => !expected.has(key))
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '数据库观察参数与已登记查询不一致。',
        400,
      );
    connections.add(definition.connectionId);
  }
  return [...connections];
}

export async function validateInterfaceSources(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  content: ApiCaseContent,
): Promise<void> {
  for (const { source } of content.steps) {
    if (!source) continue;
    if (source.projectId !== projectId)
      await requireProject(tx, actor, source.projectId, 'project.read');
    await requireApiInterfaceRevision(
      tx,
      source.projectId,
      source.interfaceId,
      source.revisionId,
    );
  }
}

async function insertRevision(
  tx: SqlExecutor,
  actor: ActorContext,
  asset: {
    id: string;
    projectId: string;
    targetType: ApiProjectTarget;
    revisionId: string;
    revisionNo: number;
    requirementVersionId: string | null;
    basisRequirementVersionId: string | null;
    content: ApiProjectContent;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO app.asset_revisions(id,asset_id,project_id,kind,requirement_version_id,set_id,target_type,revision_no,content,created_by,basis_requirement_version_id)
     VALUES($1,$2,$3,'API',$4,NULL,$5,$6,$7,$8,$9)`,
    [
      asset.revisionId,
      asset.id,
      asset.projectId,
      asset.requirementVersionId,
      asset.targetType,
      asset.revisionNo,
      JSON.stringify(asset.content),
      actor.userId,
      asset.basisRequirementVersionId,
    ],
  );
}

export async function reviseApiProjectCase(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  assetId: string,
  base: BaseRevision,
  content: ApiCaseContent,
  basisRequirementVersionId?: string,
) {
  const current = await getApiProjectCase(tx, projectId, assetId, {
    lock: true,
  });
  if (
    current.revisionId !== base.baseRevisionId ||
    current.rowVersion !== base.rowVersion
  )
    stale();
  if (content.scenarioId !== current.parentId)
    throw new DomainError(
      'VALIDATION_ERROR',
      '修订用例时其类型和场景位置必须保持一致。',
      400,
    );
  guardContent(content);
  assertAuthoredApiCase(content);
  await validateApiCaseSources(tx, actor, projectId, content, assetId);
  const parent = current.parentId
    ? await getApiProjectAsset(tx, projectId, current.parentId, { lock: true })
    : null;
  const currentOwner = parent?.requirementVersionId
    ? await requirementOwnerOfVersion(
        tx,
        projectId,
        parent.requirementVersionId,
      )
    : null;
  const priorBasis = current.requirementBasis;
  const inheritedBasis =
    priorBasis?.requirementId === currentOwner
      ? priorBasis.basisVersionId
      : undefined;
  const basis = currentOwner
    ? await lockRequirementForTestAsset(tx, projectId, actor.userId, {
        requirementId: currentOwner,
        basisVersionId: basisRequirementVersionId ?? inheritedBasis,
        allowArchived: true,
      })
    : null;
  if (basisRequirementVersionId && !basis)
    throw new DomainError(
      'VALIDATION_ERROR',
      '独立接口用例没有需求资料依据。',
      400,
    );
  const changed = await storeRevision(
    tx,
    actor,
    current,
    content,
    null,
    basis?.basisVersionId ?? current.requirementBasis?.basisVersionId ?? null,
  );
  if (changed.targetType !== 'case')
    throw new Error('接口用例修订类型与所属资产不一致。');
  return changed;
}

async function storeRevision(
  tx: SqlExecutor,
  actor: ActorContext,
  current: ApiProjectAsset,
  content: ApiProjectContent,
  requirementVersionId: string | null,
  basisRequirementVersionId: string | null,
) {
  const revisionId = randomUUID();
  const revisionNo = current.revisionNo + 1;
  await insertRevision(tx, actor, {
    ...current,
    revisionId,
    revisionNo,
    requirementVersionId,
    basisRequirementVersionId,
    content,
  });
  await tx.query(
    `UPDATE app.test_assets SET current_revision_id=$2,revision_no=$3,requirement_version_id=$4,
      row_version=row_version+1,review_state='pending',updated_at=clock_timestamp()
      WHERE id=$1`,
    [current.id, revisionId, revisionNo, requirementVersionId],
  );
  await audit(
    tx,
    actor,
    'assets.api-automation.revised',
    current.id,
    current.projectId,
    {
      revisionId,
      previousRevisionId: current.revisionId,
      requirementVersionId,
    },
  );
  return getApiProjectAsset(tx, current.projectId, current.id);
}

export class ApiAutomationService {
  readonly operations: OperationService;

  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationListInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<ApiProjectAssetRow>(
        `${selectAsset} AND r.id=a.current_revision_id AND ($2 OR a.removed_at IS NULL)
           ORDER BY a.created_at,a.id LIMIT 10000`,
        [projectId, input.includeArchived ?? false],
      );
      const assets = rows.rows.map(apiProjectAssetDto);
      return apiAutomationListSchema.parse({
        scenarios: assets.filter((asset) => asset.targetType === 'scenario'),
        cases: assets.filter((asset) => asset.targetType === 'case'),
      });
    });
  }

  async get(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationGetInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      return getApiProjectAsset(tx, projectId, input.assetId, {
        revisionId: input.revisionId,
        includeArchived: true,
      });
    });
  }

  async revisions(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationRevisionsInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      await getApiProjectAsset(tx, projectId, input.assetId, {
        includeArchived: true,
      });
      const { rows } = await tx.query<{
        id: string;
        revision_no: number;
        created_at: Date;
      }>(
        `SELECT id,revision_no,created_at FROM app.asset_revisions
         WHERE project_id=$1 AND asset_id=$2 AND project_api_owned ORDER BY revision_no DESC`,
        [projectId, input.assetId],
      );
      return apiAutomationRevisionsSchema.parse({
        revisions: rows.map((row) => ({
          revisionId: row.id,
          revisionNo: row.revision_no,
          createdAt: row.created_at.toISOString(),
        })),
      });
    });
  }

  createScenario(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationCreateScenarioInputSchema.parse(raw);
    return this.create(
      actor,
      projectId,
      input.commandId,
      'scenario',
      input.content,
      { requirementId: input.requirementId },
    );
  }

  createCase(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationCreateCaseInputSchema.parse(raw);
    return this.create(
      actor,
      projectId,
      input.commandId,
      'case',
      input.content,
      { basisRequirementVersionId: input.basisRequirementVersionId },
    );
  }

  private create(
    actor: ActorContext,
    projectId: string,
    commandId: string,
    targetType: ApiProjectTarget,
    content: ApiProjectContent,
    scope: {
      requirementId?: string | undefined;
      basisRequirementVersionId?: string | undefined;
    },
  ) {
    return this.write(
      actor,
      projectId,
      `create-${targetType}`,
      commandId,
      scope.requirementId || scope.basisRequirementVersionId
        ? {
            content,
            ...Object.fromEntries(
              Object.entries(scope).filter(([, value]) => value !== undefined),
            ),
          }
        : content,
      async (tx) => {
        guardContent(content);
        const parentId = 'scenarioId' in content ? content.scenarioId : null;
        const authoredScenario =
          'requirementVersionId' in content ? content : null;
        const parent = parentId
          ? await getApiProjectAsset(tx, projectId, parentId, { lock: true })
          : null;
        if (parent) checkScenario(parent);
        const basis =
          authoredScenario &&
          (scope.requirementId || authoredScenario.requirementVersionId)
            ? await lockRequirementForTestAsset(tx, projectId, actor.userId, {
                requirementId: scope.requirementId,
                basisVersionId:
                  authoredScenario.requirementVersionId ?? undefined,
              })
            : parent?.requirementVersionId
              ? await lockRequirementForTestAsset(tx, projectId, actor.userId, {
                  requirementId: await requirementOwnerOfVersion(
                    tx,
                    projectId,
                    parent.requirementVersionId,
                  ),
                  basisVersionId: scope.basisRequirementVersionId,
                })
              : null;
        if (scope.basisRequirementVersionId && !basis)
          throw new DomainError(
            'VALIDATION_ERROR',
            '独立接口用例没有需求资料依据。',
            400,
          );
        const linkedVersion = authoredScenario
          ? (basis?.lockedVersionId ?? null)
          : null;
        const activityVersion =
          linkedVersion ?? parent?.requirementVersionId ?? null;
        if ('scenarioId' in content) {
          assertAuthoredApiCase(content);
          await validateApiCaseSources(tx, actor, projectId, content);
        }
        const id = randomUUID();
        const revisionId = randomUUID();
        await tx.query(
          `INSERT INTO app.test_assets(id,project_id,kind,requirement_version_id,set_id,target_type,parent_id,parent_type,current_revision_id,revision_no,created_by)
         VALUES($1,$2,'API',$3,NULL,$4,$5,$6,$7,1,$8)`,
          [
            id,
            projectId,
            linkedVersion,
            targetType,
            parentId,
            parentId ? 'scenario' : null,
            revisionId,
            actor.userId,
          ],
        );
        await insertRevision(tx, actor, {
          id,
          projectId,
          targetType,
          revisionId,
          revisionNo: 1,
          requirementVersionId: linkedVersion,
          basisRequirementVersionId: basis?.basisVersionId ?? null,
          content: authoredScenario
            ? { ...authoredScenario, requirementVersionId: linkedVersion }
            : content,
        });
        if (activityVersion)
          await recordBusinessActivity(tx, projectId, activityVersion);
        await audit(tx, actor, 'assets.api-automation.created', id, projectId, {
          targetType,
          revisionId,
          parentId,
          requirementVersionId: linkedVersion,
        });
        return getApiProjectAsset(tx, projectId, id);
      },
    );
  }

  reviseScenario(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationReviseScenarioInputSchema.parse(raw);
    return this.write(
      actor,
      projectId,
      'revise-scenario',
      input.commandId,
      input,
      async (tx) => {
        const current = await getApiProjectAsset(tx, projectId, input.assetId, {
          lock: true,
        });
        checkScenario(current);
        if (
          current.revisionId !== input.baseRevisionId ||
          current.rowVersion !== input.rowVersion
        )
          stale();
        const submittedVersion = input.content.requirementVersionId;
        guardContent(input.content);
        const keepsLink =
          !input.requirementId &&
          submittedVersion !== null &&
          submittedVersion === current.requirementVersionId;
        const basis =
          input.requirementId || submittedVersion
            ? await lockRequirementForTestAsset(tx, projectId, actor.userId, {
                requirementId: input.requirementId,
                basisVersionId: keepsLink
                  ? (current.requirementBasis?.basisVersionId ??
                    submittedVersion ??
                    undefined)
                  : (submittedVersion ?? undefined),
                allowArchived: keepsLink,
              })
            : null;
        const versionId = keepsLink
          ? submittedVersion
          : (basis?.lockedVersionId ?? null);
        const changed = await storeRevision(
          tx,
          actor,
          current,
          { ...input.content, requirementVersionId: versionId },
          versionId,
          basis?.basisVersionId ?? null,
        );
        if (versionId) await recordBusinessActivity(tx, projectId, versionId);
        if (
          current.requirementVersionId &&
          versionId !== current.requirementVersionId
        )
          await recordBusinessActivity(
            tx,
            projectId,
            current.requirementVersionId,
          );
        return changed;
      },
    );
  }

  reviseCase(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationReviseCaseInputSchema.parse(raw);
    return this.write(
      actor,
      projectId,
      'revise-case',
      input.commandId,
      input,
      async (tx) => {
        const changed = await reviseApiProjectCase(
          tx,
          actor,
          projectId,
          input.assetId,
          input,
          input.content,
          input.basisRequirementVersionId,
        );
        if (changed.requirementVersionId)
          await recordBusinessActivity(
            tx,
            projectId,
            changed.requirementVersionId,
          );
        return changed;
      },
    );
  }

  archive(actor: ActorContext, projectId: string, raw: unknown) {
    const input = apiAutomationArchiveInputSchema.parse(raw);
    return this.write(
      actor,
      projectId,
      'archive',
      input.commandId,
      input,
      async (tx) => {
        const current = await getApiProjectAsset(tx, projectId, input.assetId, {
          lock: true,
        });
        if (
          current.revisionId !== input.baseRevisionId ||
          current.rowVersion !== input.rowVersion
        )
          stale();
        if (
          current.targetType === 'scenario' &&
          (
            await tx.query(
              'SELECT 1 FROM app.test_assets WHERE project_id=$1 AND parent_id=$2 AND removed_at IS NULL LIMIT 1',
              [projectId, current.id],
            )
          ).rowCount
        )
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '请先归档场景中的用例。',
            422,
          );
        await tx.query(
          'UPDATE app.test_assets SET removed_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1',
          [current.id],
        );
        await audit(
          tx,
          actor,
          'assets.api-automation.archived',
          current.id,
          projectId,
          { revisionId: current.revisionId },
        );
        if (current.requirementVersionId)
          await recordBusinessActivity(
            tx,
            projectId,
            current.requirementVersionId,
          );
        return getApiProjectAsset(tx, projectId, current.id, {
          includeArchived: true,
        });
      },
    );
  }

  private write<T>(
    actor: ActorContext,
    projectId: string,
    operation:
      | 'create-scenario'
      | 'create-case'
      | 'revise-scenario'
      | 'revise-case'
      | 'archive',
    commandId: string,
    input: unknown,
    work: (tx: SqlExecutor) => Promise<T>,
  ) {
    return this.operations.execute(
      actor,
      `assets.api-automation.${operation}`,
      commandId,
      input,
      async (tx) => {
        const authorize =
          operation === 'archive' ? requireProject : requireProjectDraftWrite;
        await authorize(tx, actor, projectId, 'assets.write');
      },
      work,
      projectId,
    );
  }
}
