import { createHash } from 'node:crypto';
import {
  resourcePolicyCapabilitiesSchema,
  resourcePolicyDocumentSchema,
  resourcePolicyHeadIdentitySchema,
  type ActiveResourcePolicy,
  type ImmutableResourcePolicy,
  type ResourcePolicyCapabilities,
  type ResourcePolicyHeadIdentity,
} from '../../../contracts/src/resource-policy.js';
import { DomainError } from '../errors.js';

/** Fixed ordering is part of this document version; caller object ordering is irrelevant. */
export function canonicalResourcePolicy(raw: unknown): string {
  const policy = resourcePolicyDocumentSchema.parse(raw);
  return JSON.stringify({
    capacity: {
      largeUploadFromBytes: policy.capacity.largeUploadFromBytes,
      restrictBelowBytes: policy.capacity.restrictBelowBytes,
      sampleMaxAgeMs: policy.capacity.sampleMaxAgeMs,
      warnBelowBytes: policy.capacity.warnBelowBytes,
    },
    files: {
      maxFileBytes: policy.files.maxFileBytes,
      maxFilesPerBatch: policy.files.maxFilesPerBatch,
      maxSubmissionBytes: policy.files.maxSubmissionBytes,
    },
    schemaVersion: policy.schemaVersion,
    tasks: {
      maxAiTasks: policy.tasks.maxAiTasks,
      maxApiRuns: policy.tasks.maxApiRuns,
    },
  });
}

export function resourcePolicyDigest(raw: unknown): string {
  return createHash('sha256')
    .update(canonicalResourcePolicy(raw), 'utf8')
    .digest('hex');
}

export function freezeResourcePolicy(raw: unknown): ImmutableResourcePolicy {
  const parsed = resourcePolicyDocumentSchema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '资源策略无效或版本不支持；未采用本进程默认值。',
      503,
    );
  const policy = parsed.data;
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    files: Object.freeze(policy.files),
    tasks: Object.freeze(policy.tasks),
    capacity: Object.freeze(policy.capacity),
  });
}

/** Refuse an incompatible binary instead of clamping, silently loosening, or falling back. */
export function assertResourcePolicySupported(
  policy: ImmutableResourcePolicy,
  rawCapabilities: ResourcePolicyCapabilities,
): void {
  const parsed = resourcePolicyCapabilitiesSchema.safeParse(rawCapabilities);
  if (!parsed.success)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '运行端资源能力声明无效。',
      503,
    );
  const capabilities = parsed.data;
  const unsupported = (
    [
      [
        'files.maxFileBytes',
        BigInt(policy.files.maxFileBytes),
        BigInt(capabilities.maxFileBytes),
      ],
      [
        'files.maxSubmissionBytes',
        BigInt(policy.files.maxSubmissionBytes),
        BigInt(capabilities.maxSubmissionBytes),
      ],
      [
        'files.maxFilesPerBatch',
        BigInt(policy.files.maxFilesPerBatch),
        BigInt(capabilities.maxFilesPerBatch),
      ],
      [
        'tasks.maxApiRuns',
        BigInt(policy.tasks.maxApiRuns),
        BigInt(capabilities.maxApiRuns),
      ],
      [
        'tasks.maxAiTasks',
        BigInt(policy.tasks.maxAiTasks),
        BigInt(capabilities.maxAiTasks),
      ],
    ] as const
  ).find(([, requested, supported]) => requested > supported);
  if (unsupported)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '当前运行端不能执行有效资源策略；请先完成兼容升级。',
      503,
      { unsupportedLimit: unsupported[0] },
    );
}

export function assertResourcePolicyHead(
  actual: ActiveResourcePolicy,
  rawExpected: ResourcePolicyHeadIdentity,
): void {
  const expected = resourcePolicyHeadIdentitySchema.safeParse(rawExpected);
  if (
    !expected.success ||
    actual.revisionId !== expected.data.revisionId ||
    actual.activationVersion !== expected.data.activationVersion ||
    actual.digest !== expected.data.digest
  )
    throw new DomainError(
      'STALE_BASE_REVISION',
      '资源策略版本已变化；未受理新任务，请重新读取当前策略。',
      412,
    );
}

export type ResourceTaskKind = 'apiRun' | 'aiTask';

/**
 * Pure decision only. The integration must hold the shared DB admission lock, read
 * authoritative active work, and make the claim in the same transaction. This is
 * not a per-process semaphore and does not reserve or release a slot itself.
 */
export function resourceTaskAdmission(
  snapshot: ActiveResourcePolicy,
  kind: ResourceTaskKind,
  activeCount: number,
) {
  if (
    !['apiRun', 'aiTask'].includes(kind) ||
    !Number.isSafeInteger(activeCount) ||
    activeCount < 0
  )
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '无法确认全局在途任务数量；未受理新任务。',
      503,
    );
  const limit =
    kind === 'apiRun'
      ? snapshot.policy.tasks.maxApiRuns
      : snapshot.policy.tasks.maxAiTasks;
  return Object.freeze({
    allowed: activeCount < limit,
    limit,
    activeCount,
    revisionId: snapshot.revisionId,
    digest: snapshot.digest,
  });
}
