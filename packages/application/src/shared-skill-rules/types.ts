export const SHARED_SKILL_IDS = [
  'ath-case-design',
  'ath-project-knowledge',
  'ath-api-regression',
] as const;
export type SharedSkillId = (typeof SHARED_SKILL_IDS)[number];
export const SHARED_SKILL_RULE_TOOL_NAME = 'ath_skill_rules_read' as const;
export type RuleSection =
  | 'entry'
  | 'business-rules'
  | 'coverage'
  | 'contracts'
  | 'review'
  | 'platform-adapter'
  | 'content-and-sources'
  | 'platform-workflow'
  | 'runtime'
  | 'generation'
  | 'native-api'
  | 'maintenance-and-recovery'
  | 'platform-debug';
export interface RuleDocument {
  section: RuleSection;
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}
export interface RuleArchive {
  kind: 'zip' | 'tgz';
  fileName: string;
  sha256: string;
  bytes: number;
}
export interface RuleRelease {
  skillId: SharedSkillId;
  version: string;
  ruleVersion: string;
  name: string;
  description: string;
  sourceArchives: RuleArchive[];
  manifestSha256: string;
  licenseSha256: string;
  license: 'MIT';
  compatibleContracts: string[];
  documents: RuleDocument[];
  releaseDigest: string;
}
export interface RuleReleaseTrust {
  skillId: SharedSkillId;
  version: string;
  ruleVersion: string;
  releaseDigest: string | null;
  sourceArchives: RuleArchive[];
  manifestSha256: string | null;
}
export interface RuleArtifactSlot {
  skillId: SharedSkillId;
  configured: boolean;
  release: RuleRelease | null;
  unavailableCode: string | null;
}
export interface RuleArtifact {
  schemaVersion: 'ath.shared-skill-rule-artifact.v1';
  slots: RuleArtifactSlot[];
}
export interface RuleTaskRelease {
  skillId: SharedSkillId;
  version: string;
  ruleVersion: string;
  releaseDigest: string | null;
  manifestSha256: string | null;
  sourceArchiveHashes: string[];
  available: boolean;
}
export type { SharedSkillRuleSnapshot } from '../../../contracts/src/skill-guidance.js';
export interface RuleCatalogEntry {
  skillId: SharedSkillId | 'ath-web-execute';
  version: string | null;
  ruleVersion: string | null;
  name: string;
  description: string;
  configured: boolean;
  sourceVerified: boolean;
  availability: 'available' | 'unavailable' | 'localOnly';
  releaseDigest: string | null;
  manifestSha256: string | null;
  sourceArchives: RuleArchive[];
  sections: { section: RuleSection; sha256: string; bytes: number }[];
  unavailableCode: string | null;
}
export interface LoadedRuleReceipt {
  status: 'loaded';
  guidanceOnly: true;
  skillId: SharedSkillId;
  version: string;
  ruleVersion: string;
  releaseSetDigest: string;
  releaseDigest: string;
  section: RuleSection;
  sha256: string;
  bytes: number;
  text: string;
  contentState: 'full';
  manifestSha256: string;
  sourceArchives: RuleArchive[];
}
export interface UnavailableRuleReceipt {
  status: 'unavailable';
  guidanceOnly: true;
  skillId: SharedSkillId;
  version: string | null;
  releaseSetDigest: string | null;
  section: RuleSection;
  code: string;
  message: string;
}
export type SharedSkillRuleReadReceipt =
  LoadedRuleReceipt | UnavailableRuleReceipt;
export type SharedSkillRuleReadMetadata =
  Omit<LoadedRuleReceipt, 'text'> | UnavailableRuleReceipt;
