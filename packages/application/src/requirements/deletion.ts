import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  requirementDeletionInputSchema,
  requirementDeletionPreviewSchema,
  requirementDeletionReceiptSchema,
} from '../../../contracts/src/requirement-deletion.js';
import { materialSchema } from '../../../contracts/src/domain.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { canonicalJson, OperationService } from '../operations/service.js';
import { recordOperationFence } from '../recovery/fences.js';

const sha = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const versionManifest = z.array(
  z.strictObject({
    id: z.uuid(),
    materialSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
const resourceManifest = z.array(
  z.strictObject({
    id: z.uuid(),
    ownerId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.string().regex(/^\d+$/),
    action: z.enum(['delete', 'retain']),
  }),
);
const commandManifest = z.array(
  z.strictObject({
    id: z.uuid(),
    actorId: z.uuid(),
    operation: z.string(),
    key: z.string(),
    requestHash: z.string(),
    projectId: z.uuid().nullable(),
  }),
);
export const requirementDeletionEventSchema = z.strictObject({
  id: z.uuid(),
  project_id: z.uuid(),
  requirement_id: z.uuid(),
  actor_id: z.uuid(),
  command_key: z.string(),
  request_hash: z.string(),
  scope_digest: z.string(),
  source_row_version: z.number().int().positive(),
  version_manifest: versionManifest,
  resource_manifest: resourceManifest,
  redacted_commands: commandManifest,
  receipt: requirementDeletionReceiptSchema,
  created_at: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value).toISOString()),
});
interface RootRow {
  id: string;
  project_id: string;
  row_version: number;
}
interface VersionRow {
  id: string;
  material_set_digest: string;
  materials: unknown;
}
interface FileRow {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  owner_scope: string;
  original_name: string;
  declared_bytes: string;
  declared_sha256: string;
  row_version: number;
  storage_key: string | null;
  deleted_at: Date | null;
}
const absent = () => new DomainError('NOT_FOUND', '此项目内没有该需求。', 404),
  invalid = () =>
    new DomainError(
      'BUSINESS_CONFLICT',
      '材料引用或删除控制不一致；未删除需求/文件，请先核对。',
      409,
    );
export async function requirementDeletionReady(tx: SqlExecutor) {
  return Boolean(
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.requirement_deletion_events') IS NOT NULL ready",
      )
    ).rows[0]?.ready,
  );
}

async function impact(
  tx: SqlExecutor,
  projectId: string,
  id: string,
  lock = false,
) {
  const root = (
    await tx.query<RootRow>(
      `SELECT id,project_id,row_version FROM app.requirements WHERE project_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
      [projectId, id],
    )
  ).rows[0];
  if (!root) throw absent();
  const versions = (
      await tx.query<VersionRow>(
        `SELECT id,material_set_digest,materials FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2 ORDER BY version_no${lock ? ' FOR UPDATE' : ''}`,
        [projectId, id],
      )
    ).rows,
    versionIds = versions.map((row) => row.id),
    ids = new Set<string>();
  for (const version of versions)
    for (const material of materialSchema.array().parse(version.materials))
      if (material.fileResourceId) ids.add(material.fileResourceId);
  const refs = (
    await tx.query<{ resource_id: string; project_id: string | null }>(
      "SELECT resource_id,project_id FROM app.resource_references WHERE reference_type='requirementVersion' AND reference_id=ANY($1::uuid[])",
      [versionIds],
    )
  ).rows;
  for (const ref of refs) {
    if (ref.project_id !== projectId) throw invalid();
    ids.add(ref.resource_id);
  }
  const rows = (
    await tx.query<FileRow>(
      `SELECT id,owner_user_id,project_id,owner_scope,original_name,declared_bytes::text,declared_sha256,row_version,storage_key,deleted_at FROM app.file_resources WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [Array.from(ids)],
    )
  ).rows;
  if (
    rows.length !== ids.size ||
    rows.some(
      (file) => file.owner_scope !== 'project' || file.project_id !== projectId,
    )
  )
    throw invalid();
  const files = [];
  for (const file of rows) {
    const protectedRefs = (
      await tx.query<{ id: string }>(
        `SELECT id FROM app.resource_references WHERE resource_id=$1 AND NOT(reference_type='requirementVersion' AND reference_id=ANY($2::uuid[]) AND project_id=$3) ORDER BY id`,
        [file.id, versionIds, projectId],
      )
    ).rows.map((row) => row.id);
    const otherMaterials = (
      await tx.query<{ id: string }>(
        `SELECT v.id FROM app.requirement_versions v WHERE NOT(v.id=ANY($1::uuid[])) AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.materials) m WHERE m->>'fileResourceId'=$2) ORDER BY id`,
        [versionIds, file.id],
      )
    ).rows.map((row) => row.id);
    const aliases = (
      await tx.query<{ id: string }>(
        'SELECT id FROM app.file_resources WHERE storage_key=$1 AND id<>$2 AND deleted_at IS NULL ORDER BY id',
        [file.storage_key, file.id],
      )
    ).rows.map((row) => row.id);
    files.push({
      file,
      action:
        protectedRefs.length || otherMaterials.length
          ? ('retain' as const)
          : ('delete' as const),
      physicalShared: aliases.length > 0,
      referenceDigest: sha({ protectedRefs, otherMaterials, aliases }),
    });
  }
  const protectedHistory = Boolean(
      (
        await tx.query<{ protected: boolean }>(
          'SELECT app.requirement_has_protected_history($1,$2) protected',
          [projectId, id],
        )
      ).rows[0]?.protected,
    ),
    context = {
      requirementId: id,
      projectId,
      rowVersion: root.row_version,
      versions: versions.map((row) => ({
        id: row.id,
        materialSetDigest: row.material_set_digest,
      })),
      resources: files.map(({ file, action, referenceDigest }) => ({
        id: file.id,
        ownerId: file.owner_user_id,
        sha256: file.declared_sha256,
        bytes: file.declared_bytes,
        rowVersion: file.row_version,
        action,
        referenceDigest,
      })),
      protectedHistory,
    };
  return {
    root,
    versions,
    versionIds,
    files,
    protectedHistory,
    scopeDigest: sha(context),
    context,
  };
}

