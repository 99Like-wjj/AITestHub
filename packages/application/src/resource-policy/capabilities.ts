import type { ResourcePolicyCapabilities } from '../../../contracts/src/resource-policy.js';

/** Verified binary/structural envelope. This never activates a deployment policy. */
export const runtimeResourceCapabilities: Readonly<ResourcePolicyCapabilities> =
  Object.freeze({
    maxFileBytes: '268435456',
    maxSubmissionBytes: '2147483648',
    maxFilesPerBatch: 200,
    maxApiRuns: 2,
    maxAiTasks: 2,
  });
