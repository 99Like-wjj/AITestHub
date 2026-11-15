import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sharedSkillRuleSnapshotSchema } from '../../../contracts/src/skill-guidance.js';
import {
  sharedSkillRuleArtifact,
  sharedSkillRuleTrust,
} from './bundle.generated.js';
import {
  SHARED_SKILL_IDS,
  type RuleCatalogEntry,
  type RuleRelease,
  type RuleReleaseTrust,
  type RuleSection,
  type SharedSkillId,
  type SharedSkillRuleReadReceipt,
  type SharedSkillRuleSnapshot,
} from './types.js';
export { sharedSkillRuleSnapshotSchema } from '../../../contracts/src/skill-guidance.js';

/** Canonical metadata only. Bodies are independently hashed as their exact published UTF-8 bytes. */
export function canonicalRuleJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalRuleJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalRuleJson(record[key])}`)
    .join(',')}}`;
}
export function ruleSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const section = z.enum([
  'entry',
  'business-rules',
  'coverage',
  'contracts',
  'review',
  'platform-adapter',
  'content-and-sources',
  'platform-workflow',
  'runtime',
  'generation',
  'native-api',
  'maintenance-and-recovery',
  'platform-debug',
]);
const archive = z.strictObject({
  kind: z.enum(['zip', 'tgz']),
  fileName: z.string().regex(/^[a-z0-9.-]+$/),
  sha256: sha,
  bytes: z.number().int().nonnegative(),
});
const releaseSchema = z.strictObject({
  skillId: z.enum(SHARED_SKILL_IDS),
  version,
  ruleVersion: version,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  sourceArchives: z.array(archive).min(1).max(2),
  manifestSha256: sha,
  licenseSha256: sha,
  license: z.literal('MIT'),
  compatibleContracts: z.array(z.string().max(100)).max(20),
  documents: z
    .array(
      z.strictObject({
        section,
        path: z
          .string()
          .regex(/^(?:SKILL\.md|(?:references|host-adapters)\/[a-z-]+\.md)$/),
        sha256: sha,
        bytes: z.number().int().positive().max(131072),
        text: z.string().min(1).max(131072),
      }),
    )
    .min(1)
    .max(10),
  releaseDigest: sha,
});
const trustSchema = z.strictObject({
  skillId: z.enum(SHARED_SKILL_IDS),
  version,
  ruleVersion: version,
  releaseDigest: sha.nullable(),
  manifestSha256: sha.nullable(),
  sourceArchives: z.array(archive).min(1).max(2),
});
const sections: Record<SharedSkillId, readonly RuleSection[]> = {
  'ath-case-design': [
    'entry',
    'business-rules',
    'coverage',
    'contracts',
    'review',
    'platform-adapter',
  ],
  'ath-project-knowledge': [
    'entry',
    'content-and-sources',
    'platform-workflow',
    'runtime',
  ],
  'ath-api-regression': [
    'entry',
    'generation',
    'native-api',
    'maintenance-and-recovery',
    'platform-debug',
    'platform-adapter',
  ],
};
const names: Record<SharedSkillId, string> = {
  'ath-case-design': '用例设计与优化',
  'ath-project-knowledge': '项目知识管理',
  'ath-api-regression': '接口自动化测试',
};
type Slot = {
  configured: boolean;
  trust: RuleReleaseTrust | null;
  release: RuleRelease | null;
  code: string | null;
};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function releaseMetadata(release: RuleRelease) {
  const { releaseDigest: _digest, documents, ...metadata } = release;
  return {
    ...metadata,
    documents: documents.map(({ text: _text, ...doc }) => doc),
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** No filesystem, network, domain runtime, identity or process configuration reads. */
export class SharedSkillRuleRegistry {
  readonly #slots = new Map<SharedSkillId, Slot>();
  constructor(artifact: unknown, trustedReleases: unknown) {
    const rawSlots =
      isRecord(artifact) &&
      artifact.schemaVersion === 'ath.shared-skill-rule-artifact.v1' &&
      Array.isArray(artifact.slots)
        ? artifact.slots
        : [];
    const rawTrusts = Array.isArray(trustedReleases) ? trustedReleases : [];
    for (const skillId of SHARED_SKILL_IDS) {
      const matching = rawSlots.filter(
        (value) => isRecord(value) && value.skillId === skillId,
      );
      const trusts = rawTrusts.filter(
        (value) => isRecord(value) && value.skillId === skillId,
      );
      const trusted =
        trusts.length === 1 ? trustSchema.safeParse(trusts[0]) : null;
      const trust = trusted?.success ? trusted.data : null;
      const raw =
        matching.length === 1 && isRecord(matching[0]) ? matching[0] : null;
      const slot: Slot = {
        configured: raw?.configured === true,
        trust,
        release: null,
        code: 'RULE_BUNDLE_MISSING',
      };
      this.#slots.set(skillId, slot);
      if (!raw || matching.length !== 1 || !trust) {
        if (!trust) slot.code = 'RULE_TRUST_INVALID';
        continue;
      }
      if (!raw.configured || raw.release === null) {
        slot.code =
          typeof raw.unavailableCode === 'string' &&
          /^RULE_[A-Z_]+$/.test(raw.unavailableCode)
            ? raw.unavailableCode
            : 'RULE_BUNDLE_MISSING';
        continue;
      }
      const parsed = releaseSchema.safeParse(raw.release);
      if (!parsed.success) {
        slot.code = 'RULE_MANIFEST_INVALID';
        continue;
      }
      const release = parsed.data;
      if (
        release.skillId !== skillId ||
        release.version !== trust.version ||
        release.ruleVersion !== trust.ruleVersion ||
        release.manifestSha256 !== trust.manifestSha256 ||
        release.releaseDigest !== trust.releaseDigest ||
        canonicalRuleJson(release.sourceArchives) !==
          canonicalRuleJson(trust.sourceArchives)
      ) {
        slot.code = 'RULE_RELEASE_MISMATCH';
        continue;
      }
      if (
        release.documents.length !== sections[skillId].length ||
        sections[skillId].some(
          (name) =>
            release.documents.filter((doc) => doc.section === name).length !==
            1,
        ) ||
        new Set(release.documents.map((doc) => doc.path)).size !==
          release.documents.length
      ) {
        slot.code = 'RULE_MANIFEST_INVALID';
        continue;
      }
      if (
        release.documents.some(
          (doc) =>
            Buffer.byteLength(doc.text, 'utf8') !== doc.bytes ||
            ruleSha256(doc.text) !== doc.sha256,
        )
      ) {
        slot.code = 'RULE_DOCUMENT_HASH_MISMATCH';
        continue;
      }
      if (
        ruleSha256(canonicalRuleJson(releaseMetadata(release))) !==
        trust.releaseDigest
      ) {
        slot.code = 'RULE_RELEASE_HASH_MISMATCH';
        continue;
      }
      slot.release = freeze(release);
      slot.code = null;
    }
  }
  catalog(): RuleCatalogEntry[] {
    return [
      ...SHARED_SKILL_IDS.map((skillId) => {
        const slot = this.#slots.get(skillId)!;
        const release = slot.release;
        const trust = slot.trust;
        return {
          skillId,
          version: release?.version ?? trust?.version ?? null,
          ruleVersion: release?.ruleVersion ?? trust?.ruleVersion ?? null,
          name: names[skillId],
          description:
            release?.description ??
            '该 Skill 的已配置发行规则目前不可用；平台其他业务保持可用。',
          configured: slot.configured,
          sourceVerified: Boolean(release),
          availability: release
            ? ('available' as const)
            : ('unavailable' as const),
          releaseDigest: release?.releaseDigest ?? trust?.releaseDigest ?? null,
          manifestSha256:
            release?.manifestSha256 ?? trust?.manifestSha256 ?? null,
          sourceArchives: structuredClone(
            release?.sourceArchives ?? trust?.sourceArchives ?? [],
          ),
          sections:
            release?.documents.map((doc) => ({
              section: doc.section,
              sha256: doc.sha256,
              bytes: doc.bytes,
            })) ?? [],
          unavailableCode: slot.code,
        };
      }),
      {
        skillId: 'ath-web-execute',
        version: null,
        ruleVersion: null,
        name: '本地 UI 执行',
        description:
          '仅用户本地 AI + Skill + Ego 执行；平台不加载执行器、不启动服务器 UI 测试。',
        configured: false,
        sourceVerified: false,
        availability: 'localOnly',
        releaseDigest: null,
        manifestSha256: null,
        sourceArchives: [],
        sections: [],
        unavailableCode: 'LOCAL_ONLY',
      },
    ];
  }
  pin(): SharedSkillRuleSnapshot {
    const releases = SHARED_SKILL_IDS.map((skillId) => {
      const slot = this.#slots.get(skillId)!;
      const trust = slot.trust;
      const release = slot.release;
      return {
        skillId,
        version: release?.version ?? trust?.version ?? '0.0.0',
        ruleVersion: release?.ruleVersion ?? trust?.ruleVersion ?? '0.0.0',
        releaseDigest: release?.releaseDigest ?? trust?.releaseDigest ?? null,
        manifestSha256:
          release?.manifestSha256 ?? trust?.manifestSha256 ?? null,
        sourceArchiveHashes: (
          release?.sourceArchives ??
          trust?.sourceArchives ??
          []
        ).map((item) => item.sha256),
        available: Boolean(release),
      };
    });
    const metadata = {
      schemaVersion: 'ath.shared-skill-rule-snapshot.v2' as const,
      releases,
    };
    return freeze({
      ...metadata,
      releaseSetDigest: ruleSha256(canonicalRuleJson(metadata)),
    });
  }
  read(
    snapshot: SharedSkillRuleSnapshot,
    input: { skillId: SharedSkillId; section: RuleSection },
  ): SharedSkillRuleReadReceipt {
    const parsed = sharedSkillRuleSnapshotSchema.safeParse(snapshot);
    const fail = (code: string): SharedSkillRuleReadReceipt => ({
      status: 'unavailable',
      guidanceOnly: true,
      skillId: input.skillId,
      version: parsed.success
        ? (parsed.data.releases.find((item) => item.skillId === input.skillId)
            ?.version ?? null)
        : null,
      releaseSetDigest: parsed.success ? parsed.data.releaseSetDigest : null,
      section: input.section,
      code,
      message:
        '本次任务固定的该 Skill 规则不可用；不要猜测规则或替换版本。其他平台业务可继续。',
    });
    if (!parsed.success) return fail('RULE_SNAPSHOT_INVALID');
    const { releaseSetDigest, ...metadata } = parsed.data;
    if (ruleSha256(canonicalRuleJson(metadata)) !== releaseSetDigest)
      return fail('RULE_SNAPSHOT_INVALID');
    const pinned = parsed.data.releases.find(
      (item) => item.skillId === input.skillId,
    );
    const slot = this.#slots.get(input.skillId);
    if (!pinned || !slot) return fail('RULE_SKILL_UNAVAILABLE');
    if (!pinned.available) return fail('RULE_NOT_AVAILABLE_AT_BINDING');
    const release = slot.release;
    if (!release) return fail(slot.code ?? 'RULE_BUNDLE_MISSING');
    if (
      release.version !== pinned.version ||
      release.ruleVersion !== pinned.ruleVersion ||
      release.releaseDigest !== pinned.releaseDigest ||
      release.manifestSha256 !== pinned.manifestSha256 ||
      canonicalRuleJson(release.sourceArchives.map((item) => item.sha256)) !==
        canonicalRuleJson(pinned.sourceArchiveHashes)
    )
      return fail('RULE_PINNED_RELEASE_UNAVAILABLE');
    const doc = release.documents.find(
      (item) => item.section === input.section,
    );
    if (!doc) return fail('RULE_SECTION_UNAVAILABLE');
    return {
      status: 'loaded',
      guidanceOnly: true,
      skillId: input.skillId,
      version: release.version,
      ruleVersion: release.ruleVersion,
      releaseSetDigest,
      releaseDigest: release.releaseDigest,
      manifestSha256: release.manifestSha256,
      section: doc.section,
      sha256: doc.sha256,
      bytes: doc.bytes,
      text: doc.text,
      contentState: 'full',
      sourceArchives: structuredClone(release.sourceArchives),
    };
  }
  catalogText(snapshot: SharedSkillRuleSnapshot): string {
    if (!sharedSkillRuleSnapshotSchema.safeParse(snapshot).success) {
      return '当前任务的 Skill 规则绑定元数据无效，平台 Skill 指引不可用。不得猜测、换版或授予能力；其他获准平台业务可继续。ath-web-execute 仅本地执行。';
    }
    const entries = this.catalog()
      .filter((entry) => entry.skillId !== 'ath-web-execute')
      .map((entry) => {
        const pinned = snapshot.releases.find(
          (item) => item.skillId === entry.skillId,
        );
        const available =
          this.read(snapshot, {
            skillId: entry.skillId as SharedSkillId,
            section: 'entry',
          }).status === 'loaded';
        return `${entry.skillId} @ ${pinned?.version ?? 'unbound'} (${available ? 'available' : 'unavailable'}; release ${pinned?.releaseDigest ?? 'none'}): ${available ? entry.description : entry.name + '的任务固定发行规则不可用，请勿换版或猜测规则。'}\nsections: ${available ? entry.sections.map((item) => item.section).join(', ') : '(unavailable)'}`;
      });
    return `受控 Skill 规则目录（仅指引，不授予权限；正文尚未加载）。按需调用 ath_skill_rules_read，先 entry 再相关 section；当前业务工具权限和服务端规则始终有效。规则里的本地脚本/工作目录用法不赋予平台文件、Shell或执行能力，平台业务始终调用当前获准工具。\n${entries.join('\n')}\nath-web-execute: local-only。UI 执行由用户本地 AI + Skill + Ego 负责，平台不执行。`;
  }
}
let current: SharedSkillRuleRegistry | undefined;
export function getSharedSkillRuleRegistry(): SharedSkillRuleRegistry {
  return (current ??= new SharedSkillRuleRegistry(
    sharedSkillRuleArtifact,
    sharedSkillRuleTrust,
  ));
}
