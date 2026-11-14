import { z } from 'zod';
import {
commandIdSchema,
decimalCountSchema,
idSchema,
sha256Schema,
} from './base.js';

// These are representation/defensive bounds, not the deployment's resource budget.
// Existing consumers must separately advertise the limits they can actually enforce.
const maximumStoredByteCount = 9_223_372_036_854_775_807n;
const positiveStoredInteger = (value: string): boolean =>
  value.length <= 19 &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  BigInt(value) > 0n &&
  BigInt(value) <= maximumStoredByteCount;
export const resourceByteCountSchema = decimalCountSchema
  .max(19)
  .refine(
    positiveStoredInteger,
    'Expected a positive signed-bigint byte count.',
  );
const slotCountSchema = z.number().int().min(1).max(1024);
const fileCountSchema = z.number().int().min(1).max(100_000);

/** Trusted operations document. This is deliberately not a business-tool input. */
export const resourcePolicyDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal('ath.resource-policy.v1'),
    files: z.strictObject({
      maxFileBytes: resourceByteCountSchema,
      maxSubmissionBytes: resourceByteCountSchema,
      maxFilesPerBatch: fileCountSchema,
    }),
    tasks: z.strictObject({
      maxApiRuns: slotCountSchema,
      maxAiTasks: slotCountSchema,
    }),
    capacity: z.strictObject({
      warnBelowBytes: resourceByteCountSchema,
      restrictBelowBytes: resourceByteCountSchema,
      largeUploadFromBytes: resourceByteCountSchema,
      sampleMaxAgeMs: z.number().int().min(1000).max(3_600_000),
    }),
  })
  .superRefine((policy, context) => {
    if (
      resourceByteCountSchema.safeParse(policy.capacity.warnBelowBytes)
        .success &&
      resourceByteCountSchema.safeParse(policy.capacity.restrictBelowBytes)
        .success &&
      BigInt(policy.capacity.warnBelowBytes) <=
        BigInt(policy.capacity.restrictBelowBytes)
    )
      context.addIssue({
        code: 'custom',
        path: ['capacity', 'warnBelowBytes'],
        message: 'Warning threshold must exceed the restriction threshold.',
      });
  });

export type ResourcePolicyDocument = z.infer<
  typeof resourcePolicyDocumentSchema
>;
export type ImmutableResourcePolicy = {
  readonly schemaVersion: ResourcePolicyDocument['schemaVersion'];
  readonly files: Readonly<ResourcePolicyDocument['files']>;
  readonly tasks: Readonly<ResourcePolicyDocument['tasks']>;
  readonly capacity: Readonly<ResourcePolicyDocument['capacity']>;
};

export const resourcePolicyHeadIdentitySchema = z.strictObject({
  revisionId: idSchema,
  activationVersion: decimalCountSchema.max(19).refine(positiveStoredInteger),
  digest: sha256Schema,
});
export type ResourcePolicyHeadIdentity = z.infer<
  typeof resourcePolicyHeadIdentitySchema
>;

export interface ResourcePolicySnapshot {
  readonly revisionId: string;
  readonly digest: string;
  readonly policy: ImmutableResourcePolicy;
}
export interface ActiveResourcePolicy extends ResourcePolicySnapshot {
  readonly activationVersion: string;
}

/** The binary/contract capabilities are supplied by trusted host code, never a model. */
export const resourcePolicyCapabilitiesSchema = z.strictObject({
  maxFileBytes: resourceByteCountSchema,
  maxSubmissionBytes: resourceByteCountSchema,
  maxFilesPerBatch: fileCountSchema,
  maxApiRuns: slotCountSchema,
  maxAiTasks: slotCountSchema,
});
export type ResourcePolicyCapabilities = z.infer<
  typeof resourcePolicyCapabilitiesSchema
>;

export const defaultResourcePolicy: ImmutableResourcePolicy = Object.freeze({
  schemaVersion: 'ath.resource-policy.v1',
  files: Object.freeze({
    maxFileBytes: '104857600',
    maxSubmissionBytes: '1073741824',
    maxFilesPerBatch: 100,
  }),
  tasks: Object.freeze({ maxApiRuns: 2, maxAiTasks: 2 }),
  capacity: Object.freeze({
    warnBelowBytes: '21474836480',
    restrictBelowBytes: '10737418240',
    largeUploadFromBytes: '10485760',
    sampleMaxAgeMs: 120_000,
  }),
});

// Resource tuning never changes these product rules. They are not configurable fields.
export const resourcePolicyInvariants = Object.freeze({
  apiCaseConcurrency: 1,
  businessRequestAutomaticRetries: 0,
  cleanupAutomaticRetries: 0,
  uploadMode: 'full-retransmit',
} as const);

/** Consumed only by the trusted local operations application service. */
export const activateResourcePolicySchema = z.strictObject({
  commandId: commandIdSchema,
  expectedHead: resourcePolicyHeadIdentitySchema,
  document: resourcePolicyDocumentSchema,
  documentDigest: sha256Schema,
});
export const resourcePolicyActivationReceiptSchema = z.strictObject({
  activationId: idSchema,
  commandId: commandIdSchema,
  previousHead: resourcePolicyHeadIdentitySchema,
  activatedHead: resourcePolicyHeadIdentitySchema,
});
export type ResourcePolicyActivationReceipt = z.infer<
  typeof resourcePolicyActivationReceiptSchema
>;
