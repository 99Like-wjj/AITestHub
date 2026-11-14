import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReviewedJsonConfiguration } from './private-config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function validateSkillRuleSources(value) {
  const reject = () => {
    throw Object.assign(new Error('Skill archive configuration is invalid.'), {
      code: 'SKILL_RULE_SOURCES_INVALID',
    });
  };
  if (
    !value ||
    value.schemaVersion !== 'aitesthub.skill-rule-sources.v1' ||
    Object.keys(value).sort().join('|') !== 'schemaVersion|sources' ||
    !Array.isArray(value.sources) ||
    value.sources.length !== 2
  )
    reject();
  const expected = new Set(['ath-case-design', 'ath-project-knowledge']);
  for (const source of value.sources) {
    if (
      !source ||
      Object.keys(source).sort().join('|') !==
        'archives|name|ruleVersion|sections|skillId|version' ||
      !expected.delete(source.skillId) ||
      !/^\d+\.\d+\.\d+$/.test(source.version ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(source.ruleVersion ?? '') ||
      typeof source.name !== 'string' ||
      !source.name ||
      !source.sections ||
      Object.values(source.sections).some(
        (p) =>
          typeof p !== 'string' ||
          !/^(?:SKILL\.md|(?:references|host-adapters)\/[a-z-]+\.md)$/.test(p),
      ) ||
      !Array.isArray(source.archives) ||
      !source.archives.length ||
      source.archives.length > 2
    )
      reject();
    for (const archive of source.archives)
      if (
        !archive ||
        Object.keys(archive).sort().join('|') !== 'kind|path|sha256' ||
        !['zip', 'tgz'].includes(archive.kind) ||
        !isAbsolute(archive.path ?? '') ||
        !/^[a-f0-9]{64}$/.test(archive.sha256 ?? '')
      )
        reject();
  }
  return value.sources;
}
export async function readSkillRuleSources(environment = process.env) {
  return (
    await readReviewedJsonConfiguration(
      environment,
      'AITESTHUB_SKILL_RULE_SOURCES_FILE',
      'AITESTHUB_SKILL_RULE_SOURCES_SHA256',
      root,
      validateSkillRuleSources,
    )
  ).data;
}
