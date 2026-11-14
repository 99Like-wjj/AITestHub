// Versioned trusted operator for the one existing personal-cloud deployment.
// No application startup hook, migration execution, model call or local CLI change.
import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudPolicyUpgradeFence } from './resource-policy-upgrade-fence.mjs';
import { checkpointCloudPolicy34 } from './policy34-checkpoint.mjs';

import {
  readDeploymentProfile,
  validateDeploymentProfile,
  deploymentPaths,
} from './deployment-profile.mjs';

const digest = /^[a-f0-9]{64}$/,
  uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rejected = () =>
  Object.assign(
    new Error('Explicit fixed personal-cloud upgrade context required.'),
    { code: 'EXPLICIT_PERSONAL_CLOUD_UPGRADE_REQUIRED' },
  );
export function cloudMetadataSignature(key, domain, value, canonicalJson) {
  assert.equal(key.length, 32);
  assert.ok(
    [
      'ath.personal-cloud-resource-policy-upgrade-permit.v1',
      'ath.personal-cloud35-proof-binding.v1',
    ].includes(domain),
  );
  return createHmac('sha256', key)
    .update(domain + '\0')
    .update(canonicalJson(value))
    .digest('hex');
}
export function verifyCloudProofBindingObject(
  binding,
  expectedValue,
  key,
  canonicalJson,
) {
  assert.deepEqual(binding.value, expectedValue);
  assert.match(binding.signature, digest);
  assert.ok(
    timingSafeEqual(
      Buffer.from(binding.signature, 'hex'),
      Buffer.from(
        cloudMetadataSignature(
          key,
          'ath.personal-cloud35-proof-binding.v1',
          binding.value,
          canonicalJson,
        ),
        'hex',
      ),
    ),
  );
}
/** Pure guard, always called before filesystem, DB, private credentials or imports. */
export function parseCloudUpgradeArguments(
  args,
  environment = process.env,
  platform = process.platform,
  profile,
) {
  let cloudUpgradeProfile;
  try {
    cloudUpgradeProfile = validateDeploymentProfile(profile);
  } catch {
    throw rejected();
  }
  const privatePaths = deploymentPaths(cloudUpgradeProfile);
  if (
    platform !== 'linux' ||
    environment.AITESTHUB_PERSONAL_CLOUD_UPGRADE !== 'explicit-cloud33-to36' ||
    environment.AITESTHUB_LOCAL_ROOT !== cloudUpgradeProfile.root ||
    environment.DB_HOST !== '127.0.0.1' ||
    environment.DB_PORT !== '55432' ||
    environment.DB_NAME !== 'aitesthub' ||
    environment.DB_USER !== 'aitesthub_app' ||
    environment.AITESTHUB_PUBLIC_ORIGIN !== cloudUpgradeProfile.origin ||
    environment.AITESTHUB_CLOUD_SSH_HOST !== cloudUpgradeProfile.host ||
    environment.AITESTHUB_CLOUD_SSH_HOST_KEY_SHA256 !==
      cloudUpgradeProfile.hostKeyFingerprint
  )
    throw rejected();
  for (const [key, expected] of Object.entries(privatePaths))
    if (environment[key] !== undefined && environment[key] !== expected)
      throw rejected();
  const input = new Map();
  for (const arg of args) {
    if (arg === '--explicit-personal-cloud-deployment') {
      if (input.has('explicit')) throw rejected();
      input.set('explicit', 'true');
      continue;
    }
    const match =
      /^--(mode|platform-id|image-id|runtime|build-manifest|build-manifest-sha256|backup-id|permit-id|proof)=(.+)$/.exec(
        arg,
      );
    if (!match || input.has(match[1])) throw rejected();
    input.set(match[1], match[2]);
  }
  const mode = input.get('mode'),
    imageId = input.get('image-id'),
    runtime = input.get('runtime');
  if (
    input.get('explicit') !== 'true' ||
    input.get('platform-id') !== cloudUpgradeProfile.platformId ||
    !['prepare34', 'initialize34', 'before35', 'execute36', 'status'].includes(
      mode,
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') ||
    !digest.test(input.get('build-manifest-sha256') ?? '')
  )
    throw rejected();
  const expectedRuntime =
    cloudUpgradeProfile.releaseRoot + '/36-' + imageId.slice(7, 19) + '/app';
  if (
    runtime !== expectedRuntime ||
    input.get('build-manifest') !==
      dirname(expectedRuntime) + '/build-proof.json'
  )
    throw rejected();
  const extras =
    mode === 'prepare34'
      ? ['backup-id']
      : mode === 'initialize34'
        ? ['permit-id']
        : ['before35', 'execute36'].includes(mode)
          ? ['permit-id', 'proof']
          : [];
  if (input.size !== 7 + extras.length) throw rejected();
  for (const extra of extras) {
    if (extra === 'proof') {
      const proof = input.get('proof') ?? '';
      const within = posix.relative(
        posix.join(cloudUpgradeProfile.root, 'setup/model-upgrade'),
        proof,
      );
      if (
        !posix.isAbsolute(proof) ||
        posix.normalize(proof) !== proof ||
        !/^before-[a-f0-9-]{36}\.json$/.test(within) ||
        !uuid.test(within.slice(7, -5))
      )
        throw rejected();
    } else if (!uuid.test(input.get(extra) ?? '')) throw rejected();
  }
  return Object.freeze({
    mode,
    imageId,
    runtime,
    buildManifest: input.get('build-manifest'),
    buildManifestSha256: input.get('build-manifest-sha256'),
    backupId: input.get('backup-id'),
    permitId: input.get('permit-id'),
    proof: input.get('proof'),
  });
}

export function createCloudUpgradeOperator(profile, profileSha256) {
  const cloudUpgradeProfile = validateDeploymentProfile(profile);
  if (!digest.test(profileSha256 ?? '')) throw rejected();
  const privatePaths = deploymentPaths(cloudUpgradeProfile);
  async function regular(path, kind = 'file') {
    const item = await lstat(path);
    if (
      item.isSymbolicLink() ||
      (kind === 'file' ? !item.isFile() : !item.isDirectory())
    )
      throw rejected();
    return item;
  }
  async function absent(path) {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  async function exclusiveJson(path, value, canonical) {
    await regular(dirname(path), 'directory');
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(canonical(value) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function privateDirectory(path) {
    const within = relative(cloudUpgradeProfile.root, path);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw rejected();
    let current = cloudUpgradeProfile.root;
    await regular(current, 'directory');
    for (const segment of within.split('/')) {
      current = join(current, segment);
      if (await absent(current)) await mkdir(current, { mode: 0o700 });
      await regular(current, 'directory');
    }
  }
  async function permitSignature(permit, canonicalJson) {
    const key = (
      await readFile(privatePaths.AITESTHUB_RECOVERY_CONTROL_KEY_FILE, 'utf8')
    ).trim();
    assert.match(key, digest);
    return cloudMetadataSignature(
      Buffer.from(key, 'hex'),
      'ath.personal-cloud-resource-policy-upgrade-permit.v1',
      permit,
      canonicalJson,
    );
  }
  const targetIdentity = (input) => ({
    imageId: input.imageId,
    runtime: input.runtime,
    buildManifestSha256: input.buildManifestSha256,
    deploymentProfileSha256: profileSha256,
  });
  async function readPermit(permitId, canonicalJson, input) {
    const file = join(
        cloudUpgradeProfile.root,
        'setup',
        'cloud-resource-policy-upgrade',
        permitId + '.json',
      ),
      item = await regular(file);
    assert.ok(item.size < 65536);
    const bytes = await readFile(file),
      stored = JSON.parse(bytes);
    assert.equal(bytes.toString(), canonicalJson(stored) + '\n');
    assert.equal(
      stored.permit.schemaVersion,
      'ath.personal-cloud-resource-policy-upgrade-permit.v1',
    );
    assert.equal(stored.permit.id, permitId);
    assert.equal(stored.permit.platformId, cloudUpgradeProfile.platformId);
    assert.deepEqual(
      stored.permit.previousMigration,
      cloudUpgradeProfile.previousMigration,
    );
    assert.equal(
      stored.permit.migrationChecksum,
      cloudUpgradeProfile.policyMigration.checksum,
    );
    assert.deepEqual(stored.permit.target, targetIdentity(input));
    assert.match(stored.signature, digest);
    assert.ok(
      timingSafeEqual(
        Buffer.from(stored.signature, 'hex'),
        Buffer.from(await permitSignature(stored.permit, canonicalJson), 'hex'),
      ),
    );
    return stored;
  }
  async function proofBindingSignature(value, canonicalJson) {
    const key = (
      await readFile(privatePaths.AITESTHUB_RECOVERY_CONTROL_KEY_FILE, 'utf8')
    ).trim();
    assert.match(key, digest);
    return cloudMetadataSignature(
      Buffer.from(key, 'hex'),
      'ath.personal-cloud35-proof-binding.v1',
      value,
      canonicalJson,
    );
  }
  async function proofBinding(
    input,
    stored,
    proofBytes,
    canonicalJson,
    create = false,
  ) {
    const path = input.proof + '.cloud-bind.json',
      value = {
        schemaVersion: 'ath.personal-cloud35-proof-binding.v1',
        platformId: cloudUpgradeProfile.platformId,
        permitId: input.permitId,
        permitSignature: stored.signature,
        target: targetIdentity(input),
        proofSha256: sha(proofBytes),
      };
    if (create && (await absent(path)))
      await exclusiveJson(
        path,
        { value, signature: await proofBindingSignature(value, canonicalJson) },
        canonicalJson,
      );
    const item = await regular(path);
    assert.ok(item.size <= 16384);
    const bytes = await readFile(path),
      binding = JSON.parse(bytes);
    assert.equal(bytes.toString(), canonicalJson(binding) + '\n');
    const key = (
      await readFile(privatePaths.AITESTHUB_RECOVERY_CONTROL_KEY_FILE, 'utf8')
    ).trim();
    assert.match(key, digest);
    verifyCloudProofBindingObject(
      binding,
      value,
      Buffer.from(key, 'hex'),
      canonicalJson,
    );
  }
  function sameLegacyModels(actual, original) {
    assert.equal(actual.length, original.length);
    for (const before of original) {
      const after = actual.find((row) => row.id === before.id);
      assert.ok(after);
      for (const field of [
        'metadata_digest',
        'history_digest',
        'history_rows',
        'grants_digest',
        'exact_legacy_revision',
      ])
        assert.deepEqual(after[field], before[field]);
    }
  }
  async function verifyRuntime(input) {
    assert.equal(await realpath(input.runtime), input.runtime);
    await regular(input.runtime, 'directory');
    await regular(input.buildManifest);
    const bytes = await readFile(input.buildManifest);
    assert.equal(sha(bytes), input.buildManifestSha256);
    const proof = JSON.parse(bytes);
    assert.equal(proof.schemaVersion, 'ath.cloud-runtime-build.v1');
    assert.equal(proof.imageId, input.imageId);
    assert.equal(proof.nodeSha256, sha(await readFile(process.execPath)));
    const expected = new Set(Object.keys(proof.files ?? {}));
    // The approved final Docker stage carries package.json and installed modules;
    // its lockfile belongs to the build provenance, not the exported runtime.
    assert.ok(expected.has('package.json'));
    async function walk(directory, prefix) {
      for (const name of await readdir(directory)) {
        const path = join(directory, name),
          key = prefix + name,
          item = await lstat(path);
        assert.ok(!item.isSymbolicLink());
        if (item.isDirectory()) await walk(path, key + '/');
        else if (name.endsWith('.js'))
          assert.ok(expected.has(key), 'UNRECORDED_RUNTIME_JAVASCRIPT');
      }
    }
    await walk(join(input.runtime, 'dist'), 'dist/');
    for (const [path, checksum] of Object.entries(proof.files)) {
      assert.match(
        path,
        /^(?:dist\/[a-zA-Z0-9_./-]+\.js|packages\/persistence\/migrations\/\d{4}_[a-z0-9_]+\.sql|package\.json|pnpm-lock\.yaml)$/,
      );
      assert.ok(!path.split('/').includes('..'));
      assert.match(checksum, digest);
      await regular(join(input.runtime, path));
      assert.equal(sha(await readFile(join(input.runtime, path))), checksum);
    }
    for (let version = 1; version <= 36; version++)
      assert.equal(
        [...expected].filter((path) =>
          path.startsWith(
            'packages/persistence/migrations/' +
              String(version).padStart(4, '0') +
              '_',
          ),
        ).length,
        1,
      );
    return proof;
  }
  // Keep the existing SSH operator's sudo -n Docker route; do not change groups
  // or expose the Docker socket to application containers for an upgrade check.
  const docker = (args) =>
    execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/docker', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
  async function requireStopped(input) {
    assert.equal(
      docker(['image', 'inspect', input.imageId, '--format', '{{.Id}}']),
      input.imageId,
    );
    for (const name of [
      cloudUpgradeProfile.containers.api,
      cloudUpgradeProfile.containers.apiWorker,
      cloudUpgradeProfile.containers.aiWorker,
    ]) {
      const row = JSON.parse(docker(['inspect', name]))[0];
      assert.equal(row.State.Running, false);
      assert.ok(
        [cloudUpgradeProfile.oldImage, input.imageId].includes(row.Image),
      );
    }
    assert.equal(
      execFileSync(
        '/usr/bin/systemctl',
        [
          'show',
          cloudUpgradeProfile.opsUnit,
          '--property=ActiveState',
          '--value',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim(),
      'inactive',
    );
  }
  async function readonlyState(db, input) {
    return db.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      assert.deepEqual(
        (
          await tx.query(
            "SELECT current_database() database,current_user role,current_setting('transaction_read_only') readonly",
          )
        ).rows[0],
        { database: 'aitesthub', role: 'aitesthub_app', readonly: 'on' },
      );
      const control = (
        await tx.query(
          'SELECT platform_id,control_sequence::text,state_digest FROM app.recovery_control_state WHERE singleton',
        )
      ).rows[0];
      assert.equal(control.platform_id, cloudUpgradeProfile.platformId);
      const migrations = (
        await tx.query(
          'SELECT version,checksum FROM app.schema_migrations ORDER BY version',
        )
      ).rows;
      const count =
        input.mode === 'prepare34'
          ? 33
          : input.mode === 'execute36'
            ? 36
            : input.mode === 'status'
              ? migrations.length
              : 34;
      assert.equal(migrations.length, count);
      assert.ok([33, 34, 36].includes(count));
      for (const [index, row] of migrations.entries()) {
        assert.equal(Number(row.version.slice(0, 4)), index + 1);
        assert.equal(
          sha(
            await readFile(
              join(
                input.runtime,
                'packages/persistence/migrations',
                row.version,
              ),
            ),
          ),
          row.checksum,
        );
      }
      const maintenance = (
        await tx.query(
          'SELECT phase,operation_id FROM app.maintenance_state WHERE singleton',
        )
      ).rows[0];
      if (input.mode !== 'status') {
        assert.equal(maintenance.phase, 'snapshot');
        assert.match(maintenance.operation_id, uuid);
        const active = (
          await tx.query(`SELECT
        (SELECT count(*) FROM app.ai_tasks WHERE state IN ('accepted','running','cancelling'))::int ai,
        (SELECT count(*) FROM app.auxiliary_tasks WHERE state IN ('accepted','running','cancelling'))::int auxiliary,
        (SELECT count(*) FROM app.api_execution_requests WHERE state='queued')::int api,
        (SELECT count(*) FROM app.runs WHERE kind='API' AND state IN ('prepared','running','stopping'))::int runs,
        (SELECT count(*) FROM app.api_worker_grants WHERE revoked_at IS NULL AND expires_at>clock_timestamp())::int grants,
        (SELECT count(*) FROM app.api_schedules WHERE status='active')::int schedules,
        (SELECT count(*) FROM app.file_resources WHERE status='uploading' AND upload_expires_at>clock_timestamp())::int uploads,
        (SELECT count(*) FROM app.operations_request_leases WHERE expires_at>clock_timestamp())::int requests`)
        ).rows[0];
        assert.ok(Object.values(active).every((value) => Number(value) === 0));
      }
      assert.deepEqual(
        (
          await tx.query('SELECT id FROM app.model_services ORDER BY id')
        ).rows.map((row) => row.id),
        cloudUpgradeProfile.legacyModels.map((row) => row.id).sort(),
      );
      const models = [];
      for (const expected of cloudUpgradeProfile.legacyModels) {
        const row = (
          await tx.query(
            `SELECT m.id,m.config_revision,m.row_version,
        encode(sha256(convert_to((to_jsonb(m)-ARRAY['config_revision','row_version','note','protocol','auth_scheme','removed_at','removed_by'])::text,'UTF8')),'hex') metadata_digest,
        (SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY revision),'[]'::jsonb)::text,'UTF8')),'hex') FROM app.model_service_revisions r WHERE r.model_service_id=m.id AND revision<=$2) history_digest,
        (SELECT count(*)::int FROM app.model_service_revisions r WHERE r.model_service_id=m.id AND revision<=$2) history_rows,
        (SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(g) ORDER BY user_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM app.model_grants g WHERE g.model_service_id=m.id) grants_digest,
        EXISTS(SELECT 1 FROM app.model_service_revisions r WHERE r.model_service_id=m.id AND revision=$2 AND r.snapshot->>'modelId' IS NOT DISTINCT FROM m.model_id AND r.snapshot->>'provider' IS NOT DISTINCT FROM m.provider AND r.snapshot->>'baseUrl' IS NOT DISTINCT FROM m.base_url) exact_legacy_revision
        FROM app.model_services m WHERE m.id=$1`,
            [expected.id, expected.revision],
          )
        ).rows[0];
        assert.ok(row);
        assert.equal(row.exact_legacy_revision, true);
        assert.equal(row.history_rows, expected.revision);
        assert.equal(
          row.config_revision,
          expected.revision + (count === 36 ? 1 : 0),
        );
        assert.equal(
          row.row_version,
          expected.revision + (count === 36 ? 1 : 0),
        );
        if (count === 36) {
          assert.equal(
            (
              await tx.query(
                "SELECT protocol='chatCompletions' AND auth_scheme='bearer' AND note='' AND removed_at IS NULL AND removed_by IS NULL ready FROM app.model_services WHERE id=$1",
                [expected.id],
              )
            ).rows[0].ready,
            true,
          );
          assert.equal(
            (
              await tx.query(
                'SELECT count(*)::int n FROM app.model_legacy_bindings WHERE model_service_id=$1 AND legacy_revision=$2 AND upgraded_revision=$3',
                [expected.id, expected.revision, expected.revision + 1],
              )
            ).rows[0].n,
            1,
          );
        }
        models.push(row);
      }
      return { control, migrations, maintenance, models };
    });
  }

  async function runCloudUpgrade(
    args = process.argv.slice(2),
    environment = process.env,
  ) {
    const input = parseCloudUpgradeArguments(
      args,
      environment,
      process.platform,
      cloudUpgradeProfile,
    );
    await verifyRuntime(input);
    for (const [name, path] of Object.entries(privatePaths)) {
      if (
        [
          'AITESTHUB_RESOURCE_POLICY_ANCHOR_FILE',
          'AITESTHUB_RESOURCE_POLICY_LOCK_DIRECTORY',
        ].includes(name)
      )
        continue;
      await regular(
        path,
        [
          'AITESTHUB_RECOVERY_CONTROL_DIRECTORY',
          'AITESTHUB_BACKUP_DIRECTORY',
        ].includes(name)
          ? 'directory'
          : 'file',
      );
    }
    await regular(
      join(privatePaths.AITESTHUB_RECOVERY_CONTROL_DIRECTORY, 'head.json'),
    );
    const fixed = { ...environment, ...privatePaths };
    const imports = async (path) =>
      import(pathToFileURL(join(input.runtime, 'dist', path)).href);
    const [
      { createDatabaseFromEnvironment },
      { ControlJournal },
      { canonicalJson },
      {
        captureModelUpgradeBeforeProof,
        checkpointModelUpgrade,
        modelUpgradeBeforeProofSchema,
      },
      { IdentityService },
      { secretHash },
    ] = await Promise.all([
      imports('packages/persistence/src/config.js'),
      imports('packages/application/src/recovery/control-journal.js'),
      imports('packages/application/src/operations/service.js'),
      imports('packages/application/src/configuration/upgrade-checkpoint.js'),
      imports('packages/application/src/identity/service.js'),
      imports('packages/application/src/identity/password.js'),
    ]);
    const db = await createDatabaseFromEnvironment(fixed),
      evidence = {
        schemaVersion: 'ath.personal-cloud33-to36-operator.v1',
        id: randomUUID(),
        mode: input.mode,
        imageId: input.imageId,
        platformId: cloudUpgradeProfile.platformId,
        deploymentProfileSha256: profileSha256,
        startedAt: new Date().toISOString(),
        passed: false,
        providerRequests: 0,
        businessTargetRequests: 0,
        modelsResolved: 0,
      };
    let session,
      identity,
      eligibilityVerified = false;
    const permitDirectory = join(
      cloudUpgradeProfile.root,
      'setup',
      'cloud-resource-policy-upgrade',
    );
    try {
      const source = await readonlyState(db, input);
      if (input.mode !== 'status') await requireStopped(input);
      const controls = await ControlJournal.fromEnvironment(db, fixed),
        latest = await controls.latest();
      assert.equal(latest.head.platformId, cloudUpgradeProfile.platformId);
      assert.equal(latest.head.pending, null);
      assert.equal(
        String(latest.head.committed.sequence),
        source.control.control_sequence,
      );
      assert.equal(
        latest.head.committed.stateDigest,
        source.control.state_digest,
      );
      eligibilityVerified = true;
      evidence.before = source;
      if (['before35', 'execute36'].includes(input.mode)) {
        const stored = await readPermit(input.permitId, canonicalJson, input),
          fence = new CloudPolicyUpgradeFence(
            permitDirectory,
            cloudUpgradeProfile.platformId,
          );
        await fence.assertBound({
          permitId: input.permitId,
          signature: stored.signature,
        });
        await regular(join(permitDirectory, input.permitId + '.consumed.json'));
        sameLegacyModels(source.models, stored.permit.models);
        const [
          { resourcePolicyReaderFromEnvironment },
          { loadAnchoredResourcePolicy },
          { runtimeResourceCapabilities },
        ] = await Promise.all([
          imports('packages/application/src/resource-policy/environment.js'),
          imports('packages/application/src/resource-policy/operations.js'),
          imports('packages/application/src/resource-policy/capabilities.js'),
        ]);
        const policy = await loadAnchoredResourcePolicy(
          db,
          runtimeResourceCapabilities,
          await resourcePolicyReaderFromEnvironment(fixed),
        );
        assert.deepEqual(
          {
            revisionId: policy.revisionId,
            digest: policy.digest,
            activationVersion: policy.activationVersion,
          },
          stored.permit.head,
        );
        if (input.mode === 'before35') {
          await privateDirectory(dirname(input.proof));
          const proof = await captureModelUpgradeBeforeProof(
            db,
            controls,
            cloudUpgradeProfile.platformId,
            join(input.runtime, 'packages/persistence/migrations'),
          );
          const proofBytes = Buffer.from(canonicalJson(proof) + '\n');
          await proofBinding(input, stored, proofBytes, canonicalJson, true);
          if (await absent(input.proof))
            await exclusiveJson(input.proof, proof, canonicalJson);
          else
            assert.equal(
              (await readFile(input.proof)).toString(),
              proofBytes.toString(),
            );
          evidence.proofPath = input.proof;
          evidence.proofDigest = sha(Buffer.from(canonicalJson(proof) + '\n'));
        } else {
          const item = await regular(input.proof);
          assert.ok(item.size <= 65536);
          const bytes = await readFile(input.proof),
            proof = modelUpgradeBeforeProofSchema.parse(JSON.parse(bytes));
          assert.equal(bytes.toString(), canonicalJson(proof) + '\n');
          assert.equal(proof.platformId, cloudUpgradeProfile.platformId);
          await proofBinding(input, stored, bytes, canonicalJson);
          evidence.checkpoint = await checkpointModelUpgrade(
            db,
            controls,
            proof,
            join(input.runtime, 'packages/persistence/migrations'),
            { explicit: true },
          );
        }
      } else {
        const [
          {
            resourcePolicyReaderFromEnvironment,
            resourcePolicyWriterFromEnvironment,
          },
          { ResourcePolicyOperations, loadAnchoredResourcePolicy },
          { runtimeResourceCapabilities },
          { loadActiveResourcePolicy },
          { defaultResourcePolicy },
          { resourcePolicyDigest },
        ] = await Promise.all([
          imports('packages/application/src/resource-policy/environment.js'),
          imports('packages/application/src/resource-policy/operations.js'),
          imports('packages/application/src/resource-policy/capabilities.js'),
          imports('packages/application/src/resource-policy/loader.js'),
          imports('packages/contracts/src/resource-policy.js'),
          imports('packages/application/src/resource-policy/core.js'),
        ]);
        const reader = await resourcePolicyReaderFromEnvironment(fixed),
          defaultHead = {
            revisionId: '34dbe2ea-c9c9-48d9-9318-06b20fba8e92',
            digest: resourcePolicyDigest(defaultResourcePolicy),
            activationVersion: '1',
          },
          fence = new CloudPolicyUpgradeFence(
            permitDirectory,
            cloudUpgradeProfile.platformId,
          );
        if (input.mode === 'status') {
          evidence.policy =
            source.migrations.length >= 34
              ? await loadAnchoredResourcePolicy(
                  db,
                  runtimeResourceCapabilities,
                  reader,
                )
              : null;
        } else {
          let stored;
          if (input.mode === 'prepare34') {
            assert.deepEqual(
              source.migrations.at(-1),
              cloudUpgradeProfile.previousMigration,
            );
            assert.equal(await reader.read(), null);
            const tables = (
              await db.query(
                "SELECT to_regclass('app.resource_policy_head') h,to_regclass('app.resource_policy_revisions') r,to_regclass('app.resource_policy_activations') a",
              )
            ).rows[0];
            assert.ok(Object.values(tables).every((value) => value === null));
          } else {
            stored = await readPermit(input.permitId, canonicalJson, input);
            assert.deepEqual(stored.permit.head, defaultHead);
            sameLegacyModels(source.models, stored.permit.models);
            if ((await reader.read()) === null)
              assert.deepEqual(stored.permit.sourceHead, latest.head.committed);
          }
          if (stored)
            await fence.assertBound({
              permitId: input.permitId,
              signature: stored.signature,
            });
          await controls.initialize();
          identity = new IdentityService(db);
          const password = (
            await readFile(
              join(
                cloudUpgradeProfile.root,
                'secrets/bootstrap-admin-password',
              ),
              'utf8',
            )
          ).trimEnd();
          const login = await identity.login({
            account: cloudUpgradeProfile.account,
            password,
          });
          session = login.session;
          assert.equal(login.user.isPlatformAdmin, true);
          const actor = await identity.authenticate(
            session,
            undefined,
            randomUUID(),
          );
          if (input.mode === 'prepare34') {
            const { backupFilesFromEnvironment } = await imports(
                'packages/application/src/recovery/environment.js',
              ),
              archive = await backupFilesFromEnvironment(fixed),
              manifest = await archive.read(input.backupId);
            await archive.verify(manifest);
            assert.equal(manifest.id, input.backupId);
            assert.equal(manifest.platformId, cloudUpgradeProfile.platformId);
            assert.deepEqual(manifest.versions.migrations, source.migrations);
            const row = (
              await db.query(
                'SELECT state,manifest_digest,control_sequence::text,control_digest,object_count::text FROM app.product_backups WHERE id=$1',
                [input.backupId],
              )
            ).rows[0];
            assert.equal(row.state, 'complete');
            assert.equal(
              row.manifest_digest,
              sha(await readFile(archive.path(input.backupId, 'manifest.enc'))),
            );
            assert.equal(
              row.control_sequence,
              String(manifest.controls.sequence),
            );
            assert.equal(row.control_digest, manifest.controls.stateDigest);
            assert.equal(row.object_count, String(manifest.objects.length));
            assert.equal(row.control_sequence, source.control.control_sequence);
            assert.equal(row.control_digest, source.control.state_digest);
            const permit = {
              schemaVersion:
                'ath.personal-cloud-resource-policy-upgrade-permit.v1',
              id: randomUUID(),
              platformId: cloudUpgradeProfile.platformId,
              preparedAt: new Date().toISOString(),
              previousMigration: cloudUpgradeProfile.previousMigration,
              migrationChecksum: cloudUpgradeProfile.policyMigration.checksum,
              backupId: input.backupId,
              backupManifestDigest: row.manifest_digest,
              backupObjects: manifest.objects.length,
              sourceHead: latest.head.committed,
              models: source.models,
              head: defaultHead,
              target: targetIdentity(input),
            };
            const signature = await permitSignature(permit, canonicalJson);
            await privateDirectory(permitDirectory);
            await exclusiveJson(
              join(permitDirectory, permit.id + '.json'),
              { permit, signature },
              canonicalJson,
            );
            await fence.bindPermit({ permitId: permit.id, signature });
            evidence.permitId = permit.id;
            evidence.backupId = input.backupId;
          } else {
            assert.deepEqual(
              source.migrations.at(-1),
              cloudUpgradeProfile.policyMigration,
            );
            const actual = await loadActiveResourcePolicy(
              db,
              runtimeResourceCapabilities,
            );
            assert.deepEqual(
              {
                revisionId: actual.revisionId,
                digest: actual.digest,
                activationVersion: actual.activationVersion,
              },
              defaultHead,
            );
            const permitIdentity = {
                permitId: input.permitId,
                signature: stored.signature,
              },
              initial = await fence.beginInitialization(permitIdentity, () =>
                reader.read(),
              );
            const service = new ResourcePolicyOperations(
              db,
              await resourcePolicyWriterFromEnvironment(fixed),
              runtimeResourceCapabilities,
              initial.bootstrapAllowed
                ? {
                    platformId: cloudUpgradeProfile.platformId,
                    head: defaultHead,
                  }
                : undefined,
            );
            await service.initialize(actor);
            const verified = await loadAnchoredResourcePolicy(
              db,
              runtimeResourceCapabilities,
              reader,
            );
            evidence.policyCheckpoint = await checkpointCloudPolicy34({
              db,
              controls,
              permit: stored.permit,
              permitSignature: stored.signature,
              expectedPlatformId: cloudUpgradeProfile.platformId,
              canonicalJson,
              explicitCloud34: true,
            });
            const receipt = join(
              permitDirectory,
              input.permitId + '.consumed.json',
            );
            if (await absent(receipt))
              await exclusiveJson(
                receipt,
                {
                  permitId: input.permitId,
                  platformId: cloudUpgradeProfile.platformId,
                  head: defaultHead,
                  consumedAt: new Date().toISOString(),
                },
                canonicalJson,
              );
            evidence.policyHead = {
              revisionId: verified.revisionId,
              digest: verified.digest,
              activationVersion: verified.activationVersion,
            };
          }
        }
      }
      evidence.passed = true;
    } catch (error) {
      evidence.errorCode =
        typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
          ? error.code
          : 'CLOUD_UPGRADE_REJECTED';
      throw Object.assign(new Error(evidence.errorCode), {
        code: evidence.errorCode,
      });
    } finally {
      if (identity && session) {
        try {
          await identity.logout(session);
          assert.equal(
            (
              await db.query(
                'SELECT revoked_at IS NOT NULL revoked FROM app.sessions WHERE id_hash=$1',
                [secretHash(session)],
              )
            ).rows[0]?.revoked,
            true,
          );
          evidence.sessionRevoked = true;
        } catch {
          evidence.sessionCleanupUnconfirmed = true;
          evidence.passed = false;
        }
      }
      await db.close();
      // The trusted operator is invoked only in an authorized cloud write window.
      // Rejected pure guards/runtime verification never reach this evidence write.
      if (eligibilityVerified && input.mode !== 'status') {
        const output = join(
          cloudUpgradeProfile.root,
          'setup',
          'cloud-upgrade-33-to-36',
        );
        await privateDirectory(output);
        await exclusiveJson(
          join(output, evidence.id + '.json'),
          evidence,
          canonicalJson,
        );
      }
      process.stdout.write(JSON.stringify(evidence) + '\n');
      if (!evidence.passed) process.exitCode = 1;
    }
  }

  return Object.freeze({ runCloudUpgrade });
}

export async function runCloudUpgrade(
  args = process.argv.slice(2),
  environment = process.env,
) {
  const configured = await readDeploymentProfile(environment);
  return createCloudUpgradeOperator(
    configured.data,
    configured.sha256,
  ).runCloudUpgrade(args, environment);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runCloudUpgrade().catch((error) => {
    process.stderr.write(
      (typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
        ? error.code
        : 'CLOUD_UPGRADE_REJECTED') + '\n',
    );
    process.exitCode = 1;
  });
