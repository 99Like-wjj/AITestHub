import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const rejected = () =>
  Object.assign(
    new Error('An external, explicitly pinned configuration file is required.'),
    {
      code: 'EXTERNAL_CONFIGURATION_REQUIRED',
    },
  );

export function assertExternalConfigurationPath(file, codeRoot) {
  if (!file || !isAbsolute(file)) throw rejected();
  const path = resolve(file);
  const scope = relative(resolve(codeRoot), path);
  const outside =
    scope === '..' ||
    scope.startsWith('../') ||
    scope.startsWith('..\\') ||
    isAbsolute(scope);
  if (!scope || !outside) throw rejected();
  return path;
}

export function deepFreezeConfiguration(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreezeConfiguration(child);
    Object.freeze(value);
  }
  return value;
}

export async function readReviewedJsonConfiguration(
  environment,
  fileVariable,
  hashVariable,
  codeRoot,
  validate,
) {
  const file = assertExternalConfigurationPath(
    environment[fileVariable],
    codeRoot,
  );
  const expected = environment[hashVariable];
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw rejected();
  const item = await lstat(file);
  const resolved = await realpath(file);
  const samePath =
    process.platform === 'win32'
      ? resolved.toLowerCase() === file.toLowerCase()
      : resolved === file;
  if (
    !item.isFile() ||
    item.isSymbolicLink() ||
    item.nlink !== 1 ||
    item.size > 131072 ||
    !samePath
  )
    throw rejected();
  const bytes = await readFile(file);
  if (bytes.length > 131072) throw rejected();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) throw rejected();
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw rejected();
  }
  return { data: deepFreezeConfiguration(validate(data)), sha256, file };
}
