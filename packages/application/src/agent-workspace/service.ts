import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  workspaceCommandReceiptSchema,
  workspaceEntrySchema,
  workspaceImportSchema,
  workspaceMaximumEntries,
  workspaceMaximumFileBytes,
  workspaceMaximumTextBytes,
  workspaceMutationSchema,
  workspacePutSchema,
  workspaceReceiptSchema,
  workspaceTextInputSchema,
  workspaceProvenanceSchema,
  workspaceSourceSchema,
  type WorkspaceEntry,
} from '../../../contracts/src/agent-workspace.js';
import {
  idSchema,
  persistedRowVersionSchema,
  commandIdSchema,
} from '../../../contracts/src/base.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { conversationRow } from '../conversations/common.js';
import { assertTaskCapability } from '../conversations/task-capabilities.js';
import { DomainError, stale } from '../errors.js';
import { FilesService } from '../files/service.js';
import { registeredFilePolicyIntent } from '../files/resource-policy.js';
import { canonicalJson } from '../operations/service.js';
import { attachOriginalResource } from './originals.js';
import { z } from 'zod';
import { requireProject } from '../access/policy.js';

export interface EntryRow {
  id: string;
  path: string;
  row_version: number;
  revision: number;
  resource_id: string;
  media_type: string;
  declared_bytes: string;
  declared_sha256: string;
  deleted_at: Date | null;
  updated_at: Date;
  resource_deleted_at: Date | null;
  status: string;
  kind: 'original' | 'artifact' | 'legacy';
  original_name: string | null;
  origin_message_id: string | null;
  created_at: Date;
  created_by: string | null;
  created_by_name: string | null;
  message_id: string | null;
  task_id: string | null;
  base_revision: number | null;
  sources: unknown;
}
const visibleSourcesSql = `(SELECT COALESCE(jsonb_agg(source),'[]'::jsonb) FROM jsonb_array_elements(v.sources) source
   JOIN app.file_resources sf ON sf.id::text=source->>'resourceId'
   WHERE sf.deleted_at IS NULL AND sf.status='verified' AND (
     (sf.owner_scope='personal' AND sf.owner_user_id=e.owner_id) OR
     (sf.owner_scope='project' AND EXISTS(SELECT 1 FROM app.project_members sm JOIN app.projects sp ON sp.id=sm.project_id
      WHERE sm.user_id=e.owner_id AND sm.project_id=sf.project_id AND sm.active AND sp.active))))`;
export const workspaceProjection = `SELECT e.*,v.resource_id,v.created_by,u.display_name created_by_name,
  v.message_id,v.task_id,v.base_revision,${visibleSourcesSql} sources,
  f.media_type,f.declared_bytes,f.declared_sha256,
  f.deleted_at resource_deleted_at,f.status FROM app.agent_workspace_entries e
  JOIN app.agent_workspace_versions v ON v.entry_id=e.id AND v.revision=e.revision
  JOIN app.file_resources f ON f.id=v.resource_id LEFT JOIN app.users u ON u.id=v.created_by`;
const projection = workspaceProjection;
export const workspaceResourceAccessSql = `(f.owner_scope='personal' AND f.owner_user_id=e.owner_id OR
  f.owner_scope='project' AND EXISTS(SELECT 1 FROM app.project_members fm JOIN app.projects fp ON fp.id=fm.project_id
    WHERE fm.user_id=e.owner_id AND fm.project_id=f.project_id AND fm.active AND fp.active))`;
