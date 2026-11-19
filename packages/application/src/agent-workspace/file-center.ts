import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { idSchema, timestampSchema } from '../../../contracts/src/base.js';
import {
  fileCenterDetailSchema,
  fileCenterEntrySchema,
  fileCenterListSchema,
  fileCenterQuerySchema,
  fileCenterTreeSchema,
  fileCenterAssociationsSchema,
} from '../../../contracts/src/agent-workspace.js';
import {
  filePreviewQuerySchema,
  filePreviewResultSchema,
  type FilePreviewRenderer,
  type FilePreviewResult,
} from '../../../contracts/src/file-preview.js';
import { personalActor, conversationRow } from '../conversations/common.js';
import {
  conversationDisplayTitle,
  conversationFirstUserTitleSql,
  type ConversationTitleRow,
} from '../conversations/title.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import {
  AgentWorkspaceService,
  workspaceEntryDto,
  workspaceProjection,
  workspaceResourceAccessSql,
  type EntryRow,
} from './service.js';

interface CenterRow extends EntryRow, ConversationTitleRow {
  conversation_id: string;
  project_id: string | null;
  project_name: string | null;
  requirement_id: string | null;
  requirement_title: string | null;
  sort_at: Date;
}
const centerConversationTitle = `c.alias,c.default_title,${conversationFirstUserTitleSql}`;
const centerProjection =
  workspaceProjection.replace(
    'SELECT e.*,',
    `SELECT ${centerConversationTitle},c.project_id,p.name project_name,c.requirement_id,r.title requirement_title,e.*,`,
  ) +
  ' JOIN app.ai_conversations c ON c.id=e.conversation_id LEFT JOIN app.projects p ON p.id=c.project_id LEFT JOIN app.requirements r ON r.id=c.requirement_id AND r.project_id=c.project_id';
const access = `e.owner_id=$1 AND c.owner_id=$1 AND c.deleted_at IS NULL AND
 (c.project_id IS NULL OR EXISTS(SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id
   WHERE m.user_id=$1 AND m.project_id=c.project_id AND m.active AND p.active)) AND ${workspaceResourceAccessSql}`;
function centerDto(row: CenterRow) {
  return fileCenterEntrySchema.parse({
    ...workspaceEntryDto(row),
    conversationId: row.conversation_id,
    conversationTitle: conversationDisplayTitle(row),
    projectId: row.project_id,
    projectName: row.project_name,
    requirementId: row.requirement_id,
    requirementTitle: row.requirement_title,
  });
}
const cursorSchema = z.strictObject({ at: timestampSchema, id: idSchema });
function parseCursor(value: string | undefined) {
  if (!value) return null;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new DomainError('VALIDATION_ERROR', '文件分页位置无效。', 400);
  }
}

/** Personal aggregation only. Project membership never grants access to another user's conversation. */
export class FileCenterService {
  private readonly cache = new Map<
    string,
    { result: FilePreviewResult; expiresAt: number; bytes: number }
  >();
  private readonly pending = new Map<string, Promise<FilePreviewResult>>();
  private cachedBytes = 0;
  constructor(
    readonly workspace: AgentWorkspaceService,
    readonly renderer?: FilePreviewRenderer,
  ) {}

