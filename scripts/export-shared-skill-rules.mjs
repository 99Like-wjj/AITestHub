// Maintenance/build-only. Never imported by a host, model tool or normal platform build.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkillRuleSources } from './skill-rule-sources.mjs';
const exec = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? '[' + value.map(canonical).join(',') + ']'
      : '{' +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}';
const sources = await readSkillRuleSources(process.env);
const python = String.raw`import sys,json,zipfile,tarfile,hashlib,pathlib,stat,base64
p=sys.argv[1]; wanted=json.loads(sys.argv[2]); files={}; selected={}
def take(name,data,mode=0):
 parts=pathlib.PurePosixPath(name).parts
 if '/'.join(parts)!=name or chr(92) in name: raise ValueError('Unsafe artifact entry')
 if not parts or pathlib.PurePosixPath(name).is_absolute() or any(x in ('.','..') for x in parts) or ':' in name or '\\' in name or stat.S_ISLNK(mode): raise ValueError('Unsafe artifact entry')
 if name in files: raise ValueError('Duplicate artifact entry')
 files[name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
 if name in wanted: selected[name]=base64.b64encode(data).decode('ascii')
if p.endswith('.zip'):
 with zipfile.ZipFile(p) as z:
  for info in z.infolist():
   if not info.is_dir(): take(info.filename,z.read(info),info.external_attr>>16)
else:
 with tarfile.open(p,'r:gz') as t:
  for info in t.getmembers():
   if info.issym() or info.islnk(): raise ValueError('Linked artifact entry')
   if info.isfile(): take(info.name,t.extractfile(info).read(),info.mode)
print(json.dumps({'files':files,'selected':selected}))
`;
const decode = (base64) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.from(base64, 'base64'),
  );
const slots = [],
  trust = [],
  licenses = [];
