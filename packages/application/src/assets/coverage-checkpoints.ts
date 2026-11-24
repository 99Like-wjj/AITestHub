import {
  coverageCheckpointListSchema,
  coverageCheckpointSchema,
  coverageCheckpointScopeSchema,
  saveCoverageCheckpointInputSchema,
  type CoverageCheckpoint,
} from '../../../contracts/src/coverage-checkpoints.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject, requireProjectDraftWrite } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import type { AssetRow } from './repository.js';

interface CheckpointRow {
  id: string;
  requirement_version_id: string;
  kind: 'UI' | 'API';
  scenario_id: string | null;
  title: string;
  source: string;
  case_ids: string[];
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

const saveOperation = 'assets.coverage-checkpoint-save';

function checkpoint(row: CheckpointRow): CoverageCheckpoint {
  return coverageCheckpointSchema.parse({
    id: row.id,
    requirementVersionId: row.requirement_version_id,
    kind: row.kind,
    scenarioId: row.scenario_id,
    title: row.title,
    source: row.source,
    caseIds: row.case_ids,
    rowVersion: row.row_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

async function checkVersion(
  tx: SqlExecutor,
  projectId: string,
  versionId: string,
  lock: 'update' | 'share' | false,
) {
  const query = `SELECT r.archived_at FROM app.requirement_versions v
     JOIN app.requirements r ON r.project_id=v.project_id AND r.id=v.requirement_id
     WHERE v.project_id=$1 AND v.id=$2`;
  const { rows } = await tx.query<{ archived_at: Date | null }>(
    lock === 'update'
      ? query + ' FOR UPDATE OF r'
      : lock === 'share'
        ? query + ' FOR SHARE OF r'
        : query,
    [projectId, versionId],
  );
  if (!rows[0])
    throw new DomainError('NOT_FOUND', '此范围内没有该需求版本。', 404);
  if (lock && rows[0].archived_at)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已归档需求不可编辑覆盖检查点。',
      422,
    );
}

export function requireWritableAssetVersion(
  tx: SqlExecutor,
  projectId: string,
  versionId: string,
) {
  return checkVersion(tx, projectId, versionId, 'update');
}

export async function linkCaseToCheckpoint(
  tx: SqlExecutor,
  actor: ActorContext,
  asset: AssetRow,
  input: { id: string; rowVersion: number },
) {
  const { rows } = await tx.query<{ row_version: number }>(
    `UPDATE app.coverage_checkpoints
       SET case_ids=array_append(case_ids,$4),row_version=row_version+1,updated_at=clock_timestamp()
     WHERE project_id=$1 AND requirement_version_id=$2 AND kind=$3
       AND (scenario_id IS NULL OR scenario_id=$5) AND id=$6 AND row_version=$7
       AND cardinality(case_ids)<1000
     RETURNING row_version`,
    [
      asset.project_id,
      asset.requirement_version_id,
      asset.kind,
      asset.id,
      asset.parent_id,
      input.id,
      input.rowVersion,
    ],
  );
  const linked = rows[0];
  if (!linked) stale();
  await audit(
    tx,
    actor,
    'assets.coverage-checkpoint-linked',
    input.id,
    asset.project_id,
    {
      caseId: asset.id,
      revisionId: asset.current_revision_id,
      rowVersion: linked.row_version,
    },
  );
}

export class CoverageCheckpointService {
  private readonly operations: OperationService;

  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }

  async list(actor: ActorContext, projectId: string, raw: unknown) {
    const scope = coverageCheckpointScopeSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      await checkVersion(tx, projectId, scope.requirementVersionId, false);
      const { rows } = await tx.query<CheckpointRow>(
        `SELECT * FROM app.coverage_checkpoints
         WHERE project_id=$1 AND requirement_version_id=$2 AND kind=$3
         ORDER BY created_at, id`,
        [projectId, scope.requirementVersionId, scope.kind],
      );
      return coverageCheckpointListSchema.parse({
        items: rows.map(checkpoint),
      });
    });
  }

  async save(actor: ActorContext, projectId: string, raw: unknown) {
    const input = saveCoverageCheckpointInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      saveOperation,
      input.commandId,
      input,
      async (tx) => {
        await requireProjectDraftWrite(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const references = [
          ...input.caseIds,
          ...(input.scenarioId ? [input.scenarioId] : []),
        ];
        const { rows: assets } = await tx.query<{
          id: string;
          parent_id: string | null;
          target_type: 'case' | 'scenario' | 'set';
        }>(
          `SELECT id,parent_id,target_type FROM app.test_assets
           WHERE project_id=$1 AND requirement_version_id=$2 AND kind=$3
             AND id=ANY($4::uuid[]) AND removed_at IS NULL ORDER BY id FOR SHARE`,
          [projectId, input.requirementVersionId, input.kind, references],
        );
        const byId = new Map(assets.map((asset) => [asset.id, asset]));
        if (
          (input.scenarioId &&
            byId.get(input.scenarioId)?.target_type !== 'scenario') ||
          input.caseIds.some((id) => {
            const asset = byId.get(id);
            return (
              asset?.target_type !== 'case' ||
              (input.scenarioId !== null &&
                asset.parent_id !== input.scenarioId)
            );
          })
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '关联场景和用例须属于同一需求版本及资产类型。',
            400,
          );
        await checkVersion(tx, projectId, input.requirementVersionId, 'share');
        const scope = [projectId, input.requirementVersionId, input.kind];
        const content = [
          input.scenarioId,
          input.title,
          input.source,
          input.caseIds,
        ];
        const { rows } = input.checkpointId
          ? await tx.query<CheckpointRow>(
              `UPDATE app.coverage_checkpoints SET scenario_id=$4,title=$5,source=$6,
                case_ids=$7,row_version=row_version+1,updated_at=clock_timestamp()
               WHERE project_id=$1 AND requirement_version_id=$2 AND kind=$3
                 AND id=$8 AND row_version=$9 RETURNING *`,
              [...scope, ...content, input.checkpointId, input.rowVersion],
            )
          : await tx.query<CheckpointRow>(
              `INSERT INTO app.coverage_checkpoints
                 (project_id,requirement_version_id,kind,scenario_id,title,source,case_ids)
               VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [...scope, ...content],
            );
        const saved = rows[0];
        if (!saved) stale();
        await audit(tx, actor, saveOperation, saved.id, projectId, {
          requirementVersionId: input.requirementVersionId,
          kind: input.kind,
          rowVersion: saved.row_version,
          associationCount: input.caseIds.length,
        });
        return { checkpoint: checkpoint(saved) };
      },
      projectId,
    );
  }

  async receipt(actor: ActorContext, projectId: string, key: string) {
    const result = await this.operations.get(actor, {
      operation: saveOperation,
      key,
    });
    if (result.command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '此范围内没有检查点保存回执。', 404);
    return {
      status: result.command.status,
      response: result.command.response ?? null,
    };
  }
}