export function workspaceEntryDto(row: EntryRow): WorkspaceEntry {
  return workspaceEntrySchema.parse({
    id: row.id,
    path: row.path,
    rowVersion: row.row_version,
    revision: row.revision,
    resourceId: row.resource_id,
    mediaType: row.media_type,
    bytes: row.declared_bytes,
    sha256: row.declared_sha256,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    available: row.resource_deleted_at === null && row.status === 'verified',
    kind: row.kind,
    originalName: row.original_name,
    originMessageId: row.origin_message_id,
    createdAt: row.created_at.toISOString(),
    provenance: workspaceProvenanceSchema.parse({
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      messageId: row.message_id,
      taskId: row.task_id,
      baseRevision: row.base_revision,
      sources: row.sources,
    }),
  });
}
const dto = workspaceEntryDto;
export interface WorkspaceArtifactProvenance {
  taskId: string;
  sources: z.infer<typeof workspaceSourceSchema>[];
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export interface AgentWorkspaceTaskScope {
  conversationId: string;
  taskId: string;
  authorize: () => Promise<void>;
  authorizeResource: (resourceId: string) => Promise<void>;
  signal?: AbortSignal;
}
const taskImportIdentity = (scope: AgentWorkspaceTaskScope) => ({
  ...scope,
  conversationId: idSchema.parse(scope.conversationId).toLowerCase(),
  taskId: idSchema.parse(scope.taskId).toLowerCase(),
});
const taskImportCommand = (scope: AgentWorkspaceTaskScope, commandId: string) =>
  `task-import:${idSchema.parse(scope.taskId).toLowerCase()}:${digest(commandIdSchema.parse(commandId))}`;

/** Logical files over authorized immutable resources; never resolves a host filesystem path. */
export class AgentWorkspaceService {
  constructor(
    readonly db: Database,
    readonly files: FilesService,
  ) {
    if (files.db !== db)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '工作区文件服务绑定不一致。',
        503,
      );
  }