/** Trusted restore port as well as the final authorized delete transaction. No network/object delete here. */
export async function applyRequirementDeletionInTransaction(
  tx: SqlExecutor,
  raw: unknown,
  options: {
    resourcesOnly?: boolean;
    deferResources?: boolean;
    restoring?: boolean;
    willDeleteResources?: ReadonlySet<string>;
  } = {},
) {
  const event = requirementDeletionEventSchema.parse(raw),
    existing = (
      await tx.query(
        'SELECT to_jsonb(e) row FROM app.requirement_deletion_events e WHERE requirement_id=$1',
        [event.requirement_id],
      )
    ).rows[0];
  if (existing) {
    const current = requirementDeletionEventSchema.parse(existing.row);
    if (canonicalJson(current) !== canonicalJson(event)) throw invalid();
  } else if (options.resourcesOnly) throw invalid();
  else
    await tx.query(
      'INSERT INTO app.requirement_deletion_events SELECT (jsonb_populate_record(NULL::app.requirement_deletion_events,$1::jsonb)).*',
      [JSON.stringify(event)],
    );
  if (options.resourcesOnly) {
    await applyResourceControls(tx, event, options);
    return event.receipt;
  }
  const root = (
    await tx.query<RootRow>(
      'SELECT id,project_id,row_version FROM app.requirements WHERE id=$1 FOR UPDATE',
      [event.requirement_id],
    )
  ).rows[0];
  if (root && root.project_id !== event.project_id) throw invalid();
  if (
    root &&
    (
      await tx.query<{ protected: boolean }>(
        'SELECT app.requirement_has_protected_history($1,$2) protected',
        [event.project_id, event.requirement_id],
      )
    ).rows[0]?.protected
  )
    throw invalid();
  const versions = (
    await tx.query<VersionRow>(
      'SELECT id,material_set_digest,materials FROM app.requirement_versions WHERE requirement_id=$1 ORDER BY id FOR UPDATE',
      [event.requirement_id],
    )
  ).rows;
  for (const version of versions)
    if (
      !event.version_manifest.some(
        (entry) =>
          entry.id === version.id &&
          entry.materialSetDigest === version.material_set_digest,
      )
    )
      throw invalid();
  for (const command of event.redacted_commands) {
    const old = (
      await tx.query<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3 FOR UPDATE',
        [command.actorId, command.operation, command.key],
      )
    ).rows[0];
    if (
      old &&
      (old.id !== command.id || old.request_hash !== command.requestHash)
    )
      throw invalid();
    if (old)
      await tx.query(
        'UPDATE app.commands SET response=NULL,response_redacted_at=COALESCE(response_redacted_at,$2),updated_at=clock_timestamp() WHERE id=$1',
        [old.id, event.created_at],
      );
    await recordOperationFence(tx, {
      actorId: command.actorId,
      operation: command.operation,
      key: command.key,
      requestHash: command.requestHash,
      commandId: command.id,
      projectId: command.projectId,
    });
  }
  await recordOperationFence(tx, {
    actorId: event.actor_id,
    operation: 'requirements.delete-unused',
    key: event.command_key,
    requestHash: event.request_hash,
    commandId: event.id,
    projectId: event.project_id,
  });
  const versionIds = event.version_manifest.map((row) => row.id);
  await tx.query(
    "DELETE FROM app.resource_references WHERE project_id=$1 AND reference_type='requirementVersion' AND reference_id=ANY($2::uuid[])",
    [event.project_id, versionIds],
  );
  await tx.query(
    'UPDATE app.ai_conversation_preferences SET last_requirement_id=NULL,last_project_id=NULL,row_version=row_version+1 WHERE last_requirement_id=$1',
    [event.requirement_id],
  );
  if (
    (
      await tx.query<{ ready: boolean }>(
        "SELECT to_regclass('app.automatic_auxiliary_intents') IS NOT NULL ready",
      )
    ).rows[0]?.ready
  )
    await tx.query(
      'DELETE FROM app.automatic_auxiliary_intents WHERE requirement_id=$1 AND NOT protected_history',
      [event.requirement_id],
    );
  await tx.query(
    'DELETE FROM app.ai_requirement_groups WHERE requirement_id=$1',
    [event.requirement_id],
  );
  await tx.query(
    'DELETE FROM app.requirement_participants WHERE requirement_id=$1',
    [event.requirement_id],
  );
  await tx.query(
    'DELETE FROM app.requirement_versions WHERE requirement_id=$1',
    [event.requirement_id],
  );
  await tx.query('DELETE FROM app.requirements WHERE id=$1', [
    event.requirement_id,
  ]);
  if (!options.deferResources) await applyResourceControls(tx, event, options);
  tx.noteSecurityControlChange?.({
    action: 'requirement.permanently-deleted',
    objectId: event.requirement_id,
    projectId: event.project_id,
  });
  return event.receipt;
}
async function applyResourceControls(
  tx: SqlExecutor,
  event: z.infer<typeof requirementDeletionEventSchema>,
  options: { restoring?: boolean; willDeleteResources?: ReadonlySet<string> },
) {
  for (const resource of event.resource_manifest) {
    const file = (
      await tx.query<FileRow>(
        'SELECT id,owner_user_id,project_id,owner_scope,storage_key,declared_bytes::text,declared_sha256,deleted_at FROM app.file_resources WHERE id=$1 FOR UPDATE',
        [resource.id],
      )
    ).rows[0];
    if (!file) continue;
    if (
      file.owner_scope !== 'project' ||
      file.project_id !== event.project_id ||
      file.owner_user_id !== resource.ownerId ||
      file.declared_sha256 !== resource.sha256 ||
      file.declared_bytes !== resource.bytes
    )
      throw invalid();
    const referenced =
      Boolean(
        (
          await tx.query(
            'SELECT 1 FROM app.resource_references WHERE resource_id=$1 LIMIT 1',
            [file.id],
          )
        ).rowCount,
      ) ||
      Boolean(
        (
          await tx.query(
            "SELECT 1 FROM app.requirement_versions v WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v.materials) m WHERE m->>'fileResourceId'=$1) LIMIT 1",
            [file.id],
          )
        ).rowCount,
      );
    if (resource.action === 'retain') {
      if (
        options.restoring &&
        !file.deleted_at &&
        !referenced &&
        !options.willDeleteResources?.has(file.id)
      )
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '最新删除控制保留的复用原件缺少此备份中的关联，目标保持隔离核对；未回收该原件。',
          503,
        );
      continue;
    }
    if (referenced) throw invalid();
    await tx.query(
      'UPDATE app.file_resources SET deleted_at=COALESCE(deleted_at,$2),row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [file.id, event.created_at],
    );
    if (file.storage_key)
      await tx.query(
        "INSERT INTO app.operations_file_gc(id,resource_id,storage_key,reason) VALUES($1,$2,$3,'requirementDeletion') ON CONFLICT DO NOTHING",
        [randomUUID(), file.id, file.storage_key],
      );
  }
}

