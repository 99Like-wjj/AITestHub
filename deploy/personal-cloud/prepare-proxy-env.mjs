// Trusted host only. This prepares the public address, never a browser password.
import { lstat, writeFile, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
const args = process.argv.slice(2),
  arg = (name) =>
    args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = '/srv/aitesthub-private',
  address = arg('ip');
try {
  if (process.platform !== 'linux' || isIP(address) !== 4)
    throw Error('Explicit Linux public IPv4 required');
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
  try {
    await lstat(root + '/proxy.env');
    throw Error('Existing proxy configuration requires an explicit update');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(root + '/proxy.env', `AITESTHUB_PUBLIC_IP=${address}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      prepared: true,
      environmentFile: root + '/proxy.env',
      secretValuesPrinted: false,
      certificateIssued: false,
    }),
  );
} catch {
  process.stderr.write(
    'AITestHub proxy preparation refused; existing private configuration preserved.\n',
  );
  process.exitCode = 1;
}