  private async authorize(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    write = false,
  ) {
    idSchema.parse(conversationId);
    const conversation = await conversationRow(
      tx,
      actor,
      conversationId,
      write,
      true,
    );
    if (write && conversation.archived_at)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '已归档会话不能修改工作区。',
        409,
      );
  }

  private async entry(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    entryId: string,
  ) {
    const row = (
      await tx.query<EntryRow>(
        `${projection} WHERE e.id=$1 AND e.conversation_id=$2 AND e.owner_id=$3 AND ${workspaceResourceAccessSql}`,
        [idSchema.parse(entryId), conversationId, actor.userId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '当前会话文件不存在。', 404);
    return row;
  }

  private async known(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    commandId: string,
    payloadDigest: string,
  ) {
    const row = (
      await tx.query<{ payload_digest: string; response: unknown }>(
        'SELECT payload_digest,response FROM app.agent_workspace_commands WHERE conversation_id=$1 AND command_id=$2',
        [conversationId, commandId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.payload_digest !== payloadDigest)
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        '原工作区命令已绑定不同内容。',
        409,
      );
    return {
      ...(await this.readableReceipt(tx, actor, conversationId, row.response)),
      replayed: true,
    };
  }

  private async readableReceipt(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    raw: unknown,
  ) {
    const receipt = workspaceReceiptSchema.parse(raw);
    await this.authorizeImportResource(
      tx,
      actor,
      conversationId,
      receipt.entry.resourceId,
    );
    const row = (
      await tx.query<EntryRow>(
        `${projection.replace('v.revision=e.revision', 'v.revision=$4')} WHERE e.id=$1 AND e.conversation_id=$2 AND e.owner_id=$3 AND ${workspaceResourceAccessSql}`,
        [
          receipt.entry.id,
          conversationId,
          actor.userId,
          receipt.entry.revision,
        ],
      )
    ).rows[0];
    if (!row || row.resource_id !== receipt.entry.resourceId)
      throw new DomainError(
        'NOT_FOUND',
        '原文件回执对应的版本已不可访问。',
        404,
      );
    return workspaceReceiptSchema.parse({
      ...receipt,
      entry: {
        ...dto(row),
        revision: receipt.entry.revision,
        rowVersion: receipt.entry.rowVersion,
      },
    });
  }

  private async saveReceipt(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    commandId: string,
    payloadDigest: string,
    row: EntryRow,
    request?: { path: string; expectedRowVersion: number },
  ) {
    const receipt = { entry: dto(row), replayed: false };
    await tx.query(
      'INSERT INTO app.agent_workspace_commands(conversation_id,owner_id,command_id,payload_digest,response,request_path,request_expected_row_version) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',
      [
        conversationId,
        actor.userId,
        commandId,
        payloadDigest,
        JSON.stringify(receipt),
        request?.path ?? null,
        request?.expectedRowVersion ?? null,
      ],
    );
    return receipt;
  }

  async listManifest(
    actor: ActorContext,
    conversationId: string,
    includeDeleted = false,
  ) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId);
      const rows = await tx.query<EntryRow>(
        `${projection} WHERE e.conversation_id=$1 AND e.owner_id=$2 AND ($3 OR e.deleted_at IS NULL) AND ${workspaceResourceAccessSql} ORDER BY e.path,e.id LIMIT $4`,
        [conversationId, actor.userId, includeDeleted, workspaceMaximumEntries],
      );
      return { entries: rows.rows.map(dto) };
    });
  }

  async history(actor: ActorContext, conversationId: string, entryId: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId);
      const row = await this.entry(tx, actor, conversationId, entryId);
      const versions = await tx.query<{
        revision: number;
        resource_id: string;
        media_type: string;
        declared_bytes: string;
        declared_sha256: string;
        created_at: Date;
        deleted_at: Date | null;
        status: string;
        created_by: string | null;
        created_by_name: string | null;
        message_id: string | null;
        task_id: string | null;
        base_revision: number | null;
        sources: unknown;
      }>(
        `SELECT v.entry_id,v.revision,v.resource_id,v.created_at,v.created_by,v.message_id,v.task_id,v.base_revision,
        ${visibleSourcesSql} sources,u.display_name created_by_name,f.media_type,f.declared_bytes,f.declared_sha256,f.deleted_at,f.status
        FROM app.agent_workspace_versions v JOIN app.agent_workspace_entries e ON e.id=v.entry_id
        JOIN app.file_resources f ON f.id=v.resource_id
        LEFT JOIN app.users u ON u.id=v.created_by
        WHERE v.entry_id=$1 AND ${workspaceResourceAccessSql} ORDER BY v.revision DESC`,
        [entryId],
      );
      return {
        entry: dto(row),
        versions: versions.rows.map((version) => ({
          revision: version.revision,
          resourceId: version.resource_id,
          mediaType: version.media_type,
          bytes: version.declared_bytes,
          sha256: version.declared_sha256,
          createdAt: version.created_at.toISOString(),
          available: !version.deleted_at && version.status === 'verified',
          provenance: workspaceProvenanceSchema.parse({
            createdBy: version.created_by,
            createdByName: version.created_by_name,
            messageId: version.message_id,
            taskId: version.task_id,
            baseRevision: version.base_revision,
            sources: version.sources,
          }),
        })),
      };
    });
  }

  async commandReceipt(
    actor: ActorContext,
    conversationId: string,
    commandId: string,
  ) {
    commandIdSchema.parse(commandId);
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId);
      const row = (
        await tx.query<{ response: unknown }>(
          'SELECT response FROM app.agent_workspace_commands WHERE conversation_id=$1 AND command_id=$2 AND owner_id=$3',
          [conversationId, commandId, actor.userId],
        )
      ).rows[0];
      return workspaceCommandReceiptSchema.parse({
        found: Boolean(row),
        receipt: row
          ? await this.readableReceipt(tx, actor, conversationId, row.response)
          : null,
      });
    });
  }

  private async versionResource(
    tx: SqlExecutor,
    entryId: string,
    revision: number,
  ) {
    const row = (
      await tx.query<{ resource_id: string }>(
        `SELECT v.resource_id FROM app.agent_workspace_versions v JOIN app.file_resources f ON f.id=v.resource_id
       WHERE v.entry_id=$1 AND v.revision=$2 AND f.deleted_at IS NULL AND f.status='verified' FOR SHARE OF f`,
        [entryId, revision],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', '文件版本不存在或原件已删除。', 404);
    return row.resource_id;
  }

  async readBytes(
    actor: ActorContext,
    conversationId: string,
    entryId: string,
    revision?: number,
  ) {
    if (revision !== undefined) persistedRowVersionSchema.parse(revision);
    const selected = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId);
      const row = await this.entry(tx, actor, conversationId, entryId);
      if (row.deleted_at && revision === undefined)
        throw new DomainError(
          'NOT_FOUND',
          '文件已移除，请明确选择历史版本。',
          404,
        );
      return {
        entry: dto(row),
        resourceId: await this.versionResource(
          tx,
          entryId,
          revision ?? row.revision,
        ),
      };
    });
    const file = await this.files.downloadConversationArtifact(
      actor,
      conversationId,
      selected.resourceId,
    );
    if (BigInt(file.file.bytes) > BigInt(workspaceMaximumFileBytes)) {
      file.body.destroy();
      throw new DomainError(
        'FILE_TOO_LARGE',
        '文件超过工作区单次读取上限。',
        413,
      );
    }
    const chunks: Buffer[] = [];
    let length = 0;
    const hash = createHash('sha256');
    for await (const value of file.body) {
      if (!(value instanceof Uint8Array)) {
        file.body.destroy();
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '文件字节通道无效。',
          503,
        );
      }
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (
        length > workspaceMaximumFileBytes ||
        BigInt(length) > BigInt(file.file.bytes)
      ) {
        file.body.destroy();
        throw new DomainError('FILE_TOO_LARGE', '文件字节超出原登记。', 413);
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (
      String(length) !== file.file.bytes ||
      hash.digest('hex') !== file.file.sha256
    )
      throw new DomainError('FILE_HASH_MISMATCH', '文件读取校验失败。', 503);
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId);
      const current = await this.entry(tx, actor, conversationId, entryId);
      if (
        revision === undefined &&
        (current.row_version !== selected.entry.rowVersion ||
          current.deleted_at)
      )
        stale();
      await this.versionResource(
        tx,
        entryId,
        revision ?? selected.entry.revision,
      );
    });
    return {
      entry: {
        ...selected.entry,
        resourceId: file.file.id,
        mediaType: file.file.mediaType,
        bytes: file.file.bytes,
        sha256: file.file.sha256,
        revision: revision ?? selected.entry.revision,
      },
      bytes: Buffer.concat(chunks),
    };
  }

  async putText(actor: ActorContext, conversationId: string, raw: unknown) {
    if (actor.entrypoint !== 'internal-ai')
      throw new DomainError(
        'FORBIDDEN',
        '文件中心只支持查看；请通过对话修改成果。',
        403,
      );
    const { text, ...input } = workspaceTextInputSchema.parse(raw);
    if (Buffer.byteLength(text, 'utf8') > workspaceMaximumTextBytes)
      throw new DomainError('FILE_TOO_LARGE', '文本编辑最多1MiB。', 413);
    if (
      ![
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json',
        'text/html',
      ].includes(input.mediaType)
    )
      throw new DomainError(
        'VALIDATION_ERROR',
        '文本编辑需要明确文本格式。',
        400,
      );
    return this.putBytes(
      actor,
      conversationId,
      input,
      Buffer.from(text, 'utf8'),
    );
  }

  async putBytes(
    actor: ActorContext,
    conversationId: string,
    raw: unknown,
    bytes: Uint8Array,
    provenance?: WorkspaceArtifactProvenance,
  ) {
    if (actor.entrypoint !== 'internal-ai' || !provenance)
      throw new DomainError('FORBIDDEN', '成果只能由当前受控任务生成。', 403);
    const input = workspacePutSchema.parse(raw);
    if (bytes.length > workspaceMaximumFileBytes)
      throw new DomainError(
        'FILE_TOO_LARGE',
        '产物超过工作区单文件上限。',
        413,
      );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const payloadDigest = digest({
      action: 'put',
      ...input,
      sha256,
      bytes: bytes.length,
      provenance,
    });
    const known = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId, true);
      await this.artifactProvenance(tx, actor, conversationId, provenance);
      const receipt = await this.known(
        tx,
        actor,
        conversationId,
        input.commandId,
        payloadDigest,
      );
      if (!receipt)
        await this.checkPathVersion(
          tx,
          conversationId,
          input.path,
          input.expectedRowVersion,
        );
      return receipt;
    });
    if (known) return known;
    const artifact = await this.files.createConversationArtifact(
      actor,
      conversationId,
      {
        ownerScope: 'personal',
        localFileId: `workspace:${conversationId}:${digest(input.commandId)}`,
        originalName: input.path.split('/').at(-1),
        mediaType: input.mediaType,
        bytes: String(bytes.length),
        sha256,
      },
      Readable.from([Buffer.from(bytes)]),
    );
    return this.acceptResource(
      actor,
      conversationId,
      { ...input, resourceId: artifact.file.id },
      payloadDigest,
      undefined,
      provenance,
    );
  }

  async importResource(
    actor: ActorContext,
    conversationId: string,
    raw: unknown,
  ) {
    const input = workspaceImportSchema.parse(raw);
    if (actor.entrypoint !== 'web')
      throw new DomainError('FORBIDDEN', '导入个人附件须由本人网页发起。', 403);
    return this.acceptResource(
      actor,
      conversationId,
      input,
      digest({ action: 'import', ...input }),
    );
  }

  /** Binds an already attached original; never gives a new lifetime to an independent personal file. */
  async importTaskResource(
    actor: ActorContext,
    scope: AgentWorkspaceTaskScope,
    raw: unknown,
  ) {
    const parsed = workspaceImportSchema.parse(raw);
    const input = { ...parsed, resourceId: parsed.resourceId.toLowerCase() };
    const taskScope = taskImportIdentity(scope);
    if (actor.entrypoint !== 'internal-ai')
      throw new DomainError(
        'FORBIDDEN',
        '任务附件导入只供受控内部任务使用。',
        403,
      );
    await taskScope.authorize();
    await taskScope.authorizeResource(input.resourceId);
    const receipt = await this.acceptResource(
      actor,
      taskScope.conversationId,
      { ...input, commandId: taskImportCommand(taskScope, input.commandId) },
      digest({
        action: 'task-import',
        taskId: taskScope.taskId,
        ...input,
      }),
      taskScope,
    );
    // These callbacks use other connections. Calling them under the conversation
    // write lock would wait on this transaction's own lock.
    try {
      await taskScope.authorize();
      await taskScope.authorizeResource(input.resourceId);
    } catch {
      throw new DomainError(
        'OPERATION_RESULT_UNKNOWN',
        '原导入命令已提交，但当前许可未能确认，未返回原件信息。恢复许可后只查询原commandId，不得换命令重试。',
        409,
      );
    }
    return receipt;
  }

  async taskImportReceipt(
    actor: ActorContext,
    scope: AgentWorkspaceTaskScope,
    commandId: string,
    originTaskId = scope.taskId,
  ) {
    if (actor.entrypoint !== 'internal-ai')
      throw new DomainError(
        'FORBIDDEN',
        '任务附件查询只供受控内部任务使用。',
        403,
      );
    const taskScope = taskImportIdentity(scope);
    const originalScope = {
      ...taskScope,
      taskId: idSchema.parse(originTaskId).toLowerCase(),
    };
    const storedCommand = taskImportCommand(originalScope, commandId);
    await taskScope.authorize();
    const result = await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, taskScope.conversationId);
      await assertTaskCapability(tx, actor, taskScope, 'office');
      if (originalScope.taskId !== taskScope.taskId)
        await assertTaskCapability(tx, actor, originalScope, 'office');
      const row = (
        await tx.query<{
          response: unknown;
          payload_digest: string;
          request_path: string | null;
          request_expected_row_version: number | null;
        }>(
          'SELECT response,payload_digest,request_path,request_expected_row_version FROM app.agent_workspace_commands WHERE conversation_id=$1 AND command_id=$2 AND owner_id=$3',
          [taskScope.conversationId, storedCommand, actor.userId],
        )
      ).rows[0];
      const receipt = row ? workspaceReceiptSchema.parse(row.response) : null;
      if (
        row &&
        receipt &&
        row.payload_digest !==
          digest({
            action: 'task-import',
            taskId: originalScope.taskId,
            commandId,
            path: row.request_path ?? receipt.entry.path,
            expectedRowVersion:
              row.request_expected_row_version ?? receipt.entry.rowVersion - 1,
            resourceId: receipt.entry.resourceId,
          })
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          '原命令键的回执不属于此任务导入，不能据此确认或重放。',
          409,
        );
      if (receipt)
        await this.authorizeImportResource(
          tx,
          actor,
          taskScope.conversationId,
          receipt.entry.resourceId,
        );
      return workspaceCommandReceiptSchema.parse({
        found: Boolean(row),
        receipt: receipt
          ? await this.readableReceipt(
              tx,
              actor,
              taskScope.conversationId,
              receipt,
            )
          : null,
      });
    });
    if (result.receipt)
      await taskScope.authorizeResource(result.receipt.entry.resourceId);
    await taskScope.authorize();
    return result;
  }

  private async checkPathVersion(
    tx: SqlExecutor,
    conversationId: string,
    path: string,
    expected: number,
  ) {
    const row = (
      await tx.query<{
        id: string;
        row_version: number;
        deleted_at: Date | null;
        revision: number;
        kind: string;
      }>(
        'SELECT id,row_version,deleted_at,revision,kind FROM app.agent_workspace_entries WHERE conversation_id=$1 AND path=$2 FOR UPDATE',
        [conversationId, path],
      )
    ).rows[0];
    if ((row?.row_version ?? 0) !== expected) stale();
    if (row?.kind === 'original')
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '原件只读，请将处理结果保存为新的成果文件。',
        409,
      );
    if (row?.deleted_at)
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '同名文件已移除；请明确恢复或使用新路径。',
        409,
      );
    await this.assertTreePath(tx, conversationId, path, row?.id ?? null);
    if (!row) {
      const count = (
        await tx.query<{ count: string }>(
          'SELECT count(*) FROM app.agent_workspace_entries WHERE conversation_id=$1',
          [conversationId],
        )
      ).rows[0];
      if (Number(count?.count ?? 0) >= workspaceMaximumEntries)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '会话工作区条目已达上限。',
          409,
        );
    }
    return row;
  }

  private async assertTreePath(
    tx: SqlExecutor,
    conversationId: string,
    path: string,
    exceptId: string | null,
  ) {
    if (
      (
        await tx.query(
          `SELECT 1 FROM app.agent_workspace_entries WHERE conversation_id=$1 AND deleted_at IS NULL
       AND id IS DISTINCT FROM $3::uuid AND (starts_with($2,path||'/') OR starts_with(path,$2||'/')) LIMIT 1`,
          [conversationId, path, exceptId],
        )
      ).rowCount
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '文件路径与已有文件或目录冲突。',
        409,
      );
  }

  private async authorizeImportResource(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    resourceId: string,
  ) {
    const resource = (
      await tx.query<{
        id: string;
        owner_scope: string;
        owner_user_id: string;
        project_id: string | null;
        run_id: string | null;
        local_file_id: string;
        original_name: string;
        media_type: string;
        declared_bytes: string;
        declared_sha256: string;
      }>(
        `SELECT * FROM app.file_resources WHERE id=$1 AND (owner_scope='project' OR owner_user_id=$2)
        AND deleted_at IS NULL AND status='verified' FOR SHARE`,
        [resourceId, actor.userId],
      )
    ).rows[0];
    if (!resource)
      throw new DomainError(
        'NOT_FOUND',
        '只能接入本人已校验且未删除的个人文件。',
        404,
      );
    if (resource.owner_scope === 'project' && resource.project_id)
      await requireProject(tx, actor, resource.project_id, 'files.transfer');
    if (BigInt(resource.declared_bytes) > BigInt(workspaceMaximumFileBytes))
      throw new DomainError(
        'FILE_TOO_LARGE',
        '文件超过工作区单文件上限。',
        413,
      );
    await this.files.policies.read(tx, registeredFilePolicyIntent(resource));
    if (
      actor.entrypoint === 'internal-ai' &&
      !(
        await tx.query(
          "SELECT 1 FROM app.resource_references WHERE resource_id=$1 AND reference_type='conversation' AND reference_id=$2",
          [resourceId, conversationId],
        )
      ).rowCount
    )
      throw new DomainError('FORBIDDEN', '内部产物没有当前会话绑定。', 403);
  }

  private async artifactProvenance(
    tx: SqlExecutor,
    actor: ActorContext,
    conversationId: string,
    provenance: WorkspaceArtifactProvenance,
  ) {
    await assertTaskCapability(
      tx,
      actor,
      { conversationId, taskId: provenance.taskId },
      'office',
      { active: true, allowCompleted: true },
    );
    const task = (
      await tx.query<{ assistant_message_id: string }>(
        'SELECT assistant_message_id FROM app.ai_tasks WHERE id=$1 AND owner_id=$2 AND conversation_id=$3',
        [provenance.taskId, actor.userId, conversationId],
      )
    ).rows[0];
    if (!task)
      throw new DomainError('NOT_FOUND', '当前成果任务不可访问。', 404);
    const sources = z
      .array(workspaceSourceSchema)
      .max(32)
      .parse(provenance.sources);
    for (const source of sources) {
      const row = (
        await tx.query<{ resource_id: string; path: string }>(
          `SELECT v.resource_id,e.path FROM app.agent_workspace_entries e JOIN app.agent_workspace_versions v ON v.entry_id=e.id
         JOIN app.file_resources f ON f.id=v.resource_id WHERE e.id=$1 AND e.conversation_id=$2 AND e.owner_id=$3
         AND e.deleted_at IS NULL AND v.revision=$4 AND f.deleted_at IS NULL AND f.status='verified'`,
          [source.entryId, conversationId, actor.userId, source.revision],
        )
      ).rows[0];
      if (!row || row.resource_id !== source.resourceId)
        throw new DomainError(
          'NOT_FOUND',
          '成果来源版本已失效，未保存新成果。',
          404,
        );
      await this.authorizeImportResource(
        tx,
        actor,
        conversationId,
        source.resourceId,
      );
      source.path = row.path;
    }
    return { messageId: task.assistant_message_id, sources };
  }

  private async acceptResource(
    actor: ActorContext,
    conversationId: string,
    input: {
      commandId: string;
      path: string;
      expectedRowVersion: number;
      resourceId: string;
    },
    payloadDigest: string,
    taskScope?: AgentWorkspaceTaskScope,
    provenance?: WorkspaceArtifactProvenance,
  ) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId, true);
      if (taskScope) {
        // The current persisted task check is the acceptance point. Do not add
        // task locks opposite the worker's task/conversation lock order.
        await assertTaskCapability(tx, actor, taskScope, 'office', {
          active: true,
        });
        if (taskScope.signal?.aborted)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '原任务已取消，未受理导入。',
            409,
          );
        if (
          (
            await tx.query(
              "SELECT 1 FROM app.ai_task_events WHERE task_id=$1 AND event_type='ai.tool' AND payload->>'name'='ath_compute' AND payload->>'unknownEffect'='true' LIMIT 1",
              [taskScope.taskId],
            )
          ).rowCount
        )
          throw new DomainError(
            'OPERATION_RESULT_UNKNOWN',
            '原任务已有计算工具结果未知，未受理新的导入；只能查询原taskId和commandId回执，不得换命令重做。',
            409,
          );
      }
      const known = await this.known(
        tx,
        actor,
        conversationId,
        input.commandId,
        payloadDigest,
      );
      if (known && !taskScope) return known;
      await this.authorizeImportResource(
        tx,
        actor,
        conversationId,
        input.resourceId,
      );
      if (known) return known;
      if (!provenance) {
        if (input.expectedRowVersion !== 0)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '导入原件不允许替换已有文件。',
            409,
          );
        const entryId = await attachOriginalResource(
          tx,
          actor,
          conversationId,
          input.resourceId,
          null,
        );
        if (!taskScope)
          await tx.query(
            "INSERT INTO app.resource_references(resource_id,reference_type,reference_id,created_by) VALUES($1,'conversation',$2,$3) ON CONFLICT DO NOTHING",
            [input.resourceId, conversationId, actor.userId],
          );
        return this.saveReceipt(
          tx,
          actor,
          conversationId,
          input.commandId,
          payloadDigest,
          await this.entry(tx, actor, conversationId, entryId),
          input,
        );
      }
      const trusted = await this.artifactProvenance(
        tx,
        actor,
        conversationId,
        provenance,
      );
      const existing = await this.checkPathVersion(
        tx,
        conversationId,
        input.path,
        input.expectedRowVersion,
      );
      let entryId: string;
      const revision = (existing?.revision ?? 0) + 1;
      if (existing) {
        entryId = existing.id;
        await tx.query(
          'UPDATE app.agent_workspace_entries SET revision=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [entryId, revision],
        );
      } else {
        const inserted = (
          await tx.query<{ id: string }>(
            "INSERT INTO app.agent_workspace_entries(conversation_id,owner_id,path,kind) VALUES($1,$2,$3,'artifact') RETURNING id",
            [conversationId, actor.userId, input.path],
          )
        ).rows[0];
        if (!inserted)
          throw new Error('Workspace entry insertion returned no row');
        entryId = inserted.id;
      }
      await tx.query(
        `INSERT INTO app.agent_workspace_versions(entry_id,revision,resource_id,created_by,message_id,task_id,base_revision,sources)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          entryId,
          revision,
          input.resourceId,
          actor.userId,
          trusted.messageId,
          provenance.taskId,
          existing?.revision ?? null,
          JSON.stringify(trusted.sources),
        ],
      );
      if (!taskScope)
        await tx.query(
          "INSERT INTO app.resource_references(resource_id,reference_type,reference_id,created_by) VALUES($1,'conversation',$2,$3) ON CONFLICT DO NOTHING",
          [input.resourceId, conversationId, actor.userId],
        );
      return this.saveReceipt(
        tx,
        actor,
        conversationId,
        input.commandId,
        payloadDigest,
        await this.entry(tx, actor, conversationId, entryId),
        input,
      );
    });
  }

  async mutate(
    actor: ActorContext,
    conversationId: string,
    entryId: string,
    raw: unknown,
  ) {
    const input = workspaceMutationSchema.parse(raw);
    const payloadDigest = digest({ entryId, ...input });
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, conversationId, true);
      const known = await this.known(
        tx,
        actor,
        conversationId,
        input.commandId,
        payloadDigest,
      );
      if (known) return known;
      const row = await this.entry(tx, actor, conversationId, entryId);
      if (row.kind === 'original')
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '原件只读，不允许重命名、修改、移除或替换版本。',
          409,
        );
      if (row.row_version !== input.expectedRowVersion) stale();
      if (input.action === 'rename') {
        if (row.deleted_at)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '请先恢复已移除文件。',
            409,
          );
        if (
          (
            await tx.query(
              'SELECT 1 FROM app.agent_workspace_entries WHERE conversation_id=$1 AND path=$2 AND id<>$3',
              [conversationId, input.path, entryId],
            )
          ).rowCount
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '目标路径已有文件或已移除条目。',
            409,
          );
        await this.assertTreePath(tx, conversationId, input.path, entryId);
        await tx.query(
          'UPDATE app.agent_workspace_entries SET path=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [entryId, input.path],
        );
      } else if (input.action === 'remove') {
        if (row.deleted_at)
          throw new DomainError('BUSINESS_CONFLICT', '文件已经移除。', 409);
        await tx.query(
          'UPDATE app.agent_workspace_entries SET deleted_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [entryId],
        );
      } else {
        await this.assertTreePath(tx, conversationId, row.path, entryId);
        const resourceId = await this.versionResource(
          tx,
          entryId,
          input.revision,
        );
        await tx.query(
          'INSERT INTO app.agent_workspace_versions(entry_id,revision,resource_id,created_by,base_revision,sources) SELECT $1,$2,$3,$4,$5,sources FROM app.agent_workspace_versions WHERE entry_id=$1 AND revision=$6',
          [
            entryId,
            row.revision + 1,
            resourceId,
            actor.userId,
            input.revision,
            input.revision,
          ],
        );
        await tx.query(
          'UPDATE app.agent_workspace_entries SET deleted_at=NULL,revision=revision+1,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [entryId],
        );
      }
      return this.saveReceipt(
        tx,
        actor,
        conversationId,
        input.commandId,
        payloadDigest,
        await this.entry(tx, actor, conversationId, entryId),
      );
    });
  }
}