export class RequirementDeletionService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async confirmation(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementDeletionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'requirements.write');
      if (!(await requirementDeletionReady(tx)))
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '需求删除迁移尚未启用。',
          503,
        );
      const known = (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM app.requirement_deletion_events WHERE actor_id=$1 AND command_key=$2',
          [actor.userId, input.commandId],
        )
      ).rows[0];
      if (known) {
        if (
          known.request_hash !==
          sha({ input: { projectId, id, ...input }, projectId })
        )
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            '相同删除标识已用于不同内容。',
            409,
          );
        return undefined;
      }
      const preview = (
        await tx.query<{
          scope_digest: string;
          row_version: number;
          expires_at: Date;
          consumed_at: Date | null;
          payload: { protectedHistory?: boolean };
        }>(
          'SELECT scope_digest,row_version,expires_at,consumed_at,payload FROM app.requirement_deletion_previews WHERE id=$1 AND project_id=$2 AND requirement_id=$3 AND actor_id=$4',
          [input.previewId, projectId, id, actor.userId],
        )
      ).rows[0];
      if (
        !preview ||
        preview.consumed_at ||
        preview.expires_at.getTime() <= Date.now()
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '删除预览已失效，请重新核对。',
          409,
        );
      if (
        preview.scope_digest !== input.scopeDigest ||
        preview.row_version !== input.rowVersion
      )
        stale();
      if (preview.payload.protectedHistory)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '存在受保护历史，仅可归档保留。',
          422,
        );
      return {
        reason: 'impact' as const,
        summary:
          '永久删除此无受保护历史的需求及其未使用材料版本；原件按已展示影响处理。',
        scope: { projectId, requirementId: id, ...input },
        links: [`/api/v1/projects/${projectId}/requirements/${id}`],
      };
    });
  }
  async preview(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'requirements.write');
      if (!(await requirementDeletionReady(tx)))
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '需求删除迁移尚未启用。',
          503,
        );
      const scope = await impact(tx, projectId, z.uuid().parse(id)),
        previewId = randomUUID(),
        expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      await tx.query(
        'INSERT INTO app.requirement_deletion_previews(id,project_id,requirement_id,actor_id,row_version,scope_digest,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          previewId,
          projectId,
          id,
          actor.userId,
          scope.root.row_version,
          scope.scopeDigest,
          JSON.stringify(scope.context),
          expiresAt,
        ],
      );
      return requirementDeletionPreviewSchema.parse({
        previewId,
        requirementId: id,
        rowVersion: scope.root.row_version,
        scopeDigest: scope.scopeDigest,
        expiresAt,
        canDelete: !scope.protectedHistory,
        recommendedAction: scope.protectedHistory ? 'archive' : 'delete',
        protectedHistory: scope.protectedHistory,
        versionCount: scope.versions.length,
        files: scope.files.map(({ file, action, physicalShared }) => ({
          id: file.id,
          originalName: file.original_name,
          bytes: file.declared_bytes,
          sha256: file.declared_sha256,
          action:
            action === 'delete'
              ? physicalShared
                ? 'deleteResourceKeepSharedBytes'
                : 'deleteExclusiveFile'
              : 'retainReferencedFile',
        })),
      });
    });
  }
  async receipt(
    actor: ActorContext,
    projectId: string,
    id: string,
    key: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'requirements.write');
      if (!(await requirementDeletionReady(tx))) throw absent();
      const row = (
        await tx.query<{ receipt: unknown }>(
          'SELECT receipt FROM app.requirement_deletion_events WHERE project_id=$1 AND requirement_id=$2 AND actor_id=$3 AND command_key=$4',
          [
            projectId,
            z.uuid().parse(id),
            actor.userId,
            z.string().min(8).max(128).parse(key),
          ],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          'NOT_FOUND',
          '尚未取得此本人删除回执；未查到不表示原操作未受理。',
          404,
        );
      return { receipt: requirementDeletionReceiptSchema.parse(row.receipt) };
    });
  }
  async commit(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = requirementDeletionInputSchema.parse(raw),
      operationInput = { projectId, id, ...input },
      requestHash = sha({ input: operationInput, projectId });
    const known = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'requirements.write');
      if (!(await requirementDeletionReady(tx)))
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '需求删除迁移尚未启用。',
          503,
        );
      return (
        await tx.query<{ request_hash: string; receipt: unknown }>(
          'SELECT request_hash,receipt FROM app.requirement_deletion_events WHERE actor_id=$1 AND command_key=$2',
          [actor.userId, input.commandId],
        )
      ).rows[0];
    });
    if (known) {
      if (known.request_hash !== requestHash)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '相同删除标识已用于不同内容。',
          409,
        );
      return requirementDeletionReceiptSchema.parse(known.receipt);
    }
    try {
      return await this.operations.execute(
        actor,
        'requirements.delete-unused',
        input.commandId,
        operationInput,
        async (tx) => {
          await requireProject(tx, actor, projectId, 'requirements.write');
        },
        async (tx) => {
          const preview = (
            await tx.query<{
              scope_digest: string;
              row_version: number;
              expires_at: Date;
              consumed_at: Date | null;
            }>(
              'SELECT scope_digest,row_version,expires_at,consumed_at FROM app.requirement_deletion_previews WHERE id=$1 AND project_id=$2 AND requirement_id=$3 AND actor_id=$4 FOR UPDATE',
              [input.previewId, projectId, id, actor.userId],
            )
          ).rows[0];
          if (
            !preview ||
            preview.consumed_at ||
            preview.expires_at.getTime() <= Date.now()
          )
            throw new DomainError(
              'BUSINESS_CONFLICT',
              '删除预览已失效，请重新核对当前影响。',
              409,
            );
          if (
            preview.scope_digest !== input.scopeDigest ||
            preview.row_version !== input.rowVersion
          )
            stale();
          const scope = await impact(tx, projectId, id, true);
          if (
            scope.root.row_version !== input.rowVersion ||
            scope.scopeDigest !== input.scopeDigest
          )
            stale();
          if (scope.protectedHistory)
            throw new DomainError(
              'PRECONDITIONS_MISSING',
              '需求存在受保护历史，仅可归档保留。',
              422,
            );
          const commands = (
            await tx.query<{
              id: string;
              actor_id: string;
              operation: string;
              key: string;
              request_hash: string;
              project_id: string | null;
            }>(
              `SELECT id,actor_id,operation,key,request_hash,project_id FROM app.commands WHERE project_id=$1 AND operation LIKE 'requirements.%' AND(response#>>'{requirement,id}'=$2 OR response#>>'{version,requirementId}'=$2) ORDER BY id FOR UPDATE`,
              [projectId, id],
            )
          ).rows;
          const self = (
              await tx.query<{ id: string }>(
                'SELECT id FROM app.commands WHERE actor_id=$1 AND operation=$2 AND key=$3',
                [actor.userId, 'requirements.delete-unused', input.commandId],
              )
            ).rows[0]!,
            createdAt = (
              await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
            ).rows[0]!.now.toISOString(),
            receipt = requirementDeletionReceiptSchema.parse({
              commandId: input.commandId,
              requirementId: id,
              deleted: true,
              deletedAt: createdAt,
              removedVersionCount: scope.versions.length,
              exclusiveFileCount: scope.files.filter(
                (file) => file.action === 'delete' && !file.physicalShared,
              ).length,
              retainedFileCount: scope.files.filter(
                (file) => file.action === 'retain' || file.physicalShared,
              ).length,
              fileCleanup: 'queuedOrNoBytes',
            });
          const event = {
            id: self.id,
            project_id: projectId,
            requirement_id: id,
            actor_id: actor.userId,
            command_key: input.commandId,
            request_hash: requestHash,
            scope_digest: input.scopeDigest,
            source_row_version: input.rowVersion,
            version_manifest: scope.versions.map((row) => ({
              id: row.id,
              materialSetDigest: row.material_set_digest,
            })),
            resource_manifest: scope.files.map(({ file, action }) => ({
              id: file.id,
              ownerId: file.owner_user_id,
              sha256: file.declared_sha256,
              bytes: file.declared_bytes,
              action,
            })),
            redacted_commands: commands.map((row) => ({
              id: row.id,
              actorId: row.actor_id,
              operation: row.operation,
              key: row.key,
              requestHash: row.request_hash,
              projectId: row.project_id,
            })),
            receipt,
            created_at: createdAt,
          };
          await applyRequirementDeletionInTransaction(tx, event);
          await tx.query(
            'UPDATE app.requirement_deletion_previews SET consumed_at=clock_timestamp() WHERE id=$1',
            [input.previewId],
          );
          await audit(
            tx,
            actor,
            'requirement.permanently-deleted',
            id,
            projectId,
            {
              deletionEventId: event.id,
              removedVersionCount: receipt.removedVersionCount,
              exclusiveFileCount: receipt.exclusiveFileCount,
              retainedFileCount: receipt.retainedFileCount,
            },
          );
          return receipt;
        },
        projectId,
      );
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['40P01', '23503', '55P03'].includes(String(error.code))
      )
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '删除与新关联发生并发变化，未删除；请刷新重新核对。',
          409,
        );
      throw error;
    }
  }
}
