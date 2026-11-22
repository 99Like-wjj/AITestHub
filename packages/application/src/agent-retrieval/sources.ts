import { createHash } from 'node:crypto';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { AiToolSourceReference } from '../../../contracts/src/conversations.js';
import type { RetrievalSource } from '../../../contracts/src/agent-retrieval.js';
import { documentMediaTypeSchema } from '../../../contracts/src/agent-documents.js';
import type { Database } from '../../../persistence/src/database.js';
import { FilesService } from '../files/service.js';
import {
  decodeUtf8Source,
  isTextSource,
  maximumTextSourceBytes,
  readBoundedSource,
} from '../files/source-content.js';
import { KnowledgeService } from '../knowledge/service.js';
import type { AgentDocumentsService } from '../agent-documents/service.js';
import type { ConversationReferences } from '../conversations/references.js';
import { conversationRow } from '../conversations/common.js';
import { conversationDisplayTitle } from '../conversations/title.js';
import { DomainError } from '../errors.js';
import { retrievalDigest } from './ranking.js';

export interface RetrievalScope {
  conversationId: string;
  dataScope: 'syntheticPublicOnly' | 'authorizedRelevantTestData';
  authorize: () => Promise<void>;
  authorizeSource: (
    source: RetrievalSource,
    metadata?: { projectId?: string },
  ) => Promise<void>;
  signal?: AbortSignal;
}
interface SourceHeader {
  title: string;
  stamp: string;
  sourceHash: string;
  sourceRefs: AiToolSourceReference[];
  resource?: Awaited<ReturnType<FilesService['metadata']>>['file'];
  knowledge?: Awaited<ReturnType<KnowledgeService['reference']>>;
  messages?: { id: string; role: string; content: string; status: string }[];
}
export interface SourceBody {
  blocks: { location: string; text: string }[];
  warnings: string[];
  visualMissing: boolean;
  incomplete: boolean;
  nextOffset: number | null;
}
/** Reads only the explicit source selection. Authorization is never cached with its content. */
export class RetrievalSources {
  constructor(
    readonly db: Database,
    readonly files: FilesService,
    readonly documents: AgentDocumentsService | undefined,
    readonly references: ConversationReferences,
  ) {}
  async header(
    actor: ActorContext,
    source: RetrievalSource,
    scope: RetrievalScope,
  ): Promise<SourceHeader> {
    await scope.authorize();
    scope.signal?.throwIfAborted();
    await this.db.transaction((tx) =>
      conversationRow(tx, actor, scope.conversationId, false, true),
    );
    if (source.kind === 'resource') {
      await scope.authorizeSource(source);
      const { file } = await this.files.metadata(
        { ...actor, entrypoint: 'web' },
        source.resourceId,
      );
      if (file.status !== 'verified')
        throw new DomainError('FILE_NOT_READY', '来源文件尚未完成校验。', 422);
      if (file.projectId)
        await scope.authorizeSource(source, { projectId: file.projectId });
      return {
        title: file.originalName.slice(0, 500),
        sourceHash: file.sha256,
        stamp: retrievalDigest({
          resourceId: file.id,
          sha256: file.sha256,
          mediaType: file.mediaType,
        }),
        resource: file,
        sourceRefs: [{ kind: 'resource', resourceId: file.id }],
      };
    }
    if (source.kind === 'knowledge') {
      const location = (
        await this.db.query<{ project_id: string }>(
          'SELECT project_id FROM app.knowledge_entries WHERE id=$1',
          [source.entryId],
        )
      ).rows[0];
      if (!location)
        throw new DomainError('NOT_FOUND', '知识来源不存在。', 404);
      await scope.authorizeSource(source, { projectId: location.project_id });
      const knowledge = await new KnowledgeService(this.db).reference(
        actor,
        source.entryId,
        source.revisionId,
      );
      return {
        title: knowledge.revision.content.title.slice(0, 500),
        sourceHash: knowledge.revision.contentDigest,
        stamp: retrievalDigest({
          entryId: source.entryId,
          currentRevision: knowledge.entry.revisionId,
          revisionId: knowledge.revision.id,
          digest: knowledge.revision.contentDigest,
        }),
        knowledge,
        sourceRefs: [
          {
            kind: 'knowledge',
            entryId: source.entryId,
            revisionId: knowledge.revision.id,
          },
        ],
      };
    }
    await scope.authorizeSource(source);
    const conversation = await this.db.transaction((tx) =>
      conversationRow(tx, actor, source.conversationId, false, true),
    );
    if (conversation.project_id)
      await scope.authorizeSource(source, {
        projectId: conversation.project_id,
      });
    const messages = (
      await this.db.query<{
        id: string;
        role: string;
        content: string;
        status: string;
        data_scope: string | null;
      }>(
        `SELECT m.id,m.role,m.content,m.status,t.data_scope FROM app.ai_messages m
       LEFT JOIN app.ai_tasks t ON (t.user_message_id=m.id OR t.assistant_message_id=m.id) AND t.conversation_id=m.conversation_id
       WHERE m.conversation_id=$1 AND m.id=ANY($2::uuid[]) AND m.deleted_at IS NULL AND (m.role='user' OR m.status IN ('completed','failed','cancelled','interrupted')) ORDER BY m.created_at,m.id`,
        [source.conversationId, source.messageIds],
      )
    ).rows;
    if (messages.length !== source.messageIds.length)
      throw new DomainError(
        'NOT_FOUND',
        '部分会话消息已删除或尚未完成，未使用旧索引。',
        404,
      );
    if (
      scope.dataScope === 'syntheticPublicOnly' &&
      messages.some(
        (m) => m.data_scope && m.data_scope !== 'syntheticPublicOnly',
      )
    )
      throw new DomainError(
        'FORBIDDEN',
        '此会话包含非公开资料，不能改标为公开来源。',
        403,
      );
    const frozen = {
      reference: {
        kind: 'conversation',
        conversationId: source.conversationId,
        mode: 'full',
        dataScope: scope.dataScope,
      },
      messageIds: source.messageIds,
      resourceIds: [],
    };
    if (!(await this.references.readable(actor, frozen)))
      throw new DomainError(
        'FORBIDDEN',
        '所选消息的原始来源当前不可读，未使用派生正文。',
        403,
      );
    return {
      title: conversationDisplayTitle(conversation).slice(0, 500),
      stamp: retrievalDigest(messages),
      sourceHash: retrievalDigest(messages),
      messages,
      sourceRefs: [
        {
          kind: 'conversation',
          conversationId: source.conversationId,
          messageIds: source.messageIds,
        },
      ],
    };
  }
  async body(
    actor: ActorContext,
    source: RetrievalSource,
    header: SourceHeader,
    scope: RetrievalScope,
  ): Promise<SourceBody> {
    const base = {
      warnings: [] as string[],
      visualMissing: false,
      incomplete: false,
      nextOffset: null as number | null,
    };
    if (header.knowledge) {
      const body = header.knowledge.revision.content;
      return {
        ...base,
        blocks: [
          { location: 'title', text: body.title },
          { location: 'summary', text: body.summary },
          ...body.body.split(/\n\s*\n/u).map((text, index) => ({
            location: `paragraph:${index + 1}`,
            text,
          })),
        ],
      };
    }
    if (header.messages)
      return {
        ...base,
        incomplete: header.messages.some(
          (m) => m.role === 'assistant' && m.status !== 'completed',
        ),
        warnings: header.messages.some(
          (m) => m.role === 'assistant' && m.status !== 'completed',
        )
          ? ['包含已保存但未完整结束的助手输出，不能当作完成结论。']
          : [],
        blocks: header.messages.map((m) => ({
          location: `message:${m.id};role:${m.role};state:${m.status}`,
          text: m.content,
        })),
      };
    if (source.kind !== 'resource' || !header.resource)
      throw new DomainError('NOT_FOUND', '来源内容不存在。', 404);
    if (documentMediaTypeSchema.safeParse(header.resource.mediaType).success) {
      if (!this.documents?.parser)
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '文档解析服务未配置，不能建立真实文档索引。',
          503,
        );
      const blocks: SourceBody['blocks'] = [],
        warnings = new Set<string>();
      let offset = source.offset,
        processed = 0,
        visualMissing = false,
        nextOffset: number | null = offset,
        incomplete = false;
      while (nextOffset !== null && processed < source.maxUnits) {
        scope.signal?.throwIfAborted();
        const count = Math.min(
          header.resource.mediaType === 'application/pdf' ? 4 : 40,
          source.maxUnits - processed,
        );
        const result = await this.documents.read(
          actor,
          { resourceId: source.resourceId, offset, limit: count },
          {
            authorizeResource: async () =>
              scope.authorizeSource(
                source,
                header.resource?.projectId
                  ? { projectId: header.resource.projectId }
                  : undefined,
              ),
            ...(scope.signal ? { signal: scope.signal } : {}),
          },
        );
        for (const warning of result.warnings)
          warnings.add(warning.slice(0, 1000));
        for (const block of result.blocks) {
          if (block.imageIndexes.length) visualMissing = true;
          if (
            block.kind === 'image' ||
            /^\[No extractable text layer;/u.test(block.text)
          ) {
            visualMissing = true;
            continue;
          }
          if (block.text.trim())
            blocks.push({ location: block.location, text: block.text });
        }
        processed += Math.max(
          1,
          result.nextOffset === null
            ? result.totalUnits - offset
            : result.nextOffset - offset,
        );
        nextOffset = result.nextOffset;
        if (nextOffset !== null && nextOffset <= offset)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            '文档游标未推进，未把部分内容冒称完整。',
            422,
          );
        offset = nextOffset ?? offset;
        incomplete ||= result.state === 'partial';
      }
      if (visualMissing)
        warnings.add(
          '视觉内容未建立语义文字索引：扫描页、嵌入图片和版式需用ath_document_read的真实图像继续理解。',
        );
      if (nextOffset !== null)
        warnings.add(
          `仅索引本次选定结构范围，后续从offset=${nextOffset}继续。`,
        );
      return {
        blocks,
        warnings: [...warnings].slice(0, 100),
        visualMissing,
        incomplete: incomplete || nextOffset !== null,
        nextOffset,
      };
    }
    if (!isTextSource(header.resource))
      return {
        ...base,
        blocks: [],
        visualMissing: header.resource.mediaType.startsWith('image/'),
        incomplete: true,
        warnings: [
          '此资料没有可用文字层，未伪造语义索引。请通过图像/文档阅读能力读取原件。',
        ],
      };
    const downloaded = await this.files.download(
      { ...actor, entrypoint: 'web' },
      source.resourceId,
    );
    const { bytes, truncated } = await readBoundedSource(
      downloaded.body,
      maximumTextSourceBytes,
      scope.signal,
    );
    if (truncated)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '文字资料超过 1 MiB，请拆分后检索。',
        422,
      );
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      header.resource.sha256
    )
      throw new DomainError(
        'FILE_NOT_READY',
        '来源字节与已验证摘要不符。',
        409,
      );
    const lines = decodeUtf8Source(bytes).split(/\r?\n/u);
    const next = Math.min(lines.length, source.offset + source.maxUnits);
    return {
      ...base,
      incomplete: next < lines.length,
      nextOffset: next < lines.length ? next : null,
      blocks: lines.slice(source.offset, next).map((text, index) => ({
        location: `line:${source.offset + index + 1}`,
        text,
      })),
    };
  }
}
