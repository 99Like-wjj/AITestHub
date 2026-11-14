import { randomUUID } from 'node:crypto';
import {
  compareKnowledgeInputSchema,
  commitKnowledgeSelectionInputSchema,
  knowledgeComparisonSchema,
  knowledgeComparisonResponseSchema,
  knowledgeSelectionReceiptSchema,
  knowledgeSelectionHistoryQuerySchema,
  knowledgeSelectionHistorySchema,
  type KnowledgeComparisonItem,
} from '../../../contracts/src/knowledge.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import {
  appendRevision,
  digest,
  entryRow,
  indexDto,
  parseContent,
  spaceExists,
  type EntryRow,
} from './repository.js';

export class KnowledgeComparisons {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  private async stored(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    id: string,
    lock = false,
  ) {
    const row = (
      await tx.query<{ payload: unknown }>(
        `SELECT payload FROM app.knowledge_comparisons WHERE id=$1 AND project_id=$2 AND owner_id=$3${lock ? ' FOR UPDATE' : ''}`,
        [id, projectId, actor.userId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        'NOT_FOUND',
        '没有本人在此项目创建的知识比较。',
        404,
      );
    return knowledgeComparisonSchema.parse(row.payload);
  }
  async get(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'knowledge.write');
      return knowledgeComparisonResponseSchema.parse({
        comparison: await this.stored(tx, actor, projectId, id),
      });
    });
  }
  async compare(actor: ActorContext, projectId: string, raw: unknown) {
    const input = compareKnowledgeInputSchema.parse(raw);
    for (const item of input.localManifest)
      if (item.operation === 'upsert') parseContent(item.content);
    return this.operations.execute(
      actor,
      'knowledge.compare',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        await spaceExists(tx, projectId, input.spaceId);
        if (
          input.remoteEntryIds &&
          input.localManifest.some(
            (item) =>
              item.entryId && !input.remoteEntryIds?.includes(item.entryId),
          )
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '本地已映射身份必须属于明确选择的平台比较范围。',
            400,
          );
        // Capture one database snapshot. Only explicitly mapped entries include a body;
        // platform-only entries remain a light manifest rather than an implicit full-library read.
        const mappedIds = input.localManifest.flatMap((item) =>
          item.entryId ? [item.entryId] : [],
        );
        const remote = await tx.query<EntryRow>(
          `SELECT e.*,CASE WHEN e.id=ANY($4::uuid[]) THEN r.content ELSE NULL END content
        FROM app.knowledge_entries e JOIN app.knowledge_revisions r ON r.id=e.current_revision_id
        WHERE e.project_id=$1 AND e.space_id=$2 AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[])) ORDER BY e.id LIMIT 201`,
          [projectId, input.spaceId, input.remoteEntryIds ?? null, mappedIds],
        );
        if (remote.rows.length > 200)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '此子库超过单次比较限额，请明确选择remoteEntryIds；未假称比较全库。',
            422,
          );
        if (
          input.remoteEntryIds &&
          remote.rows.length !== input.remoteEntryIds.length
        )
          throw new DomainError(
            'NOT_FOUND',
            '明确选择的平台知识范围含不存在或其他子库的身份。',
            404,
          );
        const byId = new Map(remote.rows.map((row) => [row.id, row]));
        const represented = new Set<string>();
        const items: KnowledgeComparisonItem[] = [];
        for (const local of input.localManifest) {
          if (local.entryId === null) {
            const content = parseContent(
              local.operation === 'upsert' ? local.content : null,
            );
            const candidates = remote.rows
              .filter(
                (row) =>
                  !row.deleted &&
                  (row.title.toLocaleLowerCase() ===
                    content.title.toLocaleLowerCase() ||
                    row.content_digest === digest(content)),
              )
              .slice(0, 20)
              .map(indexDto);
            items.push({
              changeId: randomUUID(),
              localId: local.localId,
              entryId: null,
              classification: 'create',
              reason:
                '新知识使用新UUID；同名或同哈希只列匹配候选，不自动当作同一身份。',
              localOperation: 'upsert',
              localBaseRevisionId: null,
              remoteRevisionId: null,
              remoteRowVersion: null,
              remoteDeleted: false,
              localContent: content,
              remoteContent: null,
              remoteIndex: null,
              matchCandidates: candidates,
            });
            continue;
          }
          const listed = byId.get(local.entryId);
          if (!listed)
            throw new DomainError(
              'NOT_FOUND',
              '已映射条目不属于此项目/子库明确比较范围。',
              404,
            );
          const row = listed;
          represented.add(row.id);
          const remoteContent = parseContent(row.content);
          const localContent =
            local.operation === 'upsert' ? parseContent(local.content) : null;
          const same =
            local.operation === 'explicitDelete'
              ? row.deleted
              : !row.deleted && digest(localContent) === row.content_digest;
          const staleBase = local.baseRevisionId !== row.current_revision_id;
          const classification = same
            ? 'unchanged'
            : staleBase || row.deleted
              ? 'conflict'
              : local.operation === 'explicitDelete'
                ? 'explicitDelete'
                : 'update';
          items.push({
            changeId: randomUUID(),
            localId: local.localId,
            entryId: row.id,
            classification,
            reason: same
              ? '两端已映射内容相同，无写入。'
              : row.deleted
                ? '平台已显式删除；必须人工明确选择是否恢复本地内容。'
                : staleBase
                  ? '两端无共同当前基准或本地基准已过期，请人工保留平台、本地或提交合并内容。'
                  : local.operation === 'explicitDelete'
                    ? '本地明确提出删除，等待人工选择；历史保留。'
                    : '本地明确提出修改，等待人工选择。',
            localOperation: local.operation,
            localBaseRevisionId: local.baseRevisionId,
            remoteRevisionId: row.current_revision_id,
            remoteRowVersion: row.row_version,
            remoteDeleted: row.deleted,
            localContent,
            remoteContent,
            remoteIndex: indexDto(row),
            matchCandidates: [],
          });
        }
        for (const row of remote.rows)
          if (!represented.has(row.id))
            items.push({
              changeId: randomUUID(),
              localId: null,
              entryId: row.id,
              classification: 'unchanged',
              reason: '只有平台侧条目；本地清单缺席不代表删除，保持平台内容。',
              localOperation: null,
              localBaseRevisionId: null,
              remoteRevisionId: row.current_revision_id,
              remoteRowVersion: row.row_version,
              remoteDeleted: row.deleted,
              localContent: null,
              remoteContent: null,
              remoteIndex: indexDto(row),
              matchCandidates: [],
            });
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const payload = {
          id,
          projectId,
          spaceId: input.spaceId,
          items,
          createdAt,
          omittedRemoteEntriesDeleted: false as const,
        };
        const comparison = knowledgeComparisonSchema.parse({
          ...payload,
          scopeDigest: digest(payload),
        });
        await tx.query(
          'INSERT INTO app.knowledge_comparisons(id,project_id,space_id,owner_id,scope_digest,payload) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            projectId,
            input.spaceId,
            actor.userId,
            comparison.scopeDigest,
            JSON.stringify(comparison),
          ],
        );
        await audit(tx, actor, 'knowledge.compared', id, projectId, {
          spaceId: input.spaceId,
          itemCount: items.length,
          scopeDigest: comparison.scopeDigest,
        });
        return knowledgeComparisonResponseSchema.parse({ comparison });
      },
      projectId,
    );
  }
  async selectionHistory(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = knowledgeSelectionHistoryQuerySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'knowledge.write');
      const comparison = await this.stored(tx, actor, projectId, id);
      if (input.afterSelectionId) {
        const anchor = await tx.query(
          'SELECT id FROM app.knowledge_selections WHERE id=$1 AND comparison_id=$2 AND actor_id=$3',
          [input.afterSelectionId, id, actor.userId],
        );
        if (!anchor.rows.length)
          throw new DomainError('NOT_FOUND', '此比较没有该本人回执游标。', 404);
      }
      const rows = await tx.query<{
        id: string;
        created_at: Date;
        receipt: unknown;
      }>(
        `SELECT id,created_at,receipt FROM app.knowledge_selections
         WHERE comparison_id=$1 AND actor_id=$2 AND
           ($3::uuid IS NULL OR (created_at,id) >
             (SELECT created_at,id FROM app.knowledge_selections WHERE id=$3 AND comparison_id=$1 AND actor_id=$2))
         ORDER BY created_at,id LIMIT $4`,
        [id, actor.userId, input.afterSelectionId ?? null, input.limit + 1],
      );
      const page = rows.rows.slice(0, input.limit);
      const hasMore = rows.rows.length > input.limit;
      return knowledgeSelectionHistorySchema.parse({
        comparisonId: id,
        scopeDigest: comparison.scopeDigest,
        selections: page.map((row) => ({
          createdAt: row.created_at.toISOString(),
          receipt: row.receipt,
        })),
        hasMore,
        nextCursor: hasMore ? page.at(-1)!.id : null,
      });
    });
  }
  async selectionPreview(actor: ActorContext, projectId: string, raw: unknown) {
    const input = commitKnowledgeSelectionInputSchema.parse(raw);
    const { comparison } = await this.get(actor, projectId, input.comparisonId);
    if (comparison.scopeDigest !== input.scopeDigest)
      throw new DomainError('BUSINESS_CONFLICT', '知识比较摘要不一致。', 409);
    const selected = input.selections.map((selection) => {
      const item = comparison.items.find(
        (candidate) => candidate.changeId === selection.changeId,
      );
      if (!item)
        throw new DomainError(
          'BUSINESS_CONFLICT',
          '选择包含原比较范围以外的变更，未执行。',
          409,
        );
      if (selection.choice === 'merged') {
        parseContent(selection.content);
        if (
          item.localOperation === 'explicitDelete' ||
          item.localOperation === null
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '只有明确本地正文变更可合并；平台独有项或删除动作不能暗改成正文合并。',
            400,
          );
      }
      return { selection, item };
    });
    return {
      comparisonId: comparison.id,
      projectId,
      spaceId: comparison.spaceId,
      scopeDigest: comparison.scopeDigest,
      selected,
      effect:
        '只处理明确选择的原changeId；未选项及缺席条目保持，提交再次检验平台基准。',
    };
  }
  async commit(actor: ActorContext, projectId: string, raw: unknown) {
    const input = commitKnowledgeSelectionInputSchema.parse(raw);
    for (const selection of input.selections)
      if (selection.choice === 'merged') parseContent(selection.content);
    return this.operations.execute(
      actor,
      'knowledge.commit-selection',
      input.commandId,
      { projectId, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'knowledge.write');
      },
      async (tx) => {
        const comparison = await this.stored(
          tx,
          actor,
          projectId,
          input.comparisonId,
          true,
        );
        if (comparison.scopeDigest !== input.scopeDigest)
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '知识比较摘要不一致；未执行。',
            409,
          );
        const items = new Map(
          comparison.items.map((item) => [item.changeId, item]),
        );
        if (
          input.selections.some((selection) => !items.has(selection.changeId))
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '不能扩大到原比较范围以外的changeId。',
            409,
          );
        if (
          input.selections.some(
            (selection) =>
              selection.choice === 'merged' &&
              items.get(selection.changeId)?.localOperation !== 'upsert',
          )
        )
          throw new DomainError(
            'VALIDATION_ERROR',
            '只有明确本地正文变更可接受合并选择。',
            400,
          );
        const locked = new Map<string, EntryRow>();
        for (const id of [
          ...new Set(
            input.selections.flatMap((selection) =>
              items.get(selection.changeId)?.entryId
                ? [items.get(selection.changeId)!.entryId!]
                : [],
            ),
          ),
        ].sort())
          locked.set(id, await entryRow(tx, projectId, id, true));
        const results = [];
        for (const [index, selection] of input.selections.entries()) {
          const item = items.get(selection.changeId)!;
          const current = item.entryId ? locked.get(item.entryId) : undefined;
          const preserved = {
            localContent:
              selection.choice === 'merged'
                ? selection.content
                : item.localContent,
            remoteCurrent: current ? indexDto(current) : null,
          };
          // A new command must not create the same comparison change twice.
          // Same-command retries still use OperationService's immutable receipt.
          if (item.entryId === null && item.localOperation === 'upsert') {
            const applied = (
              await tx.query<{ result: unknown }>(
                `SELECT result FROM app.knowledge_selections s
               CROSS JOIN LATERAL jsonb_array_elements(s.receipt->'results') result
               WHERE s.comparison_id=$1 AND s.actor_id=$2 AND result->>'changeId'=$3
                 AND result->>'status'='created' ORDER BY s.created_at,s.id LIMIT 1`,
                [comparison.id, actor.userId, item.changeId],
              )
            ).rows[0];
            if (applied) {
              const previous =
                knowledgeSelectionReceiptSchema.shape.results.element.parse(
                  applied.result,
                );
              results.push({
                changeId: item.changeId,
                status: 'conflict' as const,
                entryId: previous.entryId,
                revisionId: previous.revisionId,
                code: 'CHANGE_ALREADY_APPLIED',
                ...preserved,
              });
              continue;
            }
          }
          if (
            current &&
            (current.current_revision_id !== item.remoteRevisionId ||
              current.row_version !== item.remoteRowVersion)
          ) {
            results.push({
              changeId: item.changeId,
              status: 'conflict' as const,
              entryId: current.id,
              revisionId: current.current_revision_id,
              code: 'STALE_BASE_REVISION',
              ...preserved,
            });
            continue;
          }
          if (selection.choice === 'remote') {
            results.push({
              changeId: item.changeId,
              status: 'keptRemote' as const,
              entryId: current?.id ?? null,
              revisionId: current?.current_revision_id ?? null,
              code: null,
              ...preserved,
            });
            continue;
          }
          if (
            item.localOperation === null ||
            (item.classification === 'unchanged' &&
              selection.choice !== 'merged')
          ) {
            results.push({
              changeId: item.changeId,
              status: 'unchanged' as const,
              entryId: current?.id ?? null,
              revisionId: current?.current_revision_id ?? null,
              code: null,
              ...preserved,
            });
            continue;
          }
          await tx.query(`SAVEPOINT knowledge_item_${index}`);
          try {
            if (
              item.localOperation === 'explicitDelete' &&
              selection.choice === 'merged'
            )
              throw new DomainError(
                'VALIDATION_ERROR',
                '删除动作不接受合并正文。',
                400,
              );
            const deleted = item.localOperation === 'explicitDelete';
            const content = parseContent(
              selection.choice === 'merged'
                ? selection.content
                : deleted
                  ? current?.content
                  : item.localContent,
            );
            const row = await appendRevision(
              tx,
              actor,
              projectId,
              comparison.spaceId,
              content,
              { ...(current ? { current } : {}), deleted },
            );
            results.push({
              changeId: item.changeId,
              status:
                current &&
                current.current_revision_id === row.current_revision_id
                  ? ('unchanged' as const)
                  : deleted
                    ? ('deleted' as const)
                    : current
                      ? ('updated' as const)
                      : ('created' as const),
              entryId: row.id,
              revisionId: row.current_revision_id,
              code: null,
              ...preserved,
            });
            await tx.query(`RELEASE SAVEPOINT knowledge_item_${index}`);
          } catch (error: unknown) {
            await tx.query(`ROLLBACK TO SAVEPOINT knowledge_item_${index}`);
            if (!(error instanceof DomainError)) throw error;
            results.push({
              changeId: item.changeId,
              status: 'conflict' as const,
              entryId: current?.id ?? null,
              revisionId: current?.current_revision_id ?? null,
              code: error.code,
              ...preserved,
            });
          }
        }
        const selectionId = randomUUID();
        const receipt = knowledgeSelectionReceiptSchema.parse({
          comparisonId: comparison.id,
          scopeDigest: comparison.scopeDigest,
          selectionId,
          results,
        });
        await tx.query(
          'INSERT INTO app.knowledge_selections(id,comparison_id,actor_id,selections,receipt) VALUES($1,$2,$3,$4,$5)',
          [
            selectionId,
            comparison.id,
            actor.userId,
            JSON.stringify(input.selections),
            JSON.stringify(receipt),
          ],
        );
        await audit(
          tx,
          actor,
          'knowledge.selection-committed',
          selectionId,
          projectId,
          {
            comparisonId: comparison.id,
            scopeDigest: comparison.scopeDigest,
            selectedCount: input.selections.length,
            conflictCount: results.filter((item) => item.status === 'conflict')
              .length,
          },
        );
        return receipt;
      },
      projectId,
    );
  }
}
