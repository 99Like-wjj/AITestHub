import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)),
  metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
  version = metadata.version,
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  file = 'dist/contracts/current.json',
  contractBytes = await readFile(resolve(root, file)),
  contract = JSON.parse(contractBytes.toString('utf8')),
  artifact = sha(contractBytes),
  parent = resolve(root, 'dist/packages/candidates', version),
  stageName = `local-client-${version}`,
  tgzName = `aitesthub-local-client-${version}.tgz`,
  zipName = `aitesthub-local-client-${version}.zip`,
  tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli || !isAbsolute(pnpmCli))
  throw Error('Run packaging through the pinned pnpm command.');
if (
  contract.schemaVersion !== 'ath.local-sdk-contract.v1' ||
  contract.artifactVersion !== version
)
  throw Error('Build the current SDK contract before packaging.');
await mkdir(parent, { recursive: true });
assert.equal(
  await realpath(parent),
  resolve(await realpath(root), 'dist/packages/candidates', version),
);
const draft = await mkdtemp(resolve(parent, '.pack-'));
const draftName = relative(parent, await realpath(draft));
assert.match(draftName, /^\.pack-[a-zA-Z0-9]+$/);
try {
  execFileSync(
    process.execPath,
    [pnpmCli, 'pack', '--pack-destination', draft],
    {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  const tgz = resolve(draft, tgzName);
  const tarballDigest = sha(await readFile(tgz));
  const lockfileDigest = sha(await readFile(resolve(root, 'pnpm-lock.yaml')));
  const candidateIdentity = sha(
    JSON.stringify(['ath.local-sdk-package.v1', tarballDigest, lockfileDigest]),
  );
  const out = resolve(parent, candidateIdentity);
  const stage = resolve(draft, stageName);
  const tarEntries = execFileSync(tar, ['-t', '-f', tgz], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/);
  const contractEntries = tarEntries.filter((entry) =>
    entry.startsWith('package/dist/contracts/'),
  );
  const contractEntry = `package/${file}`;
  if (
    !tarEntries.includes('package/dist/src/index.js') ||
    contractEntries.length !== 1 ||
    contractEntries[0] !== contractEntry ||
    sha(
      execFileSync(tar, ['-xOf', tgz, contractEntry], {
        maxBuffer: 8 * 1024 * 1024,
      }),
    ) !== artifact
  )
    throw new Error(
      'Package must contain the runtime and exactly its pinned contract.',
    );
  await mkdir(stage);
  for (const name of [
    'README.md',
    'LICENSE',
    'NOTICE',
    'pnpm-lock.yaml',
    'verification.md',
  ])
    await copyFile(resolve(root, name), resolve(stage, name));
  await copyFile(tgz, resolve(stage, `aitesthub-local-client-${version}.tgz`));
  await writeFile(
    resolve(stage, 'contract-provenance.json'),
    JSON.stringify(
      {
        artifactId: artifact,
        artifactVersion: version,
        protocolVersion: contract.protocolVersion,
        source: 'official-server-registration-and-consumed-components',
        toolCount: contract.tools.length,
        componentCount: Object.keys(contract.components).length,
      },
      null,
      2,
    ) + '\n',
  );
  const zip = resolve(draft, zipName);
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', draft, stageName], {
    windowsHide: true,
  });
  const bytes = await readFile(zip);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error('ZIP-capable packaging host required');
  const entries = execFileSync(tar, ['-t', '-f', zip], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/);
  if (entries.some((p) => !p.startsWith(stageName + '/') || p.includes('..')))
    throw new Error('Unexpected ZIP member');
  const evidence = {
    package: '@aitesthub/local-client',
    version,
    candidateIdentity,
    contractArtifactId: artifact,
    artifacts: [
      {
        path: relative(root, resolve(out, tgzName)).replaceAll('\\', '/'),
        sha256: tarballDigest,
      },
      {
        path: relative(root, resolve(out, zipName)).replaceAll('\\', '/'),
        sha256: sha(bytes),
      },
    ],
    zipEntries: entries,
    tgzContractEntries: contractEntries,
    packagingInstalls: 0,
    packagingMainRequests: 0,
  };
  await writeFile(
    resolve(draft, 'package-verification.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx' },
  );
  let published = evidence;
  try {
    await rename(draft, out);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
    const prior = JSON.parse(
      await readFile(resolve(out, 'package-verification.json'), 'utf8'),
    );
    assert.equal(prior.candidateIdentity, candidateIdentity);
    assert.equal(prior.contractArtifactId, artifact);
    assert.equal(sha(await readFile(resolve(out, tgzName))), tarballDigest);
    assert.equal(
      sha(await readFile(resolve(out, zipName))),
      prior.artifacts[1].sha256,
    );
    published = prior;
  }
  console.log(JSON.stringify(published));
} finally {
  const existingDraft = await realpath(draft).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existingDraft) {
    assert.equal(relative(parent, existingDraft), draftName);
    await rm(existingDraft, { recursive: true });
  }
}
