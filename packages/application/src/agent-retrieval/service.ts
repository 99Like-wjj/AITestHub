import { z } from 'zod';
import {
  retrievalSearchInputSchema,
  retrievalChunkSchema,
  retrievalCoverageSchema,
  retrievalResultSchema,
  type RetrievalSource,
  type RetrievalChunk,
  type SemanticEmbeddingPort,
} from '../../../contracts/src/agent-retrieval.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { AiToolSourceReference } from '../../../contracts/src/conversations.js';
import type { Database } from '../../../persistence/src/database.js';
import type { FilesService } from '../files/service.js';
import type { AgentDocumentsService } from '../agent-documents/service.js';
import type { ConversationReferences } from '../conversations/references.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { RetrievalSources, type RetrievalScope } from './sources.js';
import {
  lexicalOverlap,
  retrievalDigest,
  semanticCosine,
  sourceChunks,
} from './ranking.js';

interface IndexRow {
  source_stamp: string;
  model_revision: string;
  chunks: unknown;
  vectors: unknown;
  coverage: unknown;
}
interface RetrievalIndex {
  source: RetrievalSource;
  header: Awaited<ReturnType<RetrievalSources['header']>>;
  chunks: RetrievalChunk[];
  vectors: number[][];
  coverage: z.infer<typeof retrievalCoverageSchema>;
  reused: boolean;
}
const kindId = (source: RetrievalSource) =>
  source.kind === 'resource'
    ? source.resourceId
    : source.kind === 'knowledge'
      ? source.entryId
      : source.conversationId;

