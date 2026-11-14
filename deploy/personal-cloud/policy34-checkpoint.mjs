// Trusted cloud operator adapter for the existing explicit CAS checkpoint port.
// No database bootstrap, migration, provider request, or generic checkpoint.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fixed34 = {
  version: '0034_resource_policy.sql',
  checksum: 'ac84e64462bea989f009667aeca8b61fc1c973b7ab40f9775e4e279f51d29ea0',
};
const rejected = () =>
  Object.assign(new Error('Bound cloud34 checkpoint rejected.'), {
    code: 'CLOUD34_CHECKPOINT_REJECTED',
  });

export async function checkpointCloudPolicy34({
  db,
  controls,
  permit,
  permitSignature,
  expectedPlatformId,
  canonicalJson,
  explicitCloud34,
}) {
  if (
    explicitCloud34 !== true ||
    permit.schemaVersion !==
      'ath.personal-cloud-resource-policy-upgrade-permit.v1' ||
    permit.platformId !== expectedPlatformId ||
    !/^[a-f0-9]{64}$/.test(permitSignature ?? '') ||
    !permit.target
  )
    throw rejected();
  const migrations = (
    await db.query(
      'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
    )
  ).rows;
  assert.equal(migrations.length, 34);
  assert.deepEqual(migrations.at(-1), fixed34);
  assert.ok(
    migrations.every(
      (row, index) => Number(row.version.slice(0, 4)) === index + 1,
    ),
  );
  assert.deepEqual(migrations[32], permit.previousMigration);
  const proof = {
    schemaVersion: 'ath.personal-cloud34-checkpoint.v1',
    permitId: permit.id,
    permitSignature,
    platformId: permit.platformId,
    sourceHead: permit.sourceHead,
    target: permit.target,
    targetMigrations: migrations,
  };
  const proofDigest = sha(canonicalJson(proof)),
    action = 'recovery.model-upgrade-checkpoint:' + proofDigest;
  const current = async () => {
    const latest = await controls.latest(),
      head = latest.head.committed;
    const row = (
      await db.query(
        'SELECT platform_id,control_sequence::text,state_digest FROM app.recovery_control_state WHERE singleton',
      )
    ).rows[0];
    if (
      !head ||
      latest.head.pending ||
      latest.head.platformId !== expectedPlatformId ||
      row?.platform_id !== expectedPlatformId ||
      row.control_sequence !== String(head.sequence) ||
      row.state_digest !== head.stateDigest
    )
      throw rejected();
    return latest;
  };
  let latest = await current();
  if (latest.head.committed.id !== permit.sourceHead.id) {
    const recorded = (
      await db.query(
        `SELECT EXISTS(SELECT 1 FROM app.recovery_control_commits WHERE id=$1 AND platform_id=$2 AND sequence=$3 AND state_digest=$4 AND changes @> $5::jsonb) ready`,
        [
          latest.head.committed.id,
          expectedPlatformId,
          latest.head.committed.sequence,
          latest.head.committed.stateDigest,
          JSON.stringify([
            { action, objectId: permit.sourceHead.id, projectId: null },
          ]),
        ],
      )
    ).rows[0]?.ready;
    if (
      !recorded ||
      canonicalJson(latest.state.migrations) !== canonicalJson(migrations)
    )
      throw rejected();
    return {
      written: false,
      stage: 'personal-cloud-policy34',
      sourceProofDigest: proofDigest,
      controlSequence: latest.head.committed.sequence,
      stateDigest: latest.head.committed.stateDigest,
    };
  }
  if (
    canonicalJson(latest.head.committed) !== canonicalJson(permit.sourceHead) ||
    canonicalJson(latest.state.migrations) !==
      canonicalJson(migrations.slice(0, 33))
  )
    throw rejected();
  await controls.initialize();
  await controls.checkpoint({
    platformId: expectedPlatformId,
    sourceHeadId: permit.sourceHead.id,
    sequence: permit.sourceHead.sequence,
    stateDigest: permit.sourceHead.stateDigest,
    sourceProofDigest: proofDigest,
    targetMigrationsDigest: sha(
      JSON.stringify(migrations.map((row) => [row.version, row.checksum])),
    ),
  });
  latest = await current();
  if (canonicalJson(latest.state.migrations) !== canonicalJson(migrations))
    throw rejected();
  return {
    written: true,
    stage: 'personal-cloud-policy34',
    sourceProofDigest: proofDigest,
    controlSequence: latest.head.committed.sequence,
    stateDigest: latest.head.committed.stateDigest,
  };
}
