import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  assetChangeSetSchema,
  caseContentSchema,
  requirementAssetBasisSchema,
  type RequirementAssetBasis,
  scenarioContentSchema,
} from '../../../contracts/src/domain.js';
import {
  assetListQuerySchema,
  createCaseInputSchema,
  createScopedCaseInputSchema,
  createScopedSceneInputSchema,
  type CreateScopedCaseInput,
  createScenarioInputSchema,
  createSetInputSchema,
  removeAssetInputSchema,
  removeScopedSceneInputSchema,
  scopedSceneRemovalPreviewSchema,
  reviseAssetInputSchema,
  setContentSchema,
  assetReceiptOperationSchema,
  assetOperationStatusSchema,
  type AssetContent,
  type AssetTargetType,
} from '../../../contracts/src/assets.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  uiCaseImportInputSchema,
  uiCaseImportOperationStatusSchema,
  uiCaseImportPreviewInputSchema,
  uiCaseImportPreviewSchema,
  uiCaseImportReceiptSchema,
  type UiCaseImportReceipt,
} from '../../../contracts/src/ui-case-import.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject, requireProjectDraftWrite } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import { OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  currentRequirementMaterialHead,
  lockRequirementForTestAsset,
  requirementBasisJoins,
  requirementBasisProjection,
  requirementOwnerOfVersion,
} from '../requirements/material-lock.js';
import {
  assetDto,
  assetSelect,
  getAsset,
  invalidateAncestors,
  invalidateDescendants,
  lockSet,
  type AssetRow,
} from './repository.js';

import { linkCaseToCheckpoint } from './coverage-checkpoints.js';

import { recordCaseSupplementOrigin } from './supplement-origin.js';
import { importItemKey, inspectUiCaseImport } from './ui-case-import.js';

function requireUiAsset(kind: 'UI' | 'API'): void {
  if (kind !== 'UI')
    throw new DomainError(
      'VALIDATION_ERROR',
      '接口资产使用项目接口自动化入口与当前编排契约。',
      400,
    );
}

