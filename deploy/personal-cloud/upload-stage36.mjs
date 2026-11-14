// Explicit staging only: data/hosts/identities are loaded from reviewed private files.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeploymentProfile } from './deployment-profile.mjs';
import { readReviewedJsonConfiguration } from '../../scripts/private-config.mjs';

assert.equal(
  process.env.AITESTHUB_CLOUD36_STAGE,
  'explicit-reviewed-cloud36-stage-only',
);
assert.equal(process.argv.length, 3);
const codeRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configured = await readDeploymentProfile();
const profile = configured.data;
const privateRoot = join(
  process.env.LOCALAPPDATA,
  'AITestHub/setup/personal-cloud',
);
const planPath = resolve(process.argv[2]);
const within = relative(privateRoot, planPath);
assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
const planBytes = await readFile(planPath);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(planBytes), process.env.AITESTHUB_DEPLOYMENT_PLAN_SHA256);
const plan = JSON.parse(planBytes);
assert.equal(plan.schemaVersion, 'ath.cloud36-operator-package.v1');
assert.match(plan.imageId, /^sha256:[a-f0-9]{64}$/);
assert.equal(
  plan.releaseRoot,
  profile.releaseRoot + '/36-' + plan.imageId.slice(7, 19),
);
assert.equal(plan.platformId, profile.platformId);
assert.equal(plan.profileSha256, configured.sha256);
assert.deepEqual(plan.profile, profile);
const reviewedBinding = await readReviewedJsonConfiguration(
  process.env,
  'AITESTHUB_SSH_BINDING_FILE',
  'AITESTHUB_SSH_BINDING_SHA256',
  codeRoot,
  (value) => value,
);
const binding = reviewedBinding.data;
assert.equal(binding.host, profile.host);
assert.equal(binding.user, profile.sshUser);
assert.equal(binding.serverAuthorizationInstalled, true);
assert.equal(binding.hostKeyFingerprint, profile.hostKeyFingerprint);
const options = [
  '-o',
  'BatchMode=yes',
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'IdentityAgent=none',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'UserKnownHostsFile=' + binding.knownHosts.replaceAll('\\', '/'),
  '-o',
  'ConnectTimeout=15',
  '-i',
  binding.keyPath,
];
const host = binding.user + '@' + binding.host;
assert.ok(
  execFileSync(
    join(binding.sshRoot, 'ssh-keygen.exe'),
    ['-lf', binding.knownHosts],
    { windowsHide: true, encoding: 'utf8' },
  ).includes(binding.hostKeyFingerprint),
);
function remotePython(body, parameters) {
  const prefix =
    'import base64,json\ncfg=json.loads(base64.b64decode(' +
    JSON.stringify(Buffer.from(JSON.stringify(parameters)).toString('base64')) +
    '))\n';
  return execFileSync(
    join(binding.sshRoot, 'ssh.exe'),
    [...options, host, 'python3 -'],
    {
      input: prefix + body,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
}
const id = randomUUID();
const report = {
  schemaVersion: 'ath.cloud36-stage-transfer.v1',
  id,
  startedAt: new Date().toISOString(),
  planPath,
  releaseRoot: plan.releaseRoot,
  imageId: plan.imageId,
  profileSha256: configured.sha256,
  passed: false,
  hostKeyPinned: true,
  databaseMigrations: 0,
  serviceSwitches: 0,
  secretChanges: 0,
  providerRequests: 0,
  uploads: [],
};
try {
  report.preflight = JSON.parse(
    remotePython(
      'import pathlib,subprocess\np=pathlib.Path(cfg["releaseRoot"])\nassert p.parent.resolve()==p.parent\nq="BEGIN TRANSACTION READ ONLY; SELECT platform_id FROM app.recovery_control_state WHERE singleton; COMMIT;"\nv=subprocess.check_output(["sudo","-n","docker","exec",cfg["databaseContainer"],"psql","-XqAt","-v","ON_ERROR_STOP=1","-U","aitesthub_admin","-d","aitesthub","-c",q],text=True).strip()\nassert v==cfg["platformId"]\nif not p.exists():subprocess.run(["sudo","-n","install","-d","-m","0755","-o",cfg["user"],"-g",cfg["group"],str(p)],check=True)\nassert p.resolve()==p and p.is_dir() and not p.is_symlink()\na=p/"artifacts"\nif not a.exists():subprocess.run(["sudo","-n","install","-d","-m","0755","-o",cfg["user"],"-g",cfg["group"],str(a)],check=True)\nassert a.resolve()==a and a.is_dir() and not a.is_symlink()\nprint(json.dumps({"platformMatched":True,"newReleaseRootVerified":True}))\n',
      {
        releaseRoot: plan.releaseRoot,
        platformId: profile.platformId,
        databaseContainer: profile.containers.database,
        user: profile.sshUser,
        group: profile.sshGroup,
      },
    ),
  );
  for (const item of [plan.imageArchive, plan.operatorArchive]) {
    assert.match(item.name, /^[a-zA-Z0-9_.-]+\.tar\.gz$/);
    assert.equal(basename(item.localPath), item.name);
    const scope = relative(privateRoot, resolve(item.localPath));
    assert.ok(scope && !scope.startsWith('..') && !isAbsolute(scope));
    assert.equal((await stat(item.localPath)).size, item.bytes);
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(item.localPath))
      digest.update(bytes);
    assert.equal(digest.digest('hex'), item.sha256);
    const destination = plan.releaseRoot + '/artifacts/' + item.name;
    const probe =
      'import pathlib,hashlib\np=pathlib.Path(cfg["path"])\nif not p.exists():print(json.dumps({"exists":False}))\nelse:\n assert p.is_file() and not p.is_symlink()\n h=hashlib.sha256()\n with p.open("rb")as f:\n  for b in iter(lambda:f.read(1048576),b""):h.update(b)\n print(json.dumps({"exists":True,"bytes":p.stat().st_size,"sha256":h.hexdigest()}))\n';
    const before = JSON.parse(remotePython(probe, { path: destination }));
    if (before.exists) {
      assert.equal(before.bytes, item.bytes);
      assert.equal(before.sha256, item.sha256);
    } else {
      const child = spawn(
        join(binding.sshRoot, 'scp.exe'),
        [...options, item.localPath, host + ':' + destination],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child.stderr.resume();
      const code = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(
        code,
        0,
        'Transfer incomplete; inspect the existing target without automatic retry.',
      );
    }
    const after = JSON.parse(remotePython(probe, { path: destination }));
    assert.equal(after.bytes, item.bytes);
    assert.equal(after.sha256, item.sha256);
    report.uploads.push({
      name: item.name,
      bytes: item.bytes,
      sha256: after.sha256,
      alreadyComplete: before.exists,
    });
  }
  report.passed = true;
} catch (error) {
  report.errorCode =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'CLOUD36_STAGE_TRANSFER_FAILED';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const output = join(privateRoot, 'stage36-transfer-' + id + '.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      output,
      passed: report.passed,
      uploads: report.uploads,
      errorCode: report.errorCode,
    }),
  );
}