for (const source of sources) {
  let archives = [],
    manifestSha256 = null;
  try {
    const selectedNames = [
      ...new Set([
        'manifest.json',
        'integrity.json',
        'LICENSE',
        ...Object.values(source.sections),
      ]),
    ];
    const outputs = [];
    for (const archive of source.archives) {
      const bytes = await readFile(archive.path);
      if (hash(bytes) !== archive.sha256)
        throw Object.assign(Error('Unapproved archive bytes'), {
          code: 'RULE_ARCHIVE_HASH_MISMATCH',
        });
      archives.push({
        kind: archive.kind,
        fileName: basename(archive.path),
        sha256: archive.sha256,
        bytes: bytes.length,
      });
      const prefix =
        archive.kind === 'zip'
          ? source.skillId + '/'
          : 'package/skills/' + source.skillId + '/';
      const selected = [
        ...selectedNames.map((name) => prefix + name),
        ...(archive.kind === 'tgz' ? ['package/dist/rules.js'] : []),
      ];
      const parsed = JSON.parse(
        (
          await exec(
            'python',
            ['-c', python, archive.path, JSON.stringify(selected)],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          )
        ).stdout,
      );
      outputs.push({ ...parsed, prefix, archive });
    }
    const first = outputs[0],
      text = (name) => {
        const bytes = first.selected[first.prefix + name];
        if (bytes === undefined)
          throw Object.assign(Error('Missing published text'), {
            code: 'RULE_DOCUMENT_MISSING',
          });
        return decode(bytes);
      };
    const manifestText = text('manifest.json'),
      manifest = JSON.parse(manifestText);
    manifestSha256 = hash(manifestText);
    if (
      (manifest.skillId ?? manifest.id) !== source.skillId ||
      (manifest.skillVersion ?? manifest.version) !== source.version ||
      (manifest.ruleVersion ?? manifest.skillVersion ?? manifest.version) !==
        source.ruleVersion ||
      (manifest.license && manifest.license !== 'MIT')
    )
      throw Object.assign(Error('Manifest identity mismatch'), {
        code: 'RULE_MANIFEST_INVALID',
      });
    const declared = manifest.files ?? JSON.parse(text('integrity.json')).files;
    const records = Array.isArray(declared)
      ? declared
      : Object.entries(declared).map(([path, sha256]) => ({ path, sha256 }));
    for (const record of records) {
      const actual = first.files[first.prefix + record.path];
      if (
        !actual ||
        actual.sha256 !== record.sha256 ||
        (record.bytes !== undefined && actual.bytes !== Number(record.bytes))
      )
        throw Object.assign(Error('Manifest/inventory mismatch'), {
          code: 'RULE_MANIFEST_HASH_MISMATCH',
        });
    }
    if (
      source.skillId === 'ath-project-knowledge' ||
      source.skillId === 'ath-api-regression'
    ) {
      const paths = Object.keys(first.files)
        .filter(
          (name) =>
            name.startsWith(first.prefix) &&
            name !== first.prefix + 'integrity.json',
        )
        .map((name) => name.slice(first.prefix.length))
        .sort();
      if (
        canonical(paths) !==
        canonical(records.map((record) => record.path).sort())
      )
        throw Object.assign(Error('Extra archive content'), {
          code: 'RULE_MANIFEST_INVALID',
        });
    }
    for (const second of outputs.slice(1)) {
      for (const record of records) {
        if (
          second.files[second.prefix + record.path]?.sha256 !==
          first.files[first.prefix + record.path]?.sha256
        )
          throw Object.assign(Error('TGZ/ZIP rule mismatch'), {
            code: 'RULE_DISTRIBUTION_MISMATCH',
          });
      }
      if (
        second.files[second.prefix + 'manifest.json']?.sha256 !== manifestSha256
      )
        throw Object.assign(Error('TGZ/ZIP manifest mismatch'), {
          code: 'RULE_DISTRIBUTION_MISMATCH',
        });
      const literal = decode(second.selected['package/dist/rules.js']),
        start = 'export const skillManifest = ',
        middle = ';\nexport const skillContents = ';
      const index = literal.indexOf(start),
        delimiter = literal.indexOf(middle, index + start.length);
      const exportedManifest = JSON.parse(
          literal.slice(index + start.length, delimiter),
        ),
        exportedContents = JSON.parse(
          literal
            .slice(delimiter + middle.length)
            .trim()
            .replace(/;$/, ''),
        );
      if (
        canonical(exportedManifest) !== canonical(manifest) ||
        records.some(
          (record) =>
            hash(exportedContents[record.path] ?? '') !== record.sha256,
        )
      )
        throw Object.assign(Error('Pure rules export mismatch'), {
          code: 'RULE_DISTRIBUTION_MISMATCH',
        });
    }
    const entry = text('SKILL.md');
    if (!entry.startsWith('---') || !entry.includes('name: ' + source.skillId))
      throw Object.assign(Error('Wrong entry'), {
        code: 'RULE_MANIFEST_INVALID',
      });
    const description =
      entry
        .match(/^description:\s*(.+)$/m)?.[1]
        ?.trim()
        .replace(/^"|"$/g, '') ?? source.name;
    const documents = Object.entries(source.sections).map(([section, path]) => {
      const value = text(path),
        bytes = Buffer.byteLength(value);
      if (bytes > 131072)
        throw Object.assign(Error('Rule too large'), {
          code: 'RULE_DOCUMENT_TOO_LARGE',
        });
      return { section, path, sha256: hash(value), bytes, text: value };
    });
    const release = {
      skillId: source.skillId,
      version: source.version,
      ruleVersion: source.ruleVersion,
      name: source.name,
      description,
      sourceArchives: archives,
      manifestSha256,
      licenseSha256: hash(text('LICENSE')),
      license: 'MIT',
      compatibleContracts: manifest.compatibleContracts ?? [
        manifest.officialContract?.protocolVersion ?? '2026-07-28',
      ],
      documents,
      releaseDigest: '',
    };
    // Explicit field selection avoids undefined or body text in the signed metadata digest.
    const {
      releaseDigest: _digest,
      documents: _documents,
      ...metadata
    } = release;
    release.releaseDigest = hash(
      canonical({
        ...metadata,
        documents: documents.map(({ text: _text, ...doc }) => doc),
      }),
    );
    slots.push({
      skillId: source.skillId,
      configured: true,
      release,
      unavailableCode: null,
    });
    trust.push({
      skillId: source.skillId,
      version: source.version,
      ruleVersion: source.ruleVersion,
      releaseDigest: release.releaseDigest,
      sourceArchives: archives,
      manifestSha256,
    });
    licenses.push({
      skillId: source.skillId,
      version: source.version,
      sha256: release.licenseSha256,
      text: text('LICENSE'),
    });
  } catch (error) {
    const code =
      error.code === 'ENOENT'
        ? 'RULE_ARCHIVE_MISSING'
        : /^RULE_[A-Z_]+$/.test(error.code ?? '')
          ? error.code
          : 'RULE_EXPORT_FAILED';
    slots.push({
      skillId: source.skillId,
      configured: false,
      release: null,
      unavailableCode: code,
    });
    trust.push({
      skillId: source.skillId,
      version: source.version,
      ruleVersion: source.ruleVersion,
      releaseDigest: null,
      sourceArchives: source.archives.map((item) => ({
        kind: item.kind,
        fileName: item.path.split('/').at(-1),
        sha256: item.sha256,
        bytes: 0,
      })),
      manifestSha256,
    });
  }
}
const content =
  '// Generated exclusively from approved frozen release archives. No runtime I/O.\n// prettier-ignore\nexport const sharedSkillRuleArtifact: unknown = ' +
  JSON.stringify({
    schemaVersion: 'ath.shared-skill-rule-artifact.v1',
    slots,
  }) +
  ';\n// prettier-ignore\nexport const sharedSkillRuleTrust: unknown = ' +
  JSON.stringify(trust) +
  ';\n// Original MIT notices retained in the compiled distribution; not model context.\n// prettier-ignore\nexport const sharedSkillRuleLicenses: unknown = ' +
  JSON.stringify(licenses) +
  ';\n';
const destination = resolve(
  root,
  'packages/application/src/shared-skill-rules/bundle.generated.ts',
);
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')) !== content)
    throw Error('Generated shared-rule data differs from the frozen releases.');
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
console.log(
  JSON.stringify({
    destination:
      'packages/application/src/shared-skill-rules/bundle.generated.ts',
    artifactSha256: hash(content),
    slots: slots.map((slot) => ({
      skillId: slot.skillId,
      available: Boolean(slot.release),
      code: slot.unavailableCode,
      documents: slot.release?.documents.length ?? 0,
    })),
  }),
);
