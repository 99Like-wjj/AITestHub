import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentMemoryGapSchema } from '../../../contracts/src/agent-memory.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';

const availability = z.enum(['available', 'restoredNeedsReview']);
export const agentMemoryControlSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.agent-memory-control.v1'),
    heads: z
      .array(
        z.strictObject({
          ownerId: z.uuid(),
          enabled: z.boolean(),
          rowVersion: z.number().int().min(0),
          entries: z
            .array(
              z.strictObject({
                id: z.uuid(),
                rowVersion: z.number().int().positive(),
                contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
                enabled: z.boolean(),
                availability,
              }),
            )
            .max(20),
          gaps: z.array(agentMemoryGapSchema).max(20),
        }),
      )
      .max(100000),
  })
  .superRefine((state, ctx) => {
    const owners = new Set<string>(),
      ids = new Set<string>();
    for (const [index, head] of state.heads.entries()) {
      if (
        owners.has(head.ownerId) ||
        head.entries.length + head.gaps.length > 20
      )
        ctx.addIssue({
          code: 'custom',
          path: ['heads', index],
          message: 'Memory control membership is inconsistent.',
        });
      owners.add(head.ownerId);
      for (const entry of [...head.entries, ...head.gaps]) {
        if (ids.has(entry.id))
          ctx.addIssue({
            code: 'custom',
            path: ['heads', index],
            message: 'Memory identity is duplicated.',
          });
        ids.add(entry.id);
      }
    }
  });
export type AgentMemoryControl = z.infer<typeof agentMemoryControlSchema>;
export const memoryContentDigest = (title: string, content: string) =>
  createHash('sha256').update(canonicalJson({ title, content })).digest('hex');

async function availabilityInstalled(tx: SqlExecutor) {
  return (
    (
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('app.agent_memory_heads') IS NOT NULL AND to_regclass('app.agent_memories') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('app.agent_memories') AND attname='availability' AND NOT attisdropped) AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('app.agent_memory_heads') AND attname='restore_gaps' AND NOT attisdropped) present",
      )
    ).rows[0]?.present ?? false
  );
}
export async function captureAgentMemoryControl(
  tx: SqlExecutor,
): Promise<AgentMemoryControl | undefined> {
  if (!(await availabilityInstalled(tx))) return undefined;
  const heads = (
    await tx.query<{
      owner_id: string;
      enabled: boolean;
      row_version: number;
      restore_gaps: unknown;
    }>(
      'SELECT owner_id,enabled,row_version,restore_gaps FROM app.agent_memory_heads ORDER BY owner_id',
    )
  ).rows;
  const entries = (
    await tx.query<{
      id: string;
      owner_id: string;
      title: string;
      content: string;
      enabled: boolean;
      availability: unknown;
      row_version: number;
    }>(
      'SELECT id,owner_id,title,content,enabled,availability,row_version FROM app.agent_memories ORDER BY owner_id,id',
    )
  ).rows;
  const ownerIds = new Set(heads.map((head) => head.owner_id));
  if (entries.some((entry) => !ownerIds.has(entry.owner_id)))
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '个人记忆控制缺少所属状态，未签署不完整元数据。',
      503,
    );
  return agentMemoryControlSchema.parse({
    schemaVersion: 'ath.agent-memory-control.v1',
    heads: heads.map((head) => ({
      ownerId: head.owner_id,
      enabled: head.enabled,
      rowVersion: head.row_version,
      gaps: z.array(agentMemoryGapSchema).parse(head.restore_gaps),
      entries: entries
        .filter((entry) => entry.owner_id === head.owner_id)
        .map((entry) => ({
          id: entry.id,
          rowVersion: entry.row_version,
          contentDigest: memoryContentDigest(entry.title, entry.content),
          enabled: entry.enabled,
          availability: entry.availability,
        })),
    })),
  });
}

