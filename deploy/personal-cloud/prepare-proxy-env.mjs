// Trusted host only. Password goes through stdin, never argv, stdout or repository.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, writeFile, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
const args = process.argv.slice(2),
  arg = (name) =>
    args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = '/srv/aitesthub-private',
  binary = arg('caddy') ?? '/usr/local/bin/aitesthub-caddy',
  address = arg('ip');
async function run(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (v) => (output += v));
    child.stderr.resume();
    child.once('error', () => reject(Error('Caddy executable unavailable')));
    child.once('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(Error('Caddy credential preparation failed')),
    );
    child.stdin.end(input);
  });
}
try {
  if (
    process.platform !== 'linux' ||
    isIP(address) !== 4 ||
    !binary.startsWith('/')
  )
    throw Error('Explicit Linux public IPv4/binary required');
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0
  )
    throw Error('Prepared private root required');
  const marker = JSON.parse(
    await readFile(root + '/.cloud-bootstrap.json', 'utf8'),
  );
  if (marker.schemaVersion !== 'ath.personal-cloud-bootstrap.v1')
    throw Error('Prepared independent identity required');
  if (!(await run(['version'])).startsWith('v2.11.9 '))
    throw Error('Expected fixed Caddy2.11.9');
  for (const path of [
    root + '/proxy.env',
    root + '/secrets/trial-gate-password',
  ]) {
    try {
      await lstat(path);
      throw Error(
        'Existing proxy credentials require original identity review',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const password = randomBytes(24).toString('hex'),
    hash = await run(['hash-password'], password + '\n');
  if (!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash))
    throw Error('Unexpected bcrypt output');
  await writeFile(root + '/secrets/trial-gate-password', password, {
    flag: 'wx',
    mode: 0o400,
  });
  await writeFile(
    root + '/proxy.env',
    `AITESTHUB_PUBLIC_IP=${address}\nAITESTHUB_TRIAL_GATE_HASH=${hash}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      prepared: true,
      gateUsername: 'aitesthub-trial',
      passwordFile: root + '/secrets/trial-gate-password',
      environmentFile: root + '/proxy.env',
      secretValuesPrinted: false,
      certificateIssued: false,
    }),
  );
} catch {
  process.stderr.write(
    'AITestHub proxy preparation refused; private files preserved, no credential printed.\n',
  );
  process.exitCode = 1;
}
