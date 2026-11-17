import { z } from 'zod';

export const retrievalSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resource'),
    resourceId: z.uuid(),
    offset: z.number().int().min(0).max(100_000).default(0),
    maxUnits: z.number().int().min(1).max(160).default(80),
  }),
  z.strictObject({
    kind: z.literal('knowledge'),
    entryId: z.uuid(),
    revisionId: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal('conversation'),
    conversationId: z.uuid(),
    messageIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);
export type RetrievalSource = z.infer<typeof retrievalSourceSchema>;
export const retrievalSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  sources: z.array(retrievalSourceSchema).min(1).max(20),
  limit: z.number().int().min(1).max(20).default(8),
});
export const retrievalChunkSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  location: z.string().min(1).max(1200),
  text: z.string().min(1).max(2000),
});
export type RetrievalChunk = z.infer<typeof retrievalChunkSchema>;
export const retrievalCoverageSchema = z.strictObject({
  state: z.enum(['completeText', 'partialText', 'visualNotIndexed', 'empty']),
  warnings: z.array(z.string().max(1000)).max(100),
  nextOffset: z.number().int().min(0).nullable(),
  indexedChunks: z.number().int().min(0).max(256),
  tokenTruncatedChunks: z.number().int().min(0).max(256),
});
export const retrievalResultSchema = z.strictObject({
  method: z.literal('multilingual-e5-semantic-hybrid'),
  modelRevision: z.string().min(1).max(200),
  query: z.string().max(1000),
  queryTruncated: z.boolean(),
  reranking: z.strictObject({
    applied: z.boolean(),
    modelRevision: z.string().nullable(),
    candidates: z.number().int().min(0).max(32),
    truncated: z.boolean(),
  }),
  results: z
    .array(
      z.strictObject({
        citation: z.string().max(100),
        source: retrievalSourceSchema,
        sourceStamp: z.string().regex(/^[a-f0-9]{64}$/),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string().max(500),
        chunk: retrievalChunkSchema,
        semanticScore: z.number().finite().min(-1.001).max(1.001),
        lexicalScore: z.number().finite().min(0).max(1),
        relevanceScore: z.number().finite().nullable(),
        score: z.number().finite(),
      }),
    )
    .max(20),
  coverage: z
    .array(
      z.strictObject({
        source: retrievalSourceSchema,
        sourceStamp: z.string().regex(/^[a-f0-9]{64}$/),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string().max(500),
        reused: z.boolean(),
        coverage: retrievalCoverageSchema,
      }),
    )
    .max(20),
  notice: z.string().max(2000),
});
export type RetrievalResult = z.infer<typeof retrievalResultSchema>;
export interface SemanticEmbeddingPort {
  readonly modelRevision: string;
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    kind: 'query' | 'passage',
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; tokenTruncated: boolean[] }>;
  rerank?(
    query: string,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    modelRevision: string;
    scores: number[];
    tokenTruncated: boolean[];
  }>;
}
