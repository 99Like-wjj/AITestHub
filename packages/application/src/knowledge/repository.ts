import { createHash, randomUUID } from 'node:crypto';
import {
  knowledgeContentSchema,
  knowledgeIndexItemSchema,
  knowledgeRevisionSchema,
  type KnowledgeContent,
} from '../../../contracts/src/knowledge.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { canonicalJson } from '../operations/service.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';

export const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export interface EntryRow {
  id: string;
  project_id: string;
  space_id: string;
  current_revision_id: string;
  revision_no: number;
  row_version: number;
  title: string;
  summary: string;
  tags: string[];
  content_digest: string;
  deleted: boolean;
  updated_at: Date;
  content: unknown;
}
export const entrySelect = `SELECT e.*,r.content FROM app.knowledge_entries e JOIN app.knowledge_revisions r ON r.id=e.current_revision_id`;
export const indexDto = (row: EntryRow) =>
  knowledgeIndexItemSchema.parse({
    id: row.id,
    projectId: row.project_id,
    spaceId: row.space_id,
    title: row.title,
    summary: row.summary,
    tags: row.tags,
    revisionId: row.current_revision_id,
    revisionNo: row.revision_no,
    rowVersion: row.row_version,
    contentDigest: row.content_digest,
    deleted: row.deleted,
    updatedAt: row.updated_at.toISOString(),
  });
export function parseContent(raw: unknown): KnowledgeContent {
  const content = knowledgeContentSchema.parse(raw);
  assertSafeModelInput(content);
  return content;
}
export async function spaceExists(
  tx: SqlExecutor,
  projectId: string,
  spaceId: string,
): Promise<void> {
  if (
    !(
      await tx.query(
        'SELECT 1 FROM app.knowledge_spaces WHERE id=$1 AND project_id=$2 FOR SHARE',
        [spaceId, projectId],
      )
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目内没有该知识子库。', 404);
}
export async function entryRow(
  tx: SqlExecutor,
  projectId: string,
  id: string,
  lock = false,
): Promise<EntryRow> {
  // Lock the mutable identity before joining its immutable current revision. If a joined
  // FOR UPDATE waits for another writer, PostgreSQL's recheck can otherwise see the new
  // revision pointer against the old joined row and incorrectly turn a CAS conflict into 404.
  if (
    lock &&
    !(
      await tx.query(
        'SELECT id FROM app.knowledge_entries WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [id, projectId],
      )
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目内没有该知识条目。', 404);
  const row = (
    await tx.query<EntryRow>(
      `${entrySelect} WHERE e.id=$1 AND e.project_id=$2`,
      [id, projectId],
    )
  ).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该知识条目。', 404);
  return row;
}
export async function revisionDto(
  tx: SqlExecutor,
  projectId: string,
  entryId: string,
  id: string,
) {
  const row = (
    await tx.query<{
      id: string;
      entry_id: string;
      revision_no: number;
      content: unknown;
      content_digest: string;
      deleted: boolean;
      restored_from_revision_id: string | null;
      created_by: string;
      created_at: Date;
    }>(
      'SELECT * FROM app.knowledge_revisions WHERE id=$1 AND entry_id=$2 AND project_id=$3',
      [id, entryId, projectId],
    )
  ).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', '此条目内没有该知识修订。', 404);
  return knowledgeRevisionSchema.parse({
    id: row.id,
    entryId: row.entry_id,
    revisionNo: row.revision_no,
    content: row.content,
    contentDigest: row.content_digest,
    deleted: row.deleted,
    restoredFromRevisionId: row.restored_from_revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  });
}
export async function validateReferences(
  tx: SqlExecutor,
  projectId: string,
  content: KnowledgeContent,
): Promise<void> {
  const configurations = content.configurationRefs.map(
    (ref) => ref.configurationId,
  );
  if (
    configurations.length &&
    (
      await tx.query(
        'SELECT id FROM app.test_configurations WHERE project_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
        [projectId, configurations],
      )
    ).rowCount !== configurations.length
  )
    throw new DomainError(
      'NOT_FOUND',
      '结构化配置引用须为本项目现有UUID，知识不存凭据副本。',
      404,
    );
  for (const ref of content.sourceRefs) {
    if (
      ref.kind === 'requirementVersion' &&
      !(
        await tx.query(
          'SELECT 1 FROM app.requirement_versions WHERE id=$1 AND project_id=$2',
          [ref.requirementVersionId, projectId],
        )
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', '来源需求版本不属于此项目。', 404);
    if (
      ref.kind === 'file' &&
      !(
        await tx.query(
          "SELECT 1 FROM app.file_resources WHERE id=$1 AND project_id=$2 AND owner_scope='project' AND status='verified' AND deleted_at IS NULL FOR SHARE",
          [ref.fileId, projectId],
        )
      ).rowCount
    )
      throw new DomainError(
        'FILE_NOT_READY',
        '知识文件来源须为本项目已完整校验的文件；不读取本地路径。',
        422,
      );
  }
}
export async function appendRevision(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  spaceId: string,
  content: KnowledgeContent,
  options: {
    current?: EntryRow;
    deleted?: boolean;
    restoredFromRevisionId?: string;
    force?: boolean;
  } = {},
) {
  const contentDigest = digest(content);
  const deleted = options.deleted ?? false;
  if (
    options.current &&
    !options.force &&
    options.current.content_digest === contentDigest &&
    options.current.deleted === deleted &&
    options.current.space_id === spaceId
  )
    return options.current;
  await validateReferences(tx, projectId, content);
  const id = options.current?.id ?? randomUUID();
  const revisionId = randomUUID();
  const number = (options.current?.revision_no ?? 0) + 1;
  if (!options.current)
    await tx.query(
      `INSERT INTO app.knowledge_entries(id,project_id,space_id,title,summary,tags,content_digest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        projectId,
        spaceId,
        content.title,
        content.summary,
        content.tags,
        contentDigest,
        actor.userId,
      ],
    );
  await tx.query(
    `INSERT INTO app.knowledge_revisions(id,project_id,entry_id,revision_no,content,content_digest,deleted,restored_from_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      revisionId,
      projectId,
      id,
      number,
      JSON.stringify(content),
      contentDigest,
      deleted,
      options.restoredFromRevisionId ?? null,
      actor.userId,
    ],
  );
  await tx.query(
    `UPDATE app.knowledge_entries SET current_revision_id=$2,revision_no=$3,row_version=row_version+$4,title=$5,summary=$6,tags=$7,content_digest=$8,deleted=$9,space_id=$10,updated_at=clock_timestamp() WHERE id=$1`,
    [
      id,
      revisionId,
      number,
      options.current ? 1 : 0,
      content.title,
      content.summary,
      content.tags,
      contentDigest,
      deleted,
      spaceId,
    ],
  );
  for (const ref of content.sourceRefs)
    if (ref.kind === 'file')
      await tx.query(
        "INSERT INTO app.resource_references(resource_id,project_id,reference_type,reference_id,created_by) VALUES($1,$2,'knowledge',$3,$4) ON CONFLICT DO NOTHING",
        [ref.fileId, projectId, revisionId, actor.userId],
      );
  await audit(
    tx,
    actor,
    options.restoredFromRevisionId
      ? 'knowledge.restored'
      : deleted
        ? 'knowledge.deleted'
        : 'knowledge.saved',
    id,
    projectId,
    {
      revisionId,
      revisionNo: number,
      contentDigest,
      restoredFromRevisionId: options.restoredFromRevisionId ?? null,
      previousSpaceId: options.current?.space_id ?? null,
      spaceId,
    },
  );
  return entryRow(tx, projectId, id);
}