  private async query(actor: ActorContext, raw: unknown) {
    const query = fileCenterQuerySchema.parse(raw);
    await this.workspace.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      if (query.projectId)
        await requireProject(tx, actor, query.projectId, 'project.read');
      if (query.conversationId)
        await conversationRow(tx, actor, query.conversationId);
    });
    return query;
  }
  async list(actor: ActorContext, raw: unknown) {
    const q = await this.query(actor, raw),
      cursor = parseCursor(q.cursor);
    const sort = `date_trunc('milliseconds',e.${q.dateField === 'updated' ? 'updated_at' : 'created_at'})`;
    const values: unknown[] = [
      actor.userId,
      q.includeDeleted,
      q.projectId ?? null,
      q.requirementId ?? null,
      q.conversationId ?? null,
      q.kind ?? null,
      q.personal,
      q.query,
      q.from ?? null,
      q.to ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      q.limit + 1,
    ];
    const rows = (
      await this.workspace.db.query<CenterRow>(
        centerProjection.replace('SELECT ', `SELECT ${sort} sort_at,`) +
          ` WHERE ${access}
      AND ($2 OR e.deleted_at IS NULL) AND ($3::uuid IS NULL OR c.project_id=$3)
      AND ($4::uuid IS NULL OR c.requirement_id=$4) AND ($5::uuid IS NULL OR c.id=$5)
      AND ($6::text IS NULL OR e.kind=$6) AND (NOT $7 OR c.project_id IS NULL)
      AND ($8='' OR position(lower($8) in lower(COALESCE(e.original_name,e.path)))>0)
      AND ($9::timestamptz IS NULL OR ${sort}>=$9) AND ($10::timestamptz IS NULL OR ${sort}<=$10)
      AND ($11::timestamptz IS NULL OR (${sort},e.id)<($11,$12::uuid))
      ORDER BY ${sort} DESC,e.id DESC LIMIT $13`,
        values,
      )
    ).rows;
    const entries = [];
    for (const row of rows.slice(0, q.limit)) {
      // Re-read scope immediately before returning names and preview metadata.
      entries.push((await this.detail(actor, row.id)).entry);
    }
    const last = rows[q.limit - 1];
    return fileCenterListSchema.parse({
      entries,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.sort_at.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    });
  }
  async tree(actor: ActorContext, raw: unknown) {
    const q = await this.query(actor, raw),
      cursor = q.cursor ? idSchema.parse(q.cursor) : null;
    const rows = (
      await this.workspace.db.query<
        ConversationTitleRow & {
          conversation_id: string;
          project_id: string | null;
          project_name: string | null;
          requirement_id: string | null;
          requirement_title: string | null;
          created_at: Date;
          file_count: string;
        }
      >(
        `SELECT c.id conversation_id,${centerConversationTitle},c.project_id,p.name project_name,
      c.requirement_id,r.title requirement_title,c.created_at,count(*)::text file_count
      FROM app.agent_workspace_entries e JOIN app.agent_workspace_versions v ON v.entry_id=e.id AND v.revision=e.revision
      JOIN app.file_resources f ON f.id=v.resource_id JOIN app.ai_conversations c ON c.id=e.conversation_id
      LEFT JOIN app.projects p ON p.id=c.project_id LEFT JOIN app.requirements r ON r.id=c.requirement_id AND r.project_id=c.project_id
      WHERE ${access} AND e.deleted_at IS NULL AND ($2::uuid IS NULL OR c.id>$2)
      GROUP BY c.id,p.name,r.title ORDER BY c.id LIMIT $3`,
        [actor.userId, cursor, q.limit + 1],
      )
    ).rows;
    return fileCenterTreeSchema.parse({
      conversations: rows.slice(0, q.limit).map((row) => ({
        conversationId: row.conversation_id,
        conversationTitle: conversationDisplayTitle(row),
        projectId: row.project_id,
        projectName: row.project_name,
        requirementId: row.requirement_id,
        requirementTitle: row.requirement_title,
        createdAt: row.created_at.toISOString(),
        fileCount: Number(row.file_count),
      })),
      nextCursor:
        rows.length > q.limit
          ? (rows[q.limit - 1]?.conversation_id ?? null)
          : null,
    });
  }
  async detail(actor: ActorContext, entryId: string) {
    idSchema.parse(entryId);
    return this.workspace.db.transaction(async (tx) => {
      await personalActor(tx, actor);
      const row = (
        await tx.query<CenterRow>(
          `${centerProjection} WHERE ${access} AND e.id=$2`,
          [actor.userId, entryId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError('NOT_FOUND', '文件不存在或当前不可访问。', 404);
      await conversationRow(tx, actor, row.conversation_id);
      return fileCenterDetailSchema.parse({ entry: centerDto(row) });
    });
  }
  async history(actor: ActorContext, entryId: string) {
    const { entry } = await this.detail(actor, entryId);
    return this.workspace.history(actor, entry.conversationId, entryId);
  }
  async associations(actor: ActorContext, entryId: string, raw: unknown) {
    await this.detail(actor, entryId);
    const q = z
      .strictObject({
        cursor: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(raw);
    const rows = (
      await this.workspace.db.query<
        ConversationTitleRow & {
          id: string;
          conversation_id: string;
          project_id: string | null;
          project_name: string | null;
          requirement_id: string | null;
          requirement_title: string | null;
          message_id: string | null;
          kind: string;
        }
      >(
        `SELECT DISTINCT e.id,e.conversation_id,${centerConversationTitle},
      c.project_id,p.name project_name,c.requirement_id,r.title requirement_title,m.id message_id,e.kind
      FROM app.agent_workspace_entries e JOIN app.agent_workspace_versions v ON v.entry_id=e.id
      JOIN app.file_resources f ON f.id=v.resource_id JOIN app.ai_conversations c ON c.id=e.conversation_id
      LEFT JOIN app.projects p ON p.id=c.project_id LEFT JOIN app.requirements r ON r.id=c.requirement_id AND r.project_id=c.project_id
      LEFT JOIN app.agent_workspace_message_links l ON l.entry_id=e.id
      LEFT JOIN app.ai_messages m ON m.id=l.message_id AND m.deleted_at IS NULL
      WHERE ${access} AND e.deleted_at IS NULL AND v.resource_id IN(
        SELECT resource_id FROM app.agent_workspace_versions WHERE entry_id=$2)
      ORDER BY e.conversation_id,e.id,m.id NULLS FIRST OFFSET $3 LIMIT $4`,
        [actor.userId, entryId, q.cursor, q.limit + 1],
      )
    ).rows;
    return fileCenterAssociationsSchema.parse({
      associations: rows.slice(0, q.limit).map((row) => ({
        entryId: row.id,
        conversationId: row.conversation_id,
        conversationTitle: conversationDisplayTitle(row),
        projectId: row.project_id,
        projectName: row.project_name,
        requirementId: row.requirement_id,
        requirementTitle: row.requirement_title,
        messageId: row.message_id,
        relationType: row.message_id
          ? 'attachment'
          : row.kind === 'artifact'
            ? 'artifact'
            : 'workspace',
      })),
      nextCursor: rows.length > q.limit ? String(q.cursor + q.limit) : null,
    });
  }
  async read(actor: ActorContext, entryId: string, revision?: number) {
    const { entry } = await this.detail(actor, entryId);
    return this.workspace.readBytes(
      actor,
      entry.conversationId,
      entryId,
      revision,
    );
  }
  async preview(
    actor: ActorContext,
    entryId: string,
    revision: number | undefined,
    raw: unknown,
    signal?: AbortSignal,
  ) {
    if (!this.renderer)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '当前没有可用的文件预览转换服务。',
        503,
      );
    const query = filePreviewQuerySchema.parse(raw),
      source = await this.read(actor, entryId, revision);
    if (source.bytes.length > 12 * 1024 * 1024)
      throw new DomainError(
        'FILE_TOO_LARGE',
        '文档转换预览最多12MiB；原文件仍可下载。',
        413,
      );
    const key = JSON.stringify([
      actor.userId,
      source.entry.resourceId,
      source.entry.sha256,
      source.entry.originalName ?? source.entry.path,
      source.entry.mediaType,
      query,
    ]);
    const now = Date.now();
    for (const [k, value] of this.cache)
      if (value.expiresAt <= now) {
        this.cache.delete(k);
        this.cachedBytes -= value.bytes;
      }
    let result = this.cache.get(key)?.result;
    if (!result) {
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= 2)
          throw new DomainError(
            'RATE_LIMITED',
            '预览转换繁忙，请稍后重试。',
            429,
          );
        pending = this.renderer.render(
          source.bytes,
          source.entry.originalName ?? source.entry.path,
          source.entry.mediaType,
          query,
          signal,
        );
        this.pending.set(key, pending);
      }
      try {
        result = filePreviewResultSchema.parse(await pending);
      } finally {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }
      if (
        result.sourceSha256 !== source.entry.sha256 ||
        result.sourceBytes !== source.bytes.length
      )
        throw new DomainError(
          'FILE_HASH_MISMATCH',
          '预览结果与原文件不一致。',
          422,
        );
      const size = Buffer.byteLength(JSON.stringify(result));
      while (
        this.cache.size >= 16 ||
        this.cachedBytes + size > 24 * 1024 * 1024
      ) {
        const first = this.cache.entries().next().value;
        if (!first) break;
        this.cache.delete(first[0]);
        this.cachedBytes -= first[1].bytes;
      }
      if (size <= 24 * 1024 * 1024) {
        const replaced = this.cache.get(key);
        if (replaced) this.cachedBytes -= replaced.bytes;
        this.cache.set(key, {
          result,
          bytes: size,
          expiresAt: Date.now() + 120_000,
        });
        this.cachedBytes += size;
      }
    }
    const current = await this.read(actor, entryId, revision);
    if (
      current.entry.resourceId !== source.entry.resourceId ||
      current.entry.sha256 !== source.entry.sha256
    )
      throw new DomainError(
        'BUSINESS_CONFLICT',
        '文件已变化，请重新打开预览。',
        409,
      );
    return result;
  }
}
