import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export async function prepareRuntimeOutput(workspace) {
  const root = await realpath(workspace);
  const metadata = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  );
  const config = JSON.parse(
    await readFile(resolve(root, 'tsconfig.server.json'), 'utf8'),
  );
  assert.equal(metadata.name, 'aitesthub');
  assert.equal(config.compilerOptions.outDir, 'dist');
  const output = resolve(root, 'dist');
  assert.equal(relative(root, output), 'dist');
  let present = false;
  try {
    const item = await lstat(output);
    assert.ok(
      item.isDirectory() && !item.isSymbolicLink(),
      'Unsafe build output',
    );
    assert.equal(relative(root, await realpath(output)), 'dist');
    present = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (present) await rm(output, { recursive: true });
  await mkdir(output);
  return { root, output };
}

async function main() {
  const { root } = await prepareRuntimeOutput(
    resolve(import.meta.dirname, '..'),
  );
  const child = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      resolve(root, 'tsconfig.server.json'),
    ],
    { cwd: root, windowsHide: true, stdio: 'inherit' },
  );
  process.exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    process.stderr.write('SERVER_BUILD_OUTPUT_REJECTED\n');
    process.exitCode = 1;
  });
