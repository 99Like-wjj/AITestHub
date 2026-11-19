import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  assetChangeSetSchema,
  caseContentSchema,
  scenarioContentSchema,
} from '../../../contracts/src/domain.js';
import {
  assetListQuerySchema,
  createCaseInputSchema,
  createScenarioInputSchema,
  createSetInputSchema,
  removeAssetInputSchema,
  reviseAssetInputSchema,
  setContentSchema,
  assetReceiptOperationSchema,
  assetOperationStatusSchema,
  type AssetContent,
  type AssetTargetType,
} from '../../../contracts/src/assets.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { audit } from '../events.js';
import { DomainError, stale } from '../errors.js';
import { OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  assetDto,
  assetSelect,
  getAsset,
  invalidateAncestors,
  invalidateDescendants,
  lockSet,
  type AssetRow,
} from './repository.js';

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
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const rows = await transaction.query<AssetRow>(
        `${assetSelect} WHERE a.project_id=$1 AND a.kind=$2
        AND ($3::uuid IS NULL OR a.requirement_version_id=$3) AND ($4::uuid IS NULL OR a.set_id=$4)
        AND ($5 OR a.removed_at IS NULL) AND ($6 OR NOT EXISTS(SELECT 1 FROM app.requirement_versions av JOIN app.requirements ar ON ar.id=av.requirement_id AND ar.project_id=av.project_id WHERE av.id=a.requirement_version_id AND av.project_id=a.project_id AND ar.archived_at IS NOT NULL)) ORDER BY a.created_at,a.id LIMIT 10000`,
        [
          projectId,
          input.kind,
          input.requirementVersionId ?? null,
          input.setId ?? null,
          input.includeRemoved,
          input.includeArchivedRequirements,
        ],
      );
      return { assets: rows.rows.map(assetDto) };
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (transaction) => {
      await requireProject(transaction, actor, projectId, 'project.read');
      const asset = await getAsset(transaction, projectId, id, true);
      const revisions = await transaction.query<{
        id: string;
        revision_no: number;
        content: unknown;
        created_at: Date;
      }>(
        'SELECT id,revision_no,content,created_at FROM app.asset_revisions WHERE asset_id=$1 ORDER BY revision_no',
        [id],
      );
      return {
        asset: assetDto(asset),
        revisions: revisions.rows.map((row) => ({
          id: row.id,
          revisionNo: row.revision_no,
          content: row.content,
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
        scenario_count: number;
        case_count: number;
      }>(
        `SELECT r.id,r.title,r.archived_at IS NOT NULL archived,v.id version_id,v.version_no,
          count(a.id) FILTER(WHERE a.target_type='scenario')::integer scenario_count,
          count(a.id) FILTER(WHERE a.target_type='case')::integer case_count
         FROM app.requirements r JOIN app.requirement_versions v ON v.requirement_id=r.id AND v.project_id=r.project_id
         LEFT JOIN app.test_assets a ON a.project_id=r.project_id AND a.requirement_version_id=v.id AND a.kind=$2 AND a.removed_at IS NULL
         WHERE r.project_id=$1 AND ($3 OR r.archived_at IS NULL) GROUP BY r.id,r.title,r.archived_at,v.id,v.version_no ORDER BY r.created_at,r.id,v.version_no DESC`,
        [projectId, kind, includeArchivedRequirements],
      );
      const requirements = new Map<
        string,
        {
          id: string;
          title: string;
          archived: boolean;
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
        await requireProject(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => ({
        asset: assetDto(
          await this.insert(
            transaction,
            actor,
            projectId,
            input.kind,
            input.requirementVersionId,
            'set',
            input.content,
            null,
          ),
        ),
      }),
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
        await requireProject(transaction, actor, projectId, 'assets.write');
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
        await requireProject(transaction, actor, projectId, 'assets.write');
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
            ),
          ),
        };
      },
      projectId,
    );
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
        await requireProject(transaction, actor, projectId, 'assets.write');
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
  private parseContent(
    type: AssetTargetType,
    raw: unknown,
    parent: AssetRow | null,
    kind: 'UI' | 'API',
    versionId: string,
  ): AssetContent {
    if (type === 'set') return setContentSchema.parse(raw);
    if (type === 'scenario') {
      const content = scenarioContentSchema.parse(raw);
      if (
        content.kind !== kind ||
        content.setId !== parent?.id ||
        content.requirementVersionId !== versionId
      ) {
        throw new DomainError(
          'VALIDATION_ERROR',
          '场景的类型、批次或需求版本与父项不一致。',
          400,
        );
      }
      return content;
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
  ) {
    const content = this.parseContent(type, raw, parent, kind, versionId);
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
      `INSERT INTO app.asset_revisions(id,asset_id,project_id,kind,requirement_version_id,set_id,target_type,revision_no,content,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9)`,
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
    input: { baseRevisionId: string; rowVersion?: number; content: unknown },
  ) {
    const preliminary = await getAsset(transaction, projectId, id);
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
    const content = this.parseContent(
      current.target_type,
      input.content,
      parent,
      current.kind,
      current.requirement_version_id,
    );
    const revisionId = randomUUID();
    await transaction.query(
      `INSERT INTO app.asset_revisions(id,asset_id,project_id,kind,requirement_version_id,set_id,target_type,revision_no,content,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
    await lockSet(transaction, projectId, preliminary.set_id);
    const current = await getAsset(transaction, projectId, id);
    if (
      current.current_revision_id !== input.baseRevisionId ||
      (input.rowVersion !== undefined &&
        current.row_version !== input.rowVersion)
    )
      stale();
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
        await requireProject(transaction, actor, projectId, 'assets.write');
      },
      async (transaction) => {
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
                  parent.requirement_version_id !==
                    input.requirementVersionId ||
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
                    requirementVersionId: input.requirementVersionId,
                  };
                if (operation.targetType === 'case' && 'scenarioId' in content)
                  content = { ...content, scenarioId: parent.id };
              }
              asset = await this.insert(
                transaction,
                actor,
                projectId,
                input.kind,
                input.requirementVersionId,
                operation.targetType,
                content,
                parent,
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
                target.requirement_version_id !== input.requirementVersionId ||
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
                      operation,
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