export class AssetService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async operationStatus(
    actor: ActorContext,
    projectId: string,
    commandId: string,
    rawOperation?: unknown,
  ) {
    const operation =
      rawOperation === undefined
        ? undefined
        : assetReceiptOperationSchema.parse(rawOperation);
    const selected = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = (
        await tx.query<{ operation: string }>(
          `SELECT operation FROM app.commands WHERE actor_id=$1 AND project_id=$2 AND key=$3 AND operation=ANY($4::text[]) AND ($5::text IS NULL OR operation=$5) LIMIT 2`,
          [
            actor.userId,
            projectId,
            commandId,
            assetReceiptOperationSchema.options,
            operation ?? null,
          ],
        )
      ).rows;
      if (!rows.length)
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得此本人资产操作回执，保持原标识查询，不自动重发。',
          404,
        );
      if (rows.length > 1)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '同标识用于多种操作，请指定原operation核对，不猜测回执。',
          409,
        );
      return rows[0]!.operation;
    });
    const { command } = await this.operations.get(actor, {
      operation: selected,
      key: commandId,
    });
    if (command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '当前项目没有此操作。', 404);
    return assetOperationStatusSchema.parse({
      commandId,
      operation: selected,
      status: command.status,
      response: command.response,
    });
  }
  async list(actor: ActorContext, projectId: string, raw: unknown) {
    const input = assetListQuerySchema.parse(raw);
    requireUiAsset(input.kind);
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const rows = await transaction.query<AssetRow>(
        `${assetSelect} WHERE a.project_id=$1 AND a.kind=$2
        AND ($3::uuid IS NULL OR a.requirement_version_id=$3) AND ($4::uuid IS NULL OR a.set_id=$4)
        AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM app.requirement_versions scope WHERE scope.project_id=a.project_id AND scope.id=a.requirement_version_id AND scope.requirement_id=$7))
        AND ($5 OR a.removed_at IS NULL) AND ($6 OR NOT EXISTS(SELECT 1 FROM app.requirement_versions av JOIN app.requirements ar ON ar.id=av.requirement_id AND ar.project_id=av.project_id WHERE av.id=a.requirement_version_id AND av.project_id=a.project_id AND ar.archived_at IS NOT NULL)) ORDER BY a.created_at,a.id LIMIT 10000`,
        [
          projectId,
          input.kind,
          input.requirementVersionId ?? null,
          input.setId ?? null,
          input.includeRemoved,
          input.includeArchivedRequirements,
          input.requirementId ?? null,
        ],
      );
      return { assets: rows.rows.map(assetDto) };
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const asset = await getAsset(transaction, projectId, id, true);
      requireUiAsset(asset.kind);
      const revisions = await transaction.query<{
        id: string;
        revision_no: number;
        content: unknown;
        created_at: Date;
        requirement_basis: unknown;
      }>(
        `SELECT r.id,r.revision_no,r.content,r.created_at,${requirementBasisProjection}
         FROM app.asset_revisions r ${requirementBasisJoins('r.project_id', 'COALESCE(r.basis_requirement_version_id,r.requirement_version_id)')}
         WHERE r.asset_id=$1 ORDER BY r.revision_no`,
        [id],
      );
      return {
        asset: assetDto(asset),
        revisions: revisions.rows.map((row) => ({
          id: row.id,
          revisionNo: row.revision_no,
          content: row.content,
          ...(row.requirement_basis
            ? {
                requirementBasis: requirementAssetBasisSchema.parse(
                  row.requirement_basis,
                ),
              }
            : {}),
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }
  async navigation(
    actor: ActorContext,
    projectId: string,
    kind: 'UI' | 'API',
    includeArchivedRequirements = true,
  ) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const rows = await transaction.query<{
        id: string;
        title: string;
        archived: boolean;
        version_id: string;
        version_no: number;
        material_lock_version_id: string | null;
        material_lock_version_no: number | null;
        material_locked_at: Date | null;
        material_locked_by: string | null;
        scenario_count: number;
        case_count: number;
      }>(
        `SELECT r.id,r.title,r.archived_at IS NOT NULL archived,v.id version_id,v.version_no,
          r.material_lock_version_id,locked.version_no material_lock_version_no,r.material_locked_at,r.material_locked_by,
          count(a.id) FILTER(WHERE a.target_type='scenario')::integer scenario_count,
          count(a.id) FILTER(WHERE a.target_type='case')::integer case_count
         FROM app.requirements r JOIN app.requirement_versions v ON v.requirement_id=r.id AND v.project_id=r.project_id
         LEFT JOIN app.requirement_versions locked ON locked.project_id=r.project_id AND locked.id=r.material_lock_version_id
         LEFT JOIN app.test_assets a ON a.project_id=r.project_id AND a.kind=$2 AND a.removed_at IS NULL
           AND (($2='UI' AND a.requirement_version_id=v.id) OR ($2='API' AND a.set_id IS NULL AND (
             a.requirement_version_id=v.id OR EXISTS(
               SELECT 1 FROM app.test_assets parent WHERE parent.id=a.parent_id
                AND parent.project_id=a.project_id AND parent.kind='API'
                AND parent.set_id IS NULL AND parent.requirement_version_id=v.id
             )
           )))
         WHERE r.project_id=$1 AND ($3 OR r.archived_at IS NULL) GROUP BY r.id,r.title,r.archived_at,v.id,v.version_no,locked.version_no ORDER BY r.created_at,r.id,v.version_no DESC`,
        [projectId, kind, includeArchivedRequirements],
      );
      const requirements = new Map<
        string,
        {
          id: string;
          title: string;
          archived: boolean;
          currentVersionId: string;
          materialLock: {
            versionId: string;
            versionNo: number;
            lockedAt: string;
            lockedBy: string | null;
          } | null;
          scenarioCount: number;
          caseCount: number;
          versions: {
            id: string;
            versionNo: number;
            scenarioCount: number;
            caseCount: number;
          }[];
        }
      >();
      for (const row of rows.rows) {
        let requirement = requirements.get(row.id);
        if (!requirement) {
          requirement = {
            id: row.id,
            title: row.title,
            archived: row.archived,
            currentVersionId: row.version_id,
            materialLock:
              row.material_lock_version_id &&
              row.material_lock_version_no &&
              row.material_locked_at
                ? {
                    versionId: row.material_lock_version_id,
                    versionNo: row.material_lock_version_no,
                    lockedAt: row.material_locked_at.toISOString(),
                    lockedBy: row.material_locked_by,
                  }
                : null,
            scenarioCount: 0,
            caseCount: 0,
            versions: [],
          };
          requirements.set(row.id, requirement);
        }
        requirement.versions.push({
          id: row.version_id,
          versionNo: row.version_no,
          scenarioCount: row.scenario_count,
          caseCount: row.case_count,
        });
        requirement.scenarioCount += row.scenario_count;
        requirement.caseCount += row.case_count;
      }
      return { requirements: [...requirements.values()] };
    });
  }
  async createSet(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createSetInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.create-set',
      input.commandId,
      input,
      async (transaction) => {
        await requireProjectDraftWrite(
          transaction,
          actor,
          projectId,
          'assets.write',
        );
      },
      async (transaction) => {
        requireUiAsset(input.kind);
        const basis = await lockRequirementForTestAsset(
          transaction,
          projectId,
          actor.userId,
          {
            requirementId: input.requirementId,
            basisVersionId: input.requirementVersionId,
          },
        );
        return {
          asset: assetDto(
            await this.insert(
              transaction,
              actor,
              projectId,
              input.kind,
              basis.lockedVersionId,
              'set',
              input.content,
              null,
              basis,
            ),
          ),
        };
      },
      projectId,
    );
  }
  async createScenario(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createScenarioInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.create-scenario',
      input.commandId,
      input,
      async (transaction) => {
        await requireProjectDraftWrite(
          transaction,
          actor,
          projectId,
          'assets.write',
        );
      },
      async (transaction) => {
        await lockSet(transaction, projectId, input.setId);
        const parent = await getAsset(transaction, projectId, input.setId);
        if (parent.target_type !== 'set')
          throw new DomainError(
            'VALIDATION_ERROR',
            '场景父项必须为测试集。',
            400,
          );
        const basis = await lockRequirementForTestAsset(
          transaction,
          projectId,
          actor.userId,
          {
            requirementId: await requirementOwnerOfVersion(
              transaction,
              projectId,
              parent.requirement_version_id,
            ),
            basisVersionId:
              input.basisRequirementVersionId ??
              input.content.requirementVersionId,
          },
        );
        return {
          asset: assetDto(
            await this.insert(
              transaction,
              actor,
              projectId,
              parent.kind,
              parent.requirement_version_id,
              'scenario',
              input.content,
              parent,
              basis,
            ),
          ),
        };
      },
      projectId,
    );
  }
  async createCase(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createCaseInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.create-case',
      input.commandId,
      input,
      async (transaction) => {
        await requireProjectDraftWrite(
          transaction,
          actor,
          projectId,
          'assets.write',
        );
      },
      async (transaction) => {
        const preliminary = await getAsset(
          transaction,
          projectId,
          input.scenarioId,
        );
        await lockSet(transaction, projectId, preliminary.set_id);
        const parent = await getAsset(transaction, projectId, input.scenarioId);
        if (parent.target_type !== 'scenario')
          throw new DomainError(
            'VALIDATION_ERROR',
            '用例父项必须为场景。',
            400,
          );
        const basis = await lockRequirementForTestAsset(
          transaction,
          projectId,
          actor.userId,
          {
            requirementId: await requirementOwnerOfVersion(
              transaction,
              projectId,
              parent.requirement_version_id,
            ),
            basisVersionId: input.basisRequirementVersionId,
          },
        );
        return {
          asset: assetDto(
            await this.insert(
              transaction,
              actor,
              projectId,
              parent.kind,
              parent.requirement_version_id,
              'case',
              input.content,
              parent,
              basis,
            ),
          ),
        };
      },
      projectId,
    );
  }
  async createScopedCase(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createScopedCaseInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.create-scoped-case',
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        requireUiAsset(input.kind);
        const { parent, basis } = await this.scopedScenario(
          tx,
          actor,
          projectId,
          input,
        );
        const asset = await this.insert(
          tx,
          actor,
          projectId,
          input.kind,
          parent.requirement_version_id,
          'case',
          { ...input.content, scenarioId: parent.id },
          parent,
          basis,
        );
        if (input.checkpoint)
          await linkCaseToCheckpoint(tx, actor, asset, input.checkpoint);
        if (input.supplementOrigin)
          await recordCaseSupplementOrigin(
            tx,
            actor,
            asset,
            input.supplementOrigin,
          );
        return { asset: assetDto(asset) };
      },
      projectId,
    );
  }

  async createScopedScene(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
  ) {
    const input = createScopedSceneInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.create-scoped-scene',
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const { parent } = await this.scopedScenario(tx, actor, projectId, {
          kind: 'UI',
          requirementId: input.requirementId,
          requirementVersionId: input.requirementVersionId,
          scenario: { ...input.content, setId: input.setId },
        });
        return { asset: assetDto(parent) };
      },
      projectId,
    );
  }

  async previewUiCaseImport(
    actor: ActorContext,
    projectId: string,
    raw: unknown,
  ) {
    const input = uiCaseImportPreviewInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      return uiCaseImportPreviewSchema.parse(
        (await inspectUiCaseImport(tx, projectId, input)).preview,
      );
    });
  }

  async uiCaseImportReceipt(
    actor: ActorContext,
    projectId: string,
    key: string,
  ) {
    const { command } = await this.operations.get(actor, {
      operation: 'assets.ui-import',
      key,
    });
    if (command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '本项目中没有该用例导入回执。', 404);
    return uiCaseImportOperationStatusSchema.parse({
      status: command.status,
      response: command.response,
    });
  }

  async importUiCases(actor: ActorContext, projectId: string, raw: unknown) {
    const input = uiCaseImportInputSchema.parse(raw);
    const selection = new Set(
      input.selection.map(({ packageIndex, caseLocalId }) =>
        importItemKey(packageIndex, caseLocalId),
      ),
    );
    if (selection.size !== input.selection.length)
      throw new DomainError(
        'VALIDATION_ERROR',
        '同一草稿用例只能提交一次。',
        400,
      );
    return this.operations.execute(
      actor,
      'assets.ui-import',
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        await tx.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [projectId + '/' + input.requirementId + '/UI'],
        );
        await tx.query(
          `SELECT a.id FROM app.test_assets a
           JOIN app.requirement_versions v ON v.id=a.requirement_version_id
           WHERE a.project_id=$1 AND v.requirement_id=$2 AND a.kind='UI' AND a.target_type='set' AND a.removed_at IS NULL
           ORDER BY a.id FOR UPDATE OF a`,
          [projectId, input.requirementId],
        );
        const { preview, drafts } = await inspectUiCaseImport(
          tx,
          projectId,
          input,
        );
        if (preview.digest !== input.digest) stale();
        const items: UiCaseImportReceipt['items'] = [];
        const formalCases = new Set<string>();
        for (const pack of preview.packages) {
          const draft = drafts.get(pack.packageIndex);
          if (!draft || pack.errors.length) continue;
          const scenes = new Map(
            draft.scenarios.map((scene) => [scene.localId, scene]),
          );
          const cases = new Map(
            draft.cases.map((item) => [item.localId, item]),
          );
          for (const view of pack.scenes) {
            const scene = scenes.get(view.sceneLocalId);
            const target = view.target;
            const selected = view.cases.filter(
              ({ caseLocalId, action }) =>
                action &&
                selection.has(importItemKey(pack.packageIndex, caseLocalId)),
            );
            if (!scene || !target || view.problems.length || !selected.length)
              continue;
            const { localId, setLocalId, existing, ...fields } = scene;
            const savepoint = 'ui_import_' + items.length;
            await tx.query('SAVEPOINT ' + savepoint);
            const saved: UiCaseImportReceipt['items'] = [];
            try {
              const originalSet = draft.sets.find(
                (set) => set.localId === setLocalId,
              )?.existing;
              const { parent, basis } = await this.scopedScenario(
                tx,
                actor,
                projectId,
                {
                  kind: 'UI',
                  requirementId: input.requirementId,
                  requirementVersionId: draft.requirementVersionId,
                  scenario:
                    target.kind === 'existing'
                      ? { scenarioId: target.sceneId }
                      : {
                          ...fields,
                          title: target.title ?? fields.title,
                          setId: originalSet?.id,
                        },
                },
              );
              for (const { caseLocalId } of selected) {
                const item = cases.get(caseLocalId);
                if (!item)
                  throw new Error('Selected import case was not resolved');
                const {
                  localId: key,
                  scenarioLocalId,
                  existing: base,
                  ...caseFields
                } = item;
                if (base && formalCases.has(base.id))
                  throw new DomainError(
                    'VALIDATION_ERROR',
                    '已有用例在本次导入中重复出现。',
                    400,
                  );
                const content = { ...caseFields, scenarioId: parent.id };
                const result = base
                  ? await this.reviseInTransaction(
                      tx,
                      actor,
                      projectId,
                      base.id,
                      {
                        ...base,
                        content,
                        basisRequirementVersionId: draft.requirementVersionId,
                      },
                    )
                  : await this.insert(
                      tx,
                      actor,
                      projectId,
                      'UI',
                      parent.requirement_version_id,
                      'case',
                      content,
                      parent,
                      basis,
                    );
                if (base) formalCases.add(base.id);
                saved.push({
                  packageIndex: pack.packageIndex,
                  sceneLocalId: scenarioLocalId,
                  caseLocalId: key,
                  status: 'accepted',
                  sceneId: parent.id,
                  assetId: result.id,
                  revisionId: result.current_revision_id,
                });
              }
              if (existing?.action === 'revise') {
                const current = await getAsset(tx, projectId, parent.id);
                await this.reviseInTransaction(
                  tx,
                  actor,
                  projectId,
                  parent.id,
                  {
                    baseRevisionId: existing.baseRevisionId,
                    rowVersion: current.row_version,
                    basisRequirementVersionId: draft.requirementVersionId,
                    content: {
                      ...fields,
                      kind: 'UI',
                      setId: parent.set_id,
                      requirementVersionId: parent.requirement_version_id,
                    },
                  },
                );
              }
              await tx.query('RELEASE SAVEPOINT ' + savepoint);
              items.push(...saved);
            } catch (error: unknown) {
              await tx.query('ROLLBACK TO SAVEPOINT ' + savepoint);
              await tx.query('RELEASE SAVEPOINT ' + savepoint);
              if (
                !(error instanceof DomainError) &&
                !(error instanceof ZodError)
              )
                throw error;
              for (const { caseLocalId } of saved) {
                const targetId = cases.get(caseLocalId)?.existing?.id;
                if (targetId) formalCases.delete(targetId);
              }
              for (const { caseLocalId } of selected) {
                items.push({
                  packageIndex: pack.packageIndex,
                  sceneLocalId: localId,
                  caseLocalId,
                  status: 'rejected',
                  reason:
                    error instanceof DomainError
                      ? error.message
                      : '导入正文不符合用例契约。',
                });
              }
            }
          }
        }
        if (items.length !== selection.size)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '部分所选用例尚不可导入，请重新预览。',
            422,
          );
        return uiCaseImportReceiptSchema.parse({ items });
      },
      projectId,
    );
  }

  private async scopedScenario(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    input: Pick<
      CreateScopedCaseInput,
      'kind' | 'requirementId' | 'requirementVersionId' | 'scenario'
    >,
  ) {
    const requirementId =
      input.requirementId ??
      (input.requirementVersionId
        ? await requirementOwnerOfVersion(
            tx,
            projectId,
            input.requirementVersionId,
          )
        : undefined);
    if (!requirementId)
      throw new DomainError('VALIDATION_ERROR', '请选择用例所属需求。', 400);
    const scope = { requirementId, basisVersionId: input.requirementVersionId };
    const pick = input.scenario;
    const parentId = 'scenarioId' in pick ? pick.scenarioId : pick.setId;
    let chosen: AssetRow | null = null;
    if (parentId) {
      const preliminary = await getAsset(tx, projectId, parentId);
      await lockSet(tx, projectId, preliminary.set_id);
      chosen = await getAsset(tx, projectId, parentId);
      const expectedType = 'scenarioId' in pick ? 'scenario' : 'set';
      if (
        chosen.kind !== input.kind ||
        chosen.target_type !== expectedType ||
        (await requirementOwnerOfVersion(
          tx,
          projectId,
          chosen.requirement_version_id,
        )) !== requirementId
      )
        throw new DomainError(
          'VALIDATION_ERROR',
          '场景或归属须属于所选需求及类型。',
          400,
        );
    }
    const findSets = (versionId: string) =>
      tx.query<{ id: string }>(
        `SELECT id FROM app.test_assets
         WHERE project_id=$1 AND requirement_version_id=$2 AND kind=$3
           AND target_type='set' AND removed_at IS NULL ORDER BY created_at,id LIMIT 1`,
        [projectId, versionId, input.kind],
      );
    if (!parentId) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        projectId + '/' + requirementId + '/' + input.kind,
      ]);
      const head = await currentRequirementMaterialHead(
        tx,
        projectId,
        requirementId,
      );
      const { rows } = await findSets(head.id);
      if (rows[0]) {
        await lockSet(tx, projectId, rows[0].id);
        chosen = await getAsset(tx, projectId, rows[0].id);
      }
    }
    const basis = await lockRequirementForTestAsset(
      tx,
      projectId,
      actor.userId,
      scope,
    );
    if (chosen?.target_type === 'scenario') return { parent: chosen, basis };
    if ('scenarioId' in pick)
      throw new Error('Selected scenario was not resolved');
    if (!chosen && (await findSets(basis.lockedVersionId)).rows.length) stale();
    const set =
      chosen ??
      (await this.insert(
        tx,
        actor,
        projectId,
        input.kind,
        basis.lockedVersionId,
        'set',
        { title: '默认测试集', basisRefs: [] },
        null,
        basis,
      ));
    const parent = await this.insert(
      tx,
      actor,
      projectId,
      input.kind,
      set.requirement_version_id,
      'scenario',
      {
        kind: input.kind,
        requirementVersionId: set.requirement_version_id,
        setId: set.id,
        title: pick.title,
        objective: pick.objective,
        sharedPreconditions: pick.sharedPreconditions,
        basisRefs: pick.basisRefs,
      },
      set,
      basis,
    );
    return { parent, basis };
  }

  async revise(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = reviseAssetInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.revise',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProjectDraftWrite(
          transaction,
          actor,
          projectId,
          'assets.write',
        );
      },
      async (transaction) => ({
        asset: assetDto(
          await this.reviseInTransaction(
            transaction,
            actor,
            projectId,
            id,
            input,
          ),
        ),
      }),
      projectId,
    );
  }
  async explicitRemove(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = removeAssetInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.explicit-remove',
      input.commandId,
      { id, ...input },
      async (transaction) => {
        await requireProject(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => ({
        asset: assetDto(
          await this.removeInTransaction(
            transaction,
            actor,
            projectId,
            id,
            input,
          ),
        ),
      }),
      projectId,
    );
  }

  async scopedSceneRemovalPreview(
    actor: ActorContext,
    projectId: string,
    id: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'assets.write');
      const scene = await getAsset(tx, projectId, id);
      await lockSet(tx, projectId, scene.set_id);
      return this.sceneRemovalScope(tx, await getAsset(tx, projectId, id));
    });
  }

  private async sceneRemovalScope(tx: SqlExecutor, scene: AssetRow) {
    requireUiAsset(scene.kind);
    if (scene.target_type !== 'scenario')
      throw new DomainError('NOT_FOUND', '此范围内没有该场景。', 404);
    const owner = await requirementOwnerOfVersion(
      tx,
      scene.project_id,
      scene.requirement_version_id,
    );
    if (
      (
        await tx.query(
          'SELECT 1 FROM app.requirements WHERE project_id=$1 AND id=$2 AND archived_at IS NOT NULL',
          [scene.project_id, owner],
        )
      ).rowCount
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '已归档需求不能移除用例或场景。',
        422,
      );
    const children = await tx.query<{ id: string }>(
      `SELECT id FROM app.test_assets
       WHERE project_id=$1 AND parent_id=$2 AND target_type='case' AND removed_at IS NULL ORDER BY id`,
      [scene.project_id, scene.id],
    );
    const caseIds = children.rows.map(({ id }) => id);
    const plans = await tx.query(
      `SELECT p.id FROM app.test_plans p
       JOIN app.plan_revisions r ON r.id=p.current_revision_id
       WHERE p.project_id=$1 AND p.kind='UI' AND EXISTS(
         SELECT 1 FROM jsonb_array_elements(r.items) item
         WHERE item->>'caseId'=ANY($2::text[])
       )`,
      [scene.project_id, caseIds],
    );
    return scopedSceneRemovalPreviewSchema.parse({
      sceneId: scene.id,
      baseRevisionId: scene.current_revision_id,
      rowVersion: scene.row_version,
      caseCount: caseIds.length,
      activePlanCount: plans.rowCount ?? 0,
      caseIds,
    });
  }

  async removeScopedScene(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = removeScopedSceneInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'assets.remove-scoped-scene',
      input.commandId,
      { id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const scene = await getAsset(tx, projectId, id);
        await lockSet(tx, projectId, scene.set_id);
        const current = await getAsset(tx, projectId, id);
        const scope = await this.sceneRemovalScope(tx, current);
        const requested = [...input.caseIds].sort();
        if (
          scope.baseRevisionId !== input.baseRevisionId ||
          scope.rowVersion !== input.rowVersion ||
          scope.caseIds.length !== requested.length ||
          scope.caseIds.some((caseId, i) => caseId !== requested[i])
        )
          stale();
        await tx.query(
          `UPDATE app.test_assets SET removed_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()
           WHERE project_id=$1 AND id=ANY($2::uuid[])`,
          [projectId, scope.caseIds],
        );
        const removed = await this.removeInTransaction(
          tx,
          actor,
          projectId,
          id,
          input,
        );
        await audit(tx, actor, 'assets.scene-cases-removed', id, projectId, {
          caseIds: scope.caseIds,
        });
        return { asset: assetDto(removed) };
      },
      projectId,
    );
  }
  private parseContent(
    type: AssetTargetType,
    raw: unknown,
    parent: AssetRow | null,
    kind: 'UI' | 'API',
    versionId: string,
    basisVersionId: string,
  ): AssetContent {
    requireUiAsset(kind);
    if (type === 'set') return setContentSchema.parse(raw);
    if (type === 'scenario') {
      const content = scenarioContentSchema.parse(raw);
      if (
        content.kind !== kind ||
        content.setId !== parent?.id ||
        (content.requirementVersionId !== versionId &&
          content.requirementVersionId !== basisVersionId)
      ) {
        throw new DomainError(
          'VALIDATION_ERROR',
          '场景的类型、批次或需求版本与父项不一致。',
          400,
        );
      }
      return { ...content, requirementVersionId: versionId };
    }
    const content = caseContentSchema.parse(raw);
    if (
      content.kind === 'UI' &&
      (!content.steps?.length || !content.expected.trim())
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        'UI 用例需要文字业务步骤和可判定的整体预期。',
        400,
      );
    if (content.kind !== kind || content.scenarioId !== parent?.id) {
      throw new DomainError(
        'VALIDATION_ERROR',
        '用例类型或场景与父项不一致。',
        400,
      );
    }
    return content;
  }
  private async insert(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    kind: 'UI' | 'API',
    versionId: string,
    type: AssetTargetType,
    raw: unknown,
    parent: AssetRow | null,
    basis: RequirementAssetBasis,
  ) {
    const content = this.parseContent(
      type,
      raw,
      parent,
      kind,
      versionId,
      basis.basisVersionId,
    );
    const id = randomUUID();
    const setId = parent?.set_id ?? id;
    await recordBusinessActivity(transaction, projectId, versionId);
    await transaction.query(
      `INSERT INTO app.test_assets(id,project_id,kind,requirement_version_id,set_id,target_type,parent_id,parent_type,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        projectId,
        kind,
        versionId,
        setId,
        type,
        parent?.id ?? null,
        parent?.target_type ?? null,
        actor.userId,
      ],
    );
    const revisionId = randomUUID();
    await transaction.query(
      `INSERT INTO app.asset_revisions(id,asset_id,project_id,kind,requirement_version_id,set_id,target_type,revision_no,content,created_by,basis_requirement_version_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)`,
      [
        revisionId,
        id,
        projectId,
        kind,
        versionId,
        setId,
        type,
        JSON.stringify(content),
        actor.userId,
        basis.basisVersionId,
      ],
    );
    await transaction.query(
      'UPDATE app.test_assets SET current_revision_id=$2,revision_no=1 WHERE id=$1',
      [id, revisionId],
    );
    const asset = await getAsset(transaction, projectId, id);
    await invalidateAncestors(transaction, asset);
    await audit(transaction, actor, 'assets.created', id, projectId, {
      kind,
      targetType: type,
      revisionId,
    });
    return asset;
  }
  async reviseInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    input: {
      baseRevisionId: string;
      rowVersion?: number | undefined;
      content: unknown;
      basisRequirementVersionId?: string | undefined;
    },
  ) {
    const preliminary = await getAsset(transaction, projectId, id);
    requireUiAsset(preliminary.kind);
    await lockSet(transaction, projectId, preliminary.set_id);
    const current = await getAsset(transaction, projectId, id);
    if (
      current.current_revision_id !== input.baseRevisionId ||
      (input.rowVersion !== undefined &&
        current.row_version !== input.rowVersion)
    )
      stale();
    const parent = current.parent_id
      ? await getAsset(transaction, projectId, current.parent_id)
      : null;
    const previousBasis = requirementAssetBasisSchema.safeParse(
      current.requirement_basis,
    );
    const basis = await lockRequirementForTestAsset(
      transaction,
      projectId,
      actor.userId,
      {
        requirementId: await requirementOwnerOfVersion(
          transaction,
          projectId,
          current.requirement_version_id,
        ),
        basisVersionId:
          input.basisRequirementVersionId ??
          (previousBasis.success
            ? previousBasis.data.basisVersionId
            : current.requirement_version_id),
      },
    );
    const content = this.parseContent(
      current.target_type,
      input.content,
      parent,
      current.kind,
      current.requirement_version_id,
      basis.basisVersionId,
    );
    const revisionId = randomUUID();
    await transaction.query(
      `INSERT INTO app.asset_revisions(id,asset_id,project_id,kind,requirement_version_id,set_id,target_type,revision_no,content,created_by,basis_requirement_version_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        revisionId,
        id,
        projectId,
        current.kind,
        current.requirement_version_id,
        current.set_id,
        current.target_type,
        current.revision_no + 1,
        JSON.stringify(content),
        actor.userId,
        basis.basisVersionId,
      ],
    );
    await transaction.query(
      "UPDATE app.test_assets SET current_revision_id=$2,revision_no=revision_no+1,review_state='pending',row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id, revisionId],
    );
    const changed = await getAsset(transaction, projectId, id);
    await invalidateAncestors(transaction, changed);
    await invalidateDescendants(transaction, changed);
    await recordBusinessActivity(
      transaction,
      projectId,
      current.requirement_version_id,
    );
    await audit(transaction, actor, 'assets.revised', id, projectId, {
      revisionId,
      kind: current.kind,
    });
    return changed;
  }
  private async removeInTransaction(
    transaction: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    input: { baseRevisionId: string; rowVersion?: number },
  ) {
    const preliminary = await getAsset(transaction, projectId, id);
    requireUiAsset(preliminary.kind);
    await lockSet(transaction, projectId, preliminary.set_id);
    const current = await getAsset(transaction, projectId, id);
    if (
      current.current_revision_id !== input.baseRevisionId ||
      (input.rowVersion !== undefined &&
        current.row_version !== input.rowVersion)
    )
      stale();
    const owner = await requirementOwnerOfVersion(
      transaction,
      projectId,
      current.requirement_version_id,
    );
    const requirement = await transaction.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM app.requirements WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [projectId, owner],
    );
    if (requirement.rows[0]?.archived_at)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '已归档需求不能移除用例或场景。',
        422,
      );
    if (
      (
        await transaction.query(
          'SELECT 1 FROM app.test_assets WHERE parent_id=$1 AND removed_at IS NULL LIMIT 1',
          [id],
        )
      ).rowCount
    ) {
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '此项仍有子项，请在明确影响范围后逐项显式移除子项；不会隐式删除集合。',
        422,
      );
    }
    await transaction.query(
      'UPDATE app.test_assets SET removed_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [id],
    );
    await invalidateAncestors(transaction, current);
    await recordBusinessActivity(
      transaction,
      projectId,
      current.requirement_version_id,
    );
    await audit(transaction, actor, 'assets.removed', id, projectId, {
      revisionId: current.current_revision_id,
    });
    return getAsset(transaction, projectId, id, true);
  }
  async submit(actor: ActorContext, projectId: string, raw: unknown) {
    const input = assetChangeSetSchema.parse(raw);
    requireUiAsset(input.kind);
    if (input.projectId !== projectId)
      throw new DomainError(
        'VALIDATION_ERROR',
        '路径项目与提交范围不一致。',
        400,
      );
    const localIds = input.operations
      .filter((operation) => operation.operation === 'create')
      .map((operation) => operation.localId);
    if (new Set(localIds).size !== localIds.length)
      throw new DomainError('VALIDATION_ERROR', '本地资产标识不可重复。', 400);
    return this.operations.execute(
      actor,
      'assets.submit',
      input.submissionId,
      input,
      async (transaction) => {
        const authorize = input.operations.some(
          (operation) => operation.operation === 'explicitRemove',
        )
          ? requireProject
          : requireProjectDraftWrite;
        await authorize(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => {
        const basisOwner = input.requirementVersionId
          ? await requirementOwnerOfVersion(
              transaction,
              projectId,
              input.requirementVersionId,
            )
          : undefined;
        const requirementId = input.requirementId ?? basisOwner;
        if (!requirementId || (basisOwner && basisOwner !== requirementId))
          throw new DomainError('NOT_FOUND', '资料依据不属于所选需求。', 404);
        const setIds = new Set<string>();
        for (const operation of input.operations) {
          const id =
            operation.operation === 'create'
              ? operation.parentId
              : operation.targetId;
          if (id) {
            const target = (
              await transaction.query<{ set_id: string }>(
                'SELECT set_id FROM app.test_assets WHERE project_id=$1 AND id=$2',
                [projectId, id],
              )
            ).rows[0];
            if (target) setIds.add(target.set_id);
          }
        }
        if (setIds.size)
          await transaction.query(
            'SELECT id FROM app.test_assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [[...setIds]],
          );
        const created = new Map<string, string>();
        const items = [];
        for (const [index, operation] of input.operations.entries()) {
          await transaction.query(`SAVEPOINT asset_item_${index}`);
          try {
            let asset: AssetRow;
            if (operation.operation === 'create') {
              if (
                operation.targetType === 'set' &&
                (operation.parentId || operation.parentLocalId)
              ) {
                throw new DomainError(
                  'VALIDATION_ERROR',
                  '测试集为批次根，不能指定其他资产为父项。',
                  400,
                );
              }
              if (operation.parentId && operation.parentLocalId)
                throw new DomainError(
                  'VALIDATION_ERROR',
                  '父项只能使用已存ID或本地ID之一。',
                  400,
                );
              const parentId =
                operation.parentId ??
                (operation.parentLocalId
                  ? created.get(operation.parentLocalId)
                  : undefined);
              const parent = parentId
                ? await getAsset(transaction, projectId, parentId)
                : null;
              if (operation.targetType !== 'set' && !parent)
                throw new DomainError(
                  'PRECONDITIONS_MISSING',
                  '创建子项缺少已成功提交的父项。',
                  422,
                );
              if (
                parent &&
                (parent.kind !== input.kind ||
                  (await requirementOwnerOfVersion(
                    transaction,
                    projectId,
                    parent.requirement_version_id,
                  )) !== requirementId ||
                  parent.target_type !==
                    (operation.targetType === 'case' ? 'scenario' : 'set'))
              )
                throw new DomainError(
                  'VALIDATION_ERROR',
                  '父项的类型/版本/层级与提交范围不一致。',
                  400,
                );
              if (parent) await lockSet(transaction, projectId, parent.set_id);
              let content = operation.content;
              if (operation.parentLocalId && parent) {
                if (
                  operation.targetType === 'scenario' &&
                  'objective' in content
                )
                  content = {
                    ...content,
                    setId: parent.id,
                    requirementVersionId: parent.requirement_version_id,
                  };
                if (operation.targetType === 'case' && 'scenarioId' in content)
                  content = { ...content, scenarioId: parent.id };
              }
              const basis = await lockRequirementForTestAsset(
                transaction,
                projectId,
                actor.userId,
                {
                  requirementId,
                  basisVersionId: input.requirementVersionId,
                },
              );
              asset = await this.insert(
                transaction,
                actor,
                projectId,
                input.kind,
                parent?.requirement_version_id ?? basis.lockedVersionId,
                operation.targetType,
                content,
                parent,
                basis,
              );
              created.set(operation.localId, asset.id);
            } else {
              const target = await getAsset(
                transaction,
                projectId,
                operation.targetId,
              );
              if (
                target.kind !== input.kind ||
                (await requirementOwnerOfVersion(
                  transaction,
                  projectId,
                  target.requirement_version_id,
                )) !== requirementId ||
                target.target_type !== operation.targetType
              )
                throw new DomainError(
                  'NOT_FOUND',
                  '提交范围内没有该目标。',
                  404,
                );
              if (input.baseRevisionMap[target.id] !== operation.baseRevisionId)
                stale();
              asset =
                operation.operation === 'update'
                  ? await this.reviseInTransaction(
                      transaction,
                      actor,
                      projectId,
                      target.id,
                      {
                        ...operation,
                        basisRequirementVersionId: input.requirementVersionId,
                      },
                    )
                  : await this.removeInTransaction(
                      transaction,
                      actor,
                      projectId,
                      target.id,
                      operation,
                    );
            }
            items.push({ index, status: 'accepted', asset: assetDto(asset) });
            await transaction.query(`RELEASE SAVEPOINT asset_item_${index}`);
          } catch (error: unknown) {
            await transaction.query(
              `ROLLBACK TO SAVEPOINT asset_item_${index}`,
            );
            await transaction.query(`RELEASE SAVEPOINT asset_item_${index}`);
            if (!(error instanceof DomainError) && !(error instanceof ZodError))
              throw error;
            items.push({
              index,
              status: 'rejected',
              code:
                error instanceof DomainError ? error.code : 'VALIDATION_ERROR',
              message:
                error instanceof DomainError
                  ? error.message
                  : '资产内容不符合契约。',
            });
          }
        }
        return {
          submissionId: input.submissionId,
          mode: input.mode,
          absenceDeletes: false,
          items,
        };
      },
      projectId,
    );
  }
}
