import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SemanticEmbeddingPort } from '../../contracts/src/agent-retrieval.js';

export const e5ModelRevision =
  'multilingual-e5-small:761b726dd34fb83930e26aab4e9ac3899aa1fa78:int8';
export const rerankerModelRevision =
  'bge-reranker-base:280bcc27a84e0b898c251e06fddb25171bd9b101:int8';
const responseSchema = z.strictObject({
  modelRevision: z.literal(e5ModelRevision),
  vectors: z.array(z.array(z.number().finite()).length(384)).max(16),
  tokenTruncated: z.array(z.boolean()).max(16),
});

/** Trusted fixed local service. It has no model-supplied URL, path or credential. */
export class SemanticEmbeddingClient implements SemanticEmbeddingPort {
  readonly modelRevision = e5ModelRevision;
  readonly dimensions = 384;
  readonly #origin: string;
  readonly #token: string;
  constructor(origin: string, token: string) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      token.length < 32
    )
      throw new Error('AITESTHUB_EMBEDDING_CONFIG_INVALID');
    this.#origin = url.origin;
    this.#token = token;
  }
  async rerank(query: string, texts: readonly string[], signal?: AbortSignal) {
    z.string().min(1).max(1000).parse(query);
    z.array(z.string().max(2000)).max(32).parse(texts);
    const scores: number[] = [],
      tokenTruncated: boolean[] = [];
    for (let start = 0; start < texts.length; start += 16) {
      signal?.throwIfAborted();
      const batch = texts.slice(start, start + 16);
      const response = await fetch(`${this.#origin}/rerank`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(60_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, texts: batch }),
      });
      if (!response.ok || !response.body)
        throw new Error('RERANK_SERVICE_UNAVAILABLE');
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error('RERANK_RESPONSE_LIMIT');
        chunks.push(chunk);
      }
      const result = z
        .strictObject({
          modelRevision: z.literal(rerankerModelRevision),
          scores: z.array(z.number().finite()).max(16),
          tokenTruncated: z.array(z.boolean()).max(16),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (
        result.scores.length !== batch.length ||
        result.tokenTruncated.length !== batch.length
      )
        throw new Error('RERANK_RESPONSE_COUNT');
      scores.push(...result.scores);
      tokenTruncated.push(...result.tokenTruncated);
    }
    return { modelRevision: rerankerModelRevision, scores, tokenTruncated };
  }
  async embed(
    texts: readonly string[],
    kind: 'query' | 'passage',
    signal?: AbortSignal,
  ) {
    z.array(z.string().max(2000)).max(256).parse(texts);
    const vectors: number[][] = [],
      tokenTruncated: boolean[] = [];
    for (let start = 0; start < texts.length; start += 16) {
      signal?.throwIfAborted();
      const batch = texts.slice(start, start + 16);
      const response = await fetch(`${this.#origin}/embed`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(60_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ texts: batch, kind }),
      });
      if (!response.ok || !response.body)
        throw new Error('EMBEDDING_SERVICE_UNAVAILABLE');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) throw new Error('EMBEDDING_RESPONSE_LIMIT');
        chunks.push(chunk);
      }
      const result = responseSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (
        result.vectors.length !== batch.length ||
        result.tokenTruncated.length !== batch.length
      )
        throw new Error('EMBEDDING_RESPONSE_COUNT');
      vectors.push(...result.vectors);
      tokenTruncated.push(...result.tokenTruncated);
    }
    return { vectors, tokenTruncated };
  }
}

export async function createSemanticEmbeddingFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SemanticEmbeddingClient | undefined> {
  const origin = environment.AITESTHUB_EMBEDDING_ORIGIN,
    file = environment.AITESTHUB_EMBEDDING_TOKEN_FILE;
  if (!origin && !file) return undefined;
  if (!origin || !file)
    throw new Error('AITESTHUB_EMBEDDING_ORIGIN_AND_TOKEN_FILE_REQUIRED');
  let token: string;
  try {
    token = (await readFile(file, 'utf8')).trim();
  } catch {
    throw new Error('AITESTHUB_EMBEDDING_TOKEN_FILE_UNAVAILABLE');
  }
  return new SemanticEmbeddingClient(origin, token);
}
