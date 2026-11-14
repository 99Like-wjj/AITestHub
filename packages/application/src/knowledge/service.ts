import { randomUUID } from 'node:crypto';
import { idSchema } from '../../../contracts/src/base.js';
import {
  createKnowledgeSpaceInputSchema,
  reviseKnowledgeSpaceInputSchema,
  createKnowledgeEntryInputSchema,
  reviseKnowledgeEntryInputSchema,
  deleteKnowledgeEntryInputSchema,
  restoreKnowledgeInputSchema,
  knowledgeIndexQuerySchema,
  knowledgeIndexResponseSchema,
  knowledgeSpaceSchema,
  knowledgeEntryResponseSchema,
  knowledgeExportSelectionSchema,
  knowledgeExportInputSchema,
  knowledgeOperationLookupSchema,
  knowledgeOperationStatusSchema,
} from '../../../contracts/src/knowledge.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { Database } from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { OperationService } from '../operations/service.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import {
  appendRevision,
  entryRow,
  entrySelect,
  indexDto,
  parseContent,
  revisionDto,
  spaceExists,
  type EntryRow,
} from './repository.js';

export class KnowledgeService {
  readonly operations: OperationService;
  constructor(readonly db: Pick<Database, 'query' | 'transaction'>) {
    this.operations = new OperationService(db);
  }
  async operationStatus(actor: ActorContext, projectId: string, raw: unknown) {
    const input = knowledgeOperationLookupSchema.parse(raw);
    await this.db.transaction((tx) =>
      requireProject(tx, actor, projectId, 'project.read'),
    );
    const result = await this.operations.get(actor, {
      operation: input.operation,
      key: input.key,
    });
    if (result.command.projectId !== projectId)
      throw new DomainError('NOT_FOUND', '本项目没有该原操作回执。', 404);
    return knowledgeOperationStatusSchema.parse(result);
  }
  async spaces(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<{
        id: string;
        project_id: string;
        name: string;
        description: string;
        row_version: number;
        created_at: Date;
      }>(
        'SELECT * FROM app.knowledge_spaces WHERE project_id=$1 ORDER BY created_at,id',
        [projectId],
      );
      return {
        spaces: rows.rows.map((row) =>
          knowledgeSpaceSchema.parse({
            id: row.id,
            projectId: row.project_id,
            name: row.name,
            description: row.description,
            rowVersion: row.row_version,
            createdAt: row.created_at.toISOString(),
          }),
        ),
      };
    });
  }
  async saveSpace(
    actor: ActorContext,
    projectId: string,
    id: string | undefined,
    raw: unknown,
  ) {
    const input = id
      ? reviseKnowledgeSpaceInputSchema.parse(raw)
      : createKnowledgeSpaceInputSchema.parse(raw);
    assertSafeModelInput(input);
    return this.operations.execute(
      actor,
      id ? 'knowledge.spaces.revise' : 'knowledge.spaces.create',
      input.commandId,
      { projectId, id: id ?? null, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        const target = id ?? randomUUID();
        if (id) {
          const row = (
            await tx.query<{ row_version: number }>(
              'SELECT row_version FROM app.knowledge_spaces WHERE id=$1 AND project_id=$2 FOR UPDATE',
              [id, projectId],
            )
          ).rows[0];
          if (!row)
            throw new DomainError('NOT_FOUND', '此项目内没有该知识子库。', 404);
          if (!('rowVersion' in input) || row.row_version !== input.rowVersion)
            stale();
          await tx.query(
            'UPDATE app.knowledge_spaces SET name=$2,description=$3,row_version=row_version+1 WHERE id=$1',
            [id, input.name, input.description],
          );
        } else
          await tx.query(
            'INSERT INTO app.knowledge_spaces(id,project_id,name,description,created_by) VALUES($1,$2,$3,$4,$5)',
            [target, projectId, input.name, input.description, actor.userId],
          );
        await audit(tx, actor, 'knowledge.space-saved', target, projectId, {
          created: !id,
        });
        const row = (
          await tx.query<{
            id: string;
            name: string;
            description: string;
            row_version: number;
            created_at: Date;
          }>('SELECT * FROM app.knowledge_spaces WHERE id=$1', [target])
        ).rows[0]!;
        return {
          space: knowledgeSpaceSchema.parse({
            id: row.id,
            projectId,
            name: row.name,
            description: row.description,
            rowVersion: row.row_version,
            createdAt: row.created_at.toISOString(),
          }),
        };
      },
      projectId,
    );
  }
  async index(actor: ActorContext, projectId: string, raw: unknown = {}) {
    const input = knowledgeIndexQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      if (input.spaceId) await spaceExists(tx, projectId, input.spaceId);
      const rows = await tx.query<EntryRow>(
        `${entrySelect} WHERE e.project_id=$1 AND ($2::uuid IS NULL OR e.space_id=$2) AND ($3 OR NOT e.deleted)
        AND ($4::uuid IS NULL OR e.id>$4) AND ($5::text IS NULL OR $5=ANY(e.tags))
        AND ($6='' OR position(lower($6) in lower(e.title||' '||e.summary||' '||array_to_string(e.tags,' ')||' '||COALESCE(r.content->>'body','')))>0)
        ORDER BY e.id LIMIT $7`,
        [
          projectId,
          input.spaceId ?? null,
          input.includeDeleted,
          input.afterId ?? null,
          input.tag ?? null,
          input.query,
          input.limit + 1,
        ],
      );
      const entries = rows.rows.slice(0, input.limit).map(indexDto);
      const hasMore = rows.rows.length > input.limit;
      return knowledgeIndexResponseSchema.parse({
        entries,
        nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null,
        hasMore,
        searchMethod: 'case-insensitive-substring',
      });
    });
  }
  async get(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await entryRow(tx, projectId, id);
      if (row.deleted)
        throw new DomainError(
          'NOT_FOUND',
          '知识条目当前已显式删除；历史和恢复使用专门入口。',
          404,
        );
      return knowledgeEntryResponseSchema.parse({
        entry: indexDto(row),
        revision: await revisionDto(
          tx,
          projectId,
          id,
          revisionId ?? row.current_revision_id,
        ),
      });
    });
  }
  async historicalRevision(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await entryRow(tx, projectId, id);
      return knowledgeEntryResponseSchema.parse({
        entry: indexDto(row),
        revision: await revisionDto(tx, projectId, id, revisionId),
      });
    });
  }
  async reference(actor: ActorContext, id: string, revisionId?: string) {
    idSchema.parse(id);
    const location = await this.db.transaction(async (tx) => {
      await currentUser(tx, actor);
      return (
        await tx.query<{ project_id: string }>(
          'SELECT project_id FROM app.knowledge_entries WHERE id=$1',
          [id],
        )
      ).rows[0];
    });
    if (!location)
      throw new DomainError('NOT_FOUND', '知识来源当前不可访问。', 404);
    return this.get(actor, location.project_id, id, revisionId);
  }
  async history(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = await entryRow(tx, projectId, id);
      const history = await tx.query<{
        id: string;
        revision_no: number;
        content: { title: string; summary: string };
        content_digest: string;
        deleted: boolean;
        restored_from_revision_id: string | null;
        created_by: string;
        created_at: Date;
      }>(
        'SELECT * FROM app.knowledge_revisions WHERE project_id=$1 AND entry_id=$2 ORDER BY revision_no DESC',
        [projectId, id],
      );
      return {
        entry: indexDto(row),
        revisions: history.rows.map((revision) => ({
          id: revision.id,
          revisionNo: revision.revision_no,
          title: revision.content.title,
          summary: revision.content.summary,
          contentDigest: revision.content_digest,
          deleted: revision.deleted,
          restoredFromRevisionId: revision.restored_from_revision_id,
          createdBy: revision.created_by,
          createdAt: revision.created_at.toISOString(),
        })),
      };
    });
  }
  async create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = createKnowledgeEntryInputSchema.parse(raw);
    const content = parseContent(input.content);
    return this.operations.execute(
      actor,
      'knowledge.create',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        await spaceExists(tx, projectId, input.spaceId);
        const row = await appendRevision(
          tx,
          actor,
          projectId,
          input.spaceId,
          content,
        );
        return knowledgeEntryResponseSchema.parse({
          entry: indexDto(row),
          revision: await revisionDto(
            tx,
            projectId,
            row.id,
            row.current_revision_id,
          ),
        });
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
    const input = reviseKnowledgeEntryInputSchema.parse(raw);
    const content = parseContent(input.content);
    return this.operations.execute(
      actor,
      'knowledge.revise',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        const current = await entryRow(tx, projectId, id, true);
        if (current.deleted)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '已删除知识须明确恢复，不能用普通保存复活。',
            422,
          );
        if (
          current.current_revision_id !== input.baseRevisionId ||
          current.row_version !== input.rowVersion
        )
          stale();
        const targetSpaceId = input.spaceId ?? current.space_id;
        await spaceExists(tx, projectId, targetSpaceId);
        const row = await appendRevision(
          tx,
          actor,
          projectId,
          targetSpaceId,
          content,
          { current },
        );
        return knowledgeEntryResponseSchema.parse({
          entry: indexDto(row),
          revision: await revisionDto(
            tx,
            projectId,
            id,
            row.current_revision_id,
          ),
        });
      },
      projectId,
    );
  }
  async remove(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = deleteKnowledgeEntryInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'knowledge.explicit-delete',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        const current = await entryRow(tx, projectId, id, true);
        if (
          current.current_revision_id !== input.baseRevisionId ||
          current.row_version !== input.rowVersion
        )
          stale();
        const row = await appendRevision(
          tx,
          actor,
          projectId,
          current.space_id,
          parseContent(current.content),
          { current, deleted: true },
        );
        return { entry: indexDto(row), historyRetained: true };
      },
      projectId,
    );
  }
  async restorePreview(
    actor: ActorContext,
    projectId: string,
    id: string,
    sourceRevisionId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'knowledge.write');
      const row = await entryRow(tx, projectId, id);
      const source = await revisionDto(tx, projectId, id, sourceRevisionId);
      return {
        current: indexDto(row),
        source,
        effect:
          '将选定旧内容恢复为新的当前修订；保留后来历史，当前正文被新修订替代。',
      };
    });
  }
  async restore(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = restoreKnowledgeInputSchema.parse(raw);
    return this.operations.execute(
      actor,
      'knowledge.restore',
      input.commandId,
      { projectId, id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        const current = await entryRow(tx, projectId, id, true);
        if (
          current.current_revision_id !== input.baseRevisionId ||
          current.row_version !== input.rowVersion
        )
          stale();
        const source = await revisionDto(
          tx,
          projectId,
          id,
          input.sourceRevisionId,
        );
        if (source.deleted)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '请选择包含实际正文的历史修订，不能将删除标记当作恢复内容。',
            422,
          );
        const row = await appendRevision(
          tx,
          actor,
          projectId,
          current.space_id,
          parseContent(source.content),
          { current, force: true, restoredFromRevisionId: source.id },
        );
        return knowledgeEntryResponseSchema.parse({
          entry: indexDto(row),
          revision: await revisionDto(
            tx,
            projectId,
            id,
            row.current_revision_id,
          ),
        });
      },
      projectId,
    );
  }
  async exportReference(actor: ActorContext, projectId: string, raw: unknown) {
    const input = knowledgeExportInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const selection = [];
      for (const id of input.entryIds) {
        const row = await entryRow(tx, projectId, id);
        if (row.deleted)
          throw new DomainError('NOT_FOUND', '导出包含已删除条目。', 404);
        selection.push({ entryId: id, revisionId: row.current_revision_id });
      }
      const path =
        actor.entrypoint === 'official-mcp'
          ? `/api/v1/mcp/knowledge-exports/${projectId}`
          : `/api/v1/projects/${projectId}/knowledge/export`;
      return {
        projectId,
        selection,
        downloadPath: `${path}?selection=${encodeURIComponent(JSON.stringify(selection))}`,
        requiresCurrentAuthorization: true,
      };
    });
  }
  async export(actor: ActorContext, projectId: string, raw: unknown) {
    const selection = knowledgeExportSelectionSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const entries = [];
      for (const selected of selection) {
        const row = await entryRow(tx, projectId, selected.entryId);
        if (row.deleted)
          throw new DomainError('NOT_FOUND', '导出来源当前已删除。', 404);
        entries.push({
          entryId: row.id,
          spaceId: row.space_id,
          revision: await revisionDto(
            tx,
            projectId,
            selected.entryId,
            selected.revisionId,
          ),
        });
      }
      return {
        schemaVersion: 'ath.knowledge-export.v1',
        projectId,
        capturedAt: new Date().toISOString(),
        entries,
      };
    });
  }
}
