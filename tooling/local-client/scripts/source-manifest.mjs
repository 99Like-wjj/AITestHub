import { readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

export async function readPinnedContractArtifact(clientRoot) {
  const source = await readFile(join(clientRoot, 'src/contracts.ts'), 'utf8'),
    values = [
      ...source.matchAll(
        /export const contractArtifactId = '([a-f0-9-]{36})';/g,
      ),
    ];
  if (values.length !== 1)
    throw Error('Exactly one pinned contract artifact is required.');
  return values[0][1];
}

/** Developer export only: explicit whole-directory superset, including indirect and currently unused definitions. */
export async function contractSourceInventory(workspace) {
  const root = join(workspace, 'packages/contracts/src');
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name),
        info = await lstat(path);
      if (info.isSymbolicLink())
        throw Error('Contract source symlinks are not accepted.');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && item.name.endsWith('.ts'))
        files.push(relative(workspace, path).replaceAll('\\', '/'));
    }
  }
  await walk(root);
  files.sort();
  const hashes = {};
  for (const path of files)
    hashes[path] = createHash('sha256')
      .update(await readFile(join(workspace, path)))
      .digest('hex');
  return {
    root: 'packages/contracts/src',
    mode: 'all-typescript-sources-recursive-superset',
    paths: files,
    hashes,
  };
}