/** No saved body is inferred from a digest. Missing/older bodies remain explicit gaps/review items. */
export async function reapplyAgentMemoryControl(
  tx: SqlExecutor,
  raw: AgentMemoryControl | undefined,
) {
  const hasMemory = (
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('app.agent_memory_heads') IS NOT NULL AND to_regclass('app.agent_memories') IS NOT NULL present",
    )
  ).rows[0]?.present;
  if (!hasMemory) {
    if (raw !== undefined)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '恢复目标缺少当前记忆结构，不能忽略已签署的失效控制。',
        503,
      );
    return { available: false, deleted: 0, needsReview: 0, gaps: 0 };
  }
  if (!(await availabilityInstalled(tx)))
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      '恢复个人记忆须先安装45可用性结构，未开放旧正文。',
      503,
    );
  const control =
    raw === undefined ? undefined : agentMemoryControlSchema.parse(raw);
  const heads = (
    await tx.query<{
      owner_id: string;
      enabled: boolean;
      row_version: number;
      restore_gaps: unknown;
    }>(
      'SELECT owner_id,enabled,row_version,restore_gaps FROM app.agent_memory_heads ORDER BY owner_id FOR UPDATE',
    )
  ).rows;
  const entries = (
    await tx.query<{
      id: string;
      owner_id: string;
      title: string;
      content: string;
      enabled: boolean;
      row_version: number;
    }>(
      'SELECT id,owner_id,title,content,enabled,row_version FROM app.agent_memories ORDER BY owner_id,id FOR UPDATE',
    )
  ).rows;
  const owners = [
    ...new Set([
      ...heads.map((head) => head.owner_id),
      ...entries.map((entry) => entry.owner_id),
      ...(control?.heads.map((head) => head.ownerId) ?? []),
    ]),
  ].sort();
  let deleted = 0,
    needsReview = 0,
    gapsCount = 0;
  for (const ownerId of owners) {
    const existing = heads.find((head) => head.owner_id === ownerId),
      latest = control?.heads.find((head) => head.ownerId === ownerId),
      owned = entries.filter((entry) => entry.owner_id === ownerId);
    const targetIds = latest
      ? new Set([...latest.entries, ...latest.gaps].map((entry) => entry.id))
      : undefined;
    const retained = new Set<string>();
    for (const entry of owned) {
      if (targetIds && !targetIds.has(entry.id)) {
        await tx.query(
          'DELETE FROM app.agent_memories WHERE id=$1 AND owner_id=$2',
          [entry.id, ownerId],
        );
        deleted++;
        continue;
      }
      const meta = latest?.entries.find((item) => item.id === entry.id),
        gap = latest?.gaps.find((item) => item.id === entry.id);
      const valid =
        meta?.rowVersion === entry.row_version &&
        meta.contentDigest ===
          memoryContentDigest(entry.title, entry.content) &&
        meta.availability === 'available';
      const state = valid ? 'available' : 'restoredNeedsReview';
      if (!valid) needsReview++;
      await tx.query(
        'UPDATE app.agent_memories SET enabled=$3,availability=$4,row_version=$5 WHERE id=$1 AND owner_id=$2',
        [
          entry.id,
          ownerId,
          meta?.enabled ?? false,
          state,
          Math.max(entry.row_version, meta?.rowVersion ?? gap?.rowVersion ?? 0),
        ],
      );
      retained.add(entry.id);
    }
    const gaps = latest
      ? [...latest.entries, ...latest.gaps]
          .filter((item) => !retained.has(item.id))
          .map((item) => ({
            id: item.id,
            rowVersion: item.rowVersion,
            reason: 'notInBackup' as const,
          }))
      : z.array(agentMemoryGapSchema).parse(existing?.restore_gaps ?? []);
    gapsCount += gaps.length;
    await tx.query(
      'INSERT INTO app.agent_memory_heads(owner_id,enabled,row_version,restore_gaps) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id) DO UPDATE SET enabled=EXCLUDED.enabled,row_version=EXCLUDED.row_version,restore_gaps=EXCLUDED.restore_gaps',
      [
        ownerId,
        latest?.enabled ?? false,
        Math.max(existing?.row_version ?? 0, latest?.rowVersion ?? 0) + 1,
        JSON.stringify(gaps),
      ],
    );
  }
  return { available: true, deleted, needsReview, gaps: gapsCount };
}
