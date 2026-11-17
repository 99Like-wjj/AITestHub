import { createHash } from 'node:crypto';
import type { RetrievalChunk } from '../../../contracts/src/agent-retrieval.js';

export const retrievalDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Each citation stays in its original source block; no synthetic joins between files. */
export function sourceChunks(
  blocks: readonly { location: string; text: string }[],
  maximum = 256,
) {
  const chunks: RetrievalChunk[] = [];
  let incomplete = false;
  for (const block of blocks) {
    const points = Array.from(block.text);
    for (let start = 0; start < points.length; start += 300) {
      if (chunks.length >= maximum) {
        incomplete = true;
        break;
      }
      const text = points.slice(start, start + 350).join('');
      if (!text.trim()) continue;
      const location = `${block.location};characters:${start + 1}-${Math.min(start + 350, points.length)}`;
      chunks.push({ id: retrievalDigest({ location, text }), location, text });
      if (start + 350 >= points.length) break;
    }
    if (incomplete) break;
  }
  return { chunks, incomplete };
}
export function semanticCosine(
  left: readonly number[],
  right: readonly number[],
) {
  if (!left.length || left.length !== right.length)
    throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  let product = 0,
    a = 0,
    b = 0;
  for (let i = 0; i < left.length; i++) {
    const x = left[i],
      y = right[i];
    if (
      x === undefined ||
      y === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      throw new Error('EMBEDDING_INVALID');
    product += x * y;
    a += x * x;
    b += y * y;
  }
  if (!a || !b) throw new Error('EMBEDDING_ZERO_VECTOR');
  return Math.max(-1, Math.min(1, product / Math.sqrt(a * b)));
}
function terms(text: string) {
  const result = new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
  for (const word of [...result]) {
    const points = Array.from(word);
    if (/\p{Script=Han}/u.test(word)) {
      result.delete(word);
      for (let i = 0; i + 1 < points.length; i++)
        result.add(points.slice(i, i + 2).join(''));
    }
  }
  return result;
}
export function lexicalOverlap(query: string, text: string) {
  const a = terms(query),
    b = terms(text);
  return a.size ? [...a].filter((term) => b.has(term)).length / a.size : 0;
}
