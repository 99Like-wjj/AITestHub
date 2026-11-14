// Fixed-image metadata evaluator, sent via stdin to the deployed API container.
// Imports contracts only; no application service, DB, model adapter or credential.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
assert.equal(process.cwd(), '/app');
assert.equal(process.env.AITESTHUB_COMPONENT_EXPORT, 'deployed-contracts-only');
process.env = { NODE_ENV: 'production' };
globalThis.fetch = () => {
  throw Error('NETWORK_DISABLED_FOR_CONTRACT_EXPORT');
};
const modules = [
  'base',
  'domain',
  'assets',
  'requirements',
  'ui-results',
  'ui-delivery',
  'knowledge',
  'plans',
  'retests',
  'files',
  'file-resources',
  'auxiliary',
  'automatic-auxiliary',
];
const schemas = {};
for (const name of modules) {
  const module = await import(`/app/dist/packages/contracts/src/${name}.js`);
  for (const [key, value] of Object.entries(module))
    if (
      value &&
      typeof value === 'object' &&
      typeof value.safeParse === 'function'
    )
      schemas[`${name}.${key}`] = z.toJSONSchema(value, {
        target: 'draft-2020-12',
        unrepresentable: 'throw',
        io: 'input',
      });
}
const compiledContractHashes = {};
for (const file of (await readdir('/app/dist/packages/contracts/src'))
  .filter((name) => name.endsWith('.js'))
  .sort())
  compiledContractHashes[`dist/packages/contracts/src/${file}`] = createHash(
    'sha256',
  )
    .update(await readFile(`/app/dist/packages/contracts/src/${file}`))
    .digest('hex');
const migrations = [];
for (const file of (await readdir('/app/packages/persistence/migrations'))
  .filter((name) => /^[0-9]{4}_[a-z0-9_]+[.]sql$/.test(name))
  .sort())
  migrations.push({
    version: file,
    checksum: createHash('sha256')
      .update(await readFile(`/app/packages/persistence/migrations/${file}`))
      .digest('hex'),
  });
console.log(JSON.stringify({ schemas, compiledContractHashes, migrations }));
