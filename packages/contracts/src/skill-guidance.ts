import { z } from 'zod';

export const platformGuidanceSkillIdSchema = z.enum([
  'ath-case-design',
  'ath-project-knowledge',
]);
export type PlatformGuidanceSkillId = z.infer<
  typeof platformGuidanceSkillIdSchema
>;
const ruleVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const ruleDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedSkillRuleSectionSchema = z.enum([
  'entry',
  'business-rules',
  'coverage',
  'contracts',
  'review',
  'platform-adapter',
  'content-and-sources',
  'platform-workflow',
  'runtime',
]);
const ruleArchiveMetadataSchema = z.strictObject({
  kind: z.enum(['zip', 'tgz']),
  fileName: z.string().regex(/^[a-z0-9.-]+$/),
  sha256: ruleDigestSchema,
  bytes: z.number().int().nonnegative(),
});
/** Same metadata contract used at task pinning and the authenticated event boundary. */
export const sharedSkillRuleSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('ath.shared-skill-rule-snapshot.v1'),
  releaseSetDigest: ruleDigestSchema,
  releases: z
    .array(
      z.strictObject({
        skillId: platformGuidanceSkillIdSchema,
        version: ruleVersionSchema,
        ruleVersion: ruleVersionSchema,
        releaseDigest: ruleDigestSchema.nullable(),
        manifestSha256: ruleDigestSchema.nullable(),
        sourceArchiveHashes: z.array(ruleDigestSchema).max(2),
        available: z.boolean(),
      }),
    )
    .length(2),
});
/** Strict metadata only: rule text, file paths and model reasoning have no fields. */
export const sharedSkillRuleReadMetadataSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('loaded'),
      guidanceOnly: z.literal(true),
      skillId: platformGuidanceSkillIdSchema,
      version: ruleVersionSchema,
      ruleVersion: ruleVersionSchema,
      releaseSetDigest: ruleDigestSchema,
      releaseDigest: ruleDigestSchema,
      section: sharedSkillRuleSectionSchema,
      sha256: ruleDigestSchema,
      bytes: z.number().int().nonnegative(),
      contentState: z.literal('full'),
      manifestSha256: ruleDigestSchema,
      sourceArchives: z.array(ruleArchiveMetadataSchema).min(1).max(2),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      guidanceOnly: z.literal(true),
      skillId: platformGuidanceSkillIdSchema,
      version: ruleVersionSchema.nullable(),
      releaseSetDigest: ruleDigestSchema.nullable(),
      section: sharedSkillRuleSectionSchema,
      code: z.string().regex(/^[A-Z0-9_]{1,100}$/),
      message: z.string().max(2000),
    }),
  ],
);
export const skillGuidanceCatalogSchema = z.strictObject({
  guidanceOnly: z.literal(true),
  skills: z
    .array(
      z.strictObject({
        skillId: z.enum([
          ...platformGuidanceSkillIdSchema.options,
          'ath-web-execute',
          'ath-api-regression',
        ]),
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(2000),
        version: z.string().max(100).nullable(),
        availability: z.enum([
          'available',
          'unavailable',
          'localOnly',
          'deferred',
        ]),
        releaseDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        unavailableCode: z.string().max(100).nullable(),
      }),
    )
    .max(4),
});
export type SkillGuidanceCatalog = z.infer<typeof skillGuidanceCatalogSchema>;
