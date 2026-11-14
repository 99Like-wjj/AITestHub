import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinnedContractArtifact } from './source-manifest.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  artifact = await readPinnedContractArtifact(root),
  source = resolve(root, 'contracts', artifact),
  destination = resolve(root, 'dist/contracts', artifact);
const manifest = JSON.parse(
  await readFile(resolve(source, 'manifest.json'), 'utf8'),
);
await mkdir(destination, { recursive: true });
if (
  manifest.protocolVersion !== '2026-07-28' ||
  manifest.structuralValidationOnly !== true ||
  manifest.omittedComponents.length
)
  throw new Error('Unsupported contract publication');
for (const name of ['catalog.json', 'components.json']) {
  const bytes = await readFile(resolve(source, name));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name])
    throw new Error('Contract publication hash mismatch');
  await writeFile(resolve(destination, name), bytes);
}
await writeFile(
  resolve(destination, 'manifest.json'),
  await readFile(resolve(source, 'manifest.json')),
);
console.log(
  JSON.stringify({
    artifact,
    tools: manifest.toolCount,
    components: manifest.componentCount,
    structuralOnly: true,
    mainRuntimeImports: 0,
    publicationState: manifest.publicationState,
    mainPublished: manifest.mainPublished,
  }),
);