export class AgentRetrievalService {
  readonly sources: RetrievalSources;
  constructor(
    readonly db: Database,
    files: FilesService,
    documents: AgentDocumentsService | undefined,
    readonly embedding: SemanticEmbeddingPort,
    references: ConversationReferences,
  ) {
    this.sources = new RetrievalSources(db, files, documents, references);
  }
  async #clear(actor: ActorContext, source: RetrievalSource) {
    await this.db.query(
      'DELETE FROM app.agent_retrieval_indexes WHERE owner_id=$1 AND source_key=$2',
      [actor.userId, retrievalDigest(source)],
    );
  }
  async #recheck(
    actor: ActorContext,
    source: RetrievalSource,
    stamp: string,
    scope: RetrievalScope,
  ) {
    try {
      const current = await this.sources.header(actor, source, scope);
      if (current.stamp !== stamp)
        throw new DomainError(
          'STALE_BASE_REVISION',
          '检索期间来源已变化，未使用旧正文。',
          412,
        );
      return current;
    } catch (error) {
      await this.#clear(actor, source);
      throw error;
    }
  }
  async #index(
    actor: ActorContext,
    source: RetrievalSource,
    scope: RetrievalScope,
  ) {
    let header: Awaited<ReturnType<RetrievalSources['header']>>;
    try {
      header = await this.sources.header(actor, source, scope);
    } catch (error) {
      await this.#clear(actor, source);
      throw error;
    }
    const key = retrievalDigest(source);
    const saved = (
      await this.db.query<IndexRow>(
        'SELECT source_stamp,model_revision,chunks,vectors,coverage FROM app.agent_retrieval_indexes WHERE owner_id=$1 AND source_key=$2',
        [actor.userId, key],
      )
    ).rows[0];
    const vectorSchema = z
      .array(z.array(z.number().finite()).length(this.embedding.dimensions))
      .max(256);
    if (
      saved &&
      saved.source_stamp === header.stamp &&
      saved.model_revision === this.embedding.modelRevision
    ) {
      const chunks = z.array(retrievalChunkSchema).max(256).parse(saved.chunks),
        vectors = vectorSchema.parse(saved.vectors),
        coverage = retrievalCoverageSchema.parse(saved.coverage);
      if (chunks.length !== vectors.length)
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '语义索引的片段与向量数量不一致，未返回可疑结果。',
          503,
        );
      return { source, header, chunks, vectors, coverage, reused: true };
    }
    await this.#clear(actor, source);
    const body = await this.sources.body(actor, source, header, scope);
    const split = sourceChunks(body.blocks);
    assertSafeModelInput(split.chunks);
    await this.#recheck(actor, source, header.stamp, scope);
    const embedded = split.chunks.length
      ? await this.embedding.embed(
          split.chunks.map((chunk) => chunk.text),
          'passage',
          scope.signal,
        )
      : { vectors: [], tokenTruncated: [] };
    const vectors = vectorSchema.parse(embedded.vectors);
    if (
      vectors.length !== split.chunks.length ||
      embedded.tokenTruncated.length !== split.chunks.length
    )
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '语义服务未返回全部片段向量。',
        503,
      );
    const coverage = retrievalCoverageSchema.parse({
      state: !split.chunks.length
        ? body.visualMissing
          ? 'visualNotIndexed'
          : 'empty'
        : body.incomplete ||
            body.visualMissing ||
            split.incomplete ||
            embedded.tokenTruncated.some(Boolean)
          ? 'partialText'
          : 'completeText',
      warnings: [
        ...body.warnings,
        ...(split.incomplete
          ? ['本次最多索引256个片段，尚有正文未进入语义索引，请缩小结构范围。']
          : []),
        ...(embedded.tokenTruncated.some(Boolean)
          ? ['部分片段超过语义模型512 token范围，仅前部参与向量计算。']
          : []),
      ].slice(0, 100),
      nextOffset: body.nextOffset,
      indexedChunks: split.chunks.length,
      tokenTruncatedChunks: embedded.tokenTruncated.filter(Boolean).length,
    });
    const checked = await this.sources.header(actor, source, scope);
    if (checked.stamp !== header.stamp)
      throw new DomainError(
        'STALE_BASE_REVISION',
        '索引期间来源已修订，未保存旧索引。',
        412,
      );
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `agent-retrieval:${actor.userId}`,
      ]);
      await tx.query(
        'INSERT INTO app.agent_retrieval_indexes(owner_id,source_key,source_kind,source_id,source_stamp,model_revision,chunks,vectors,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,source_key) DO UPDATE SET source_stamp=EXCLUDED.source_stamp,model_revision=EXCLUDED.model_revision,chunks=EXCLUDED.chunks,vectors=EXCLUDED.vectors,coverage=EXCLUDED.coverage,updated_at=now()',
        [
          actor.userId,
          key,
          source.kind,
          kindId(source),
          header.stamp,
          this.embedding.modelRevision,
          JSON.stringify(split.chunks),
          JSON.stringify(vectors),
          JSON.stringify(coverage),
        ],
      );
      await tx.query(
        'DELETE FROM app.agent_retrieval_indexes WHERE owner_id=$1 AND source_key IN (SELECT source_key FROM app.agent_retrieval_indexes WHERE owner_id=$1 ORDER BY updated_at DESC,source_key OFFSET 40)',
        [actor.userId],
      );
    });
    return {
      source,
      header,
      chunks: split.chunks,
      vectors,
      coverage,
      reused: false,
    };
  }
  async search(actor: ActorContext, raw: unknown, scope: RetrievalScope) {
    const input = retrievalSearchInputSchema.parse(raw);
    if (
      new Set(input.sources.map(retrievalDigest)).size !== input.sources.length
    )
      throw new DomainError('VALIDATION_ERROR', '检索来源不可重复。', 400);
    assertSafeModelInput(input.query);
    await scope.authorize();
    scope.signal?.throwIfAborted();
    const indexes: RetrievalIndex[] = [];
    for (const source of input.sources) {
      scope.signal?.throwIfAborted();
      indexes.push(await this.#index(actor, source, scope));
    }
    const query = await this.embedding.embed(
        [input.query],
        'query',
        scope.signal,
      ),
      vector = query.vectors[0];
    if (!vector || vector.length !== this.embedding.dimensions)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '语义服务没有返回可用查询向量。',
        503,
      );
    const candidates: Omit<
      z.infer<typeof retrievalResultSchema>['results'][number],
      'citation'
    >[] = indexes
      .flatMap((index) =>
        index.chunks.map((chunk, position) => {
          const stored = index.vectors[position];
          if (!stored)
            throw new DomainError(
              'DEPENDENCY_UNAVAILABLE',
              '语义索引不完整。',
              503,
            );
          const semanticScore = semanticCosine(vector, stored),
            lexicalScore = lexicalOverlap(input.query, chunk.text);
          return {
            source:
              index.source.kind === 'knowledge' && index.header.knowledge
                ? {
                    ...index.source,
                    revisionId: index.header.knowledge.revision.id,
                  }
                : index.source,
            sourceStamp: index.header.stamp,
            sourceHash: index.header.sourceHash,
            title: index.header.title,
            chunk,
            semanticScore,
            lexicalScore,
            relevanceScore: null,
            score: semanticScore * 0.95 + lexicalScore * 0.05,
          };
        }),
      )
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, 32);
    let reranking: z.infer<typeof retrievalResultSchema>['reranking'] = {
      applied: false,
      modelRevision: null,
      candidates: candidates.length,
      truncated: false,
    };
    if (this.embedding.rerank && candidates.length) {
      for (const index of indexes)
        await this.#recheck(actor, index.source, index.header.stamp, scope);
      const ranked = await this.embedding.rerank(
        input.query,
        candidates.map((row) => row.chunk.text),
        scope.signal,
      );
      if (
        ranked.scores.length !== candidates.length ||
        ranked.tokenTruncated.length !== candidates.length
      )
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '相关性重排没有返回全部候选。',
          503,
        );
      for (const [index, row] of candidates.entries()) {
        const value = ranked.scores[index];
        if (value === undefined || !Number.isFinite(value))
          throw new DomainError(
            'DEPENDENCY_UNAVAILABLE',
            '相关性分数不完整。',
            503,
          );
        row.relevanceScore = value;
        row.score = value;
      }
      reranking = {
        applied: true,
        modelRevision: ranked.modelRevision,
        candidates: candidates.length,
        truncated: ranked.tokenTruncated.some(Boolean),
      };
    }
    const ranked = candidates
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, input.limit)
      .map((row, index) => ({ citation: `R${index + 1}`, ...row }));
    const sourceRefs: AiToolSourceReference[] = [];
    for (const index of indexes) {
      const current = await this.#recheck(
        actor,
        index.source,
        index.header.stamp,
        scope,
      );
      sourceRefs.push(...current.sourceRefs);
    }
    await scope.authorize();
    scope.signal?.throwIfAborted();
    const result = retrievalResultSchema.parse({
      method: 'multilingual-e5-semantic-hybrid',
      modelRevision: this.embedding.modelRevision,
      query: input.query,
      queryTruncated: Boolean(query.tokenTruncated[0]),
      reranking,
      results: ranked,
      coverage: indexes.map((index) => ({
        source:
          index.source.kind === 'knowledge' && index.header.knowledge
            ? {
                ...index.source,
                revisionId: index.header.knowledge.revision.id,
              }
            : index.source,
        sourceStamp: index.header.stamp,
        sourceHash: index.header.sourceHash,
        title: index.header.title,
        reused: index.reused,
        coverage: index.coverage,
      })),
      notice:
        '语义相关性只表示候选排序，不是事实结论、概率或测试验收。引用请保留citation、原来源及结构位置；视觉未索引、截断和未读取范围以coverage为准。',
    });
    assertSafeModelInput(result);
    return {
      ...result,
      sourceRefs: [
        ...new Map(
          sourceRefs.map((ref) => [retrievalDigest(ref), ref]),
        ).values(),
      ],
    };
  }
}

export { redactAgentRetrievalSource } from './privacy.js';
