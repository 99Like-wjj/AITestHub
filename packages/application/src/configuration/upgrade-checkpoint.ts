import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Database } from '../../../persistence/src/database.js';
import type { ControlJournal } from '../recovery/control-journal.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { assertModelProtocolCheckpoint } from './model-checkpoint.js';

export const MODEL_UPGRADE_CHECKPOINT_MIGRATIONS = {
  '0035_model_protocols.sql':
    '5fc2e12fdc21930ae7b4afe4ba4aabcc61e208976c2506daec841e9882ea534b',
  '0036_account_removal.sql':
    '4bda3515a66053d43f20331626e96efa0ffcddbadda2efd9ab5635ced5d84c3e',
} as const;
const migration = z.strictObject({
  version: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const modelUpgradeBeforeProofSchema = z.strictObject({
  schemaVersion: z.literal('ath.model-upgrade-checkpoint-before.v1'),
  platformId: z.uuid(),
  sourceHead: z.strictObject({
    id: z.uuid(),
    sequence: z.number().int().positive(),
    stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  migrations: z.array(migration).length(34),
  upgrades: z.strictObject({
    '0035_model_protocols.sql': z.literal(
      MODEL_UPGRADE_CHECKPOINT_MIGRATIONS['0035_model_protocols.sql'],
    ),
    '0036_account_removal.sql': z.literal(
      MODEL_UPGRADE_CHECKPOINT_MIGRATIONS['0036_account_removal.sql'],
    ),
  }),
});
export type ModelUpgradeBeforeProof = z.infer<
  typeof modelUpgradeBeforeProofSchema
>;
const blocked = () =>
  new DomainError(
    'DEPENDENCY_UNAVAILABLE',
    '模型升级checkpoint前置/固定摘要/原水位不匹配，未推进控制。',
    503,
  );
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
async function databaseHead(db: Database) {
  return (
    await db.query<{
      platform_id: string;
      control_sequence: string;
      state_digest: string | null;
    }>(
      'SELECT platform_id,control_sequence::text,state_digest FROM app.recovery_control_state WHERE singleton',
    )
  ).rows[0];
}
async function dbMigrations(db: Database) {
  return (
    await db.query<{ version: string; checksum: string }>(
      'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
    )
  ).rows;
}
function old34(rows: { version: string; checksum: string }[]) {
  return (
    rows.length === 34 &&
    rows.every((row, index) => Number(row.version.slice(0, 4)) === index + 1)
  );
}
async function assertFiles(
  rows: { version: string; checksum: string }[],
  directory: string,
  allowPending = false,
) {
  for (const row of rows) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, row.version));
    } catch {
      if (
        !allowPending ||
        !(row.version in MODEL_UPGRADE_CHECKPOINT_MIGRATIONS)
      )
        throw blocked();
      try {
        bytes = await readFile(join(directory, row.version + '.pending'));
      } catch {
        throw blocked();
      }
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.checksum)
      throw blocked();
  }
}
async function current(
  db: Database,
  controls: ControlJournal,
  platformId: string,
) {
  const latest = await controls.latest(),
    row = await databaseHead(db),
    head = latest.head;
  if (
    !row ||
    head.pending ||
    !head.committed ||
    head.platformId !== platformId ||
    row.platform_id !== platformId ||
    BigInt(row.control_sequence) !== BigInt(head.committed.sequence) ||
    row.state_digest !== head.committed.stateDigest
  )
    throw blocked();
  return latest;
}
/** Metadata-only read. Never calls initialize/checkpoint or creates a new anchor. */
export async function captureModelUpgradeBeforeProof(
  db: Database,
  controls: ControlJournal,
  platformId: string,
  directory: string,
): Promise<ModelUpgradeBeforeProof> {
  const latest = await current(db, controls, platformId),
    rows = await dbMigrations(db);
  if (
    !old34(rows) ||
    canonicalJson(rows) !== canonicalJson(latest.state.migrations)
  )
    throw blocked();
  await assertFiles(rows, directory);
  await assertFiles(
    Object.entries(MODEL_UPGRADE_CHECKPOINT_MIGRATIONS).map(
      ([version, checksum]) => ({ version, checksum }),
    ),
    directory,
    true,
  );
  return modelUpgradeBeforeProofSchema.parse({
    schemaVersion: 'ath.model-upgrade-checkpoint-before.v1',
    platformId,
    sourceHead: {
      id: latest.head.committed!.id,
      sequence: latest.head.committed!.sequence,
      stateDigest: latest.head.committed!.stateDigest,
    },
    migrations: rows,
    upgrades: MODEL_UPGRADE_CHECKPOINT_MIGRATIONS,
  });
}
/** Explicit trusted operator only; no migration, work start, model credential resolve or bootstrap. */
export async function checkpointModelUpgrade(
  db: Database,
  controls: ControlJournal,
  raw: unknown,
  directory: string,
  authorization: { explicit: true },
) {
  if (authorization?.explicit !== true) throw blocked();
  const proof = modelUpgradeBeforeProofSchema.parse(raw);
  if (!old34(proof.migrations)) throw blocked();
  const rows = await dbMigrations(db),
    latest = await current(db, controls, proof.platformId),
    proofDigest = digest(proof);
  if (
    rows.length !== 36 ||
    canonicalJson(rows.slice(0, 34)) !== canonicalJson(proof.migrations)
  )
    throw blocked();
  for (const [version, checksum] of Object.entries(
    MODEL_UPGRADE_CHECKPOINT_MIGRATIONS,
  ))
    if (
      !rows.some((row) => row.version === version && row.checksum === checksum)
    )
      throw blocked();
  await assertFiles(rows, directory, true);
  const action = `recovery.model-upgrade-checkpoint:${proofDigest}`;
  if (latest.head.committed!.id !== proof.sourceHead.id) {
    const recorded = (
      await db.query<{ ready: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM app.recovery_control_commits WHERE id=$1 AND platform_id=$2 AND sequence=$3 AND state_digest=$4 AND changes @> $5::jsonb) ready`,
        [
          latest.head.committed!.id,
          proof.platformId,
          latest.head.committed!.sequence,
          latest.head.committed!.stateDigest,
          JSON.stringify([
            { action, objectId: proof.sourceHead.id, projectId: null },
          ]),
        ],
      )
    ).rows[0]?.ready;
    if (
      !recorded ||
      canonicalJson(latest.state.migrations) !== canonicalJson(rows)
    )
      throw blocked();
    await controls.initialize();
    if (
      (await current(db, controls, proof.platformId)).head.committed!.id !==
      latest.head.committed!.id
    )
      throw blocked();
    const status = await assertModelProtocolCheckpoint(db, controls);
    return {
      written: false as const,
      platformId: proof.platformId,
      sourceProofDigest: proofDigest,
      ...status,
    };
  }
  if (
    latest.head.committed!.sequence !== proof.sourceHead.sequence ||
    latest.head.committed!.stateDigest !== proof.sourceHead.stateDigest ||
    canonicalJson(latest.state.migrations) !== canonicalJson(proof.migrations)
  )
    throw blocked();
  // Existing, authenticated positive-sequence head was checked above. initialize can
  // only attach its observer here; missing/replaced control cannot become a bootstrap.
  await controls.initialize();
  await controls.checkpoint({
    platformId: proof.platformId,
    sourceHeadId: proof.sourceHead.id,
    sequence: proof.sourceHead.sequence,
    stateDigest: proof.sourceHead.stateDigest,
    sourceProofDigest: proofDigest,
    targetMigrationsDigest: createHash('sha256')
      .update(JSON.stringify(rows.map((row) => [row.version, row.checksum])))
      .digest('hex'),
  });
  const after = await current(db, controls, proof.platformId);
  if (canonicalJson(after.state.migrations) !== canonicalJson(rows))
    throw blocked();
  const status = await assertModelProtocolCheckpoint(db, controls);
  return {
    written: true as const,
    platformId: proof.platformId,
    sourceProofDigest: proofDigest,
    ...status,
  };
}
