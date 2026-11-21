import { LocalClientError } from './errors.js';
import type { ToolPort, ResultPort } from './ports.js';
import { validateComponent } from './contracts.js';

export const localFileBinaryEnvelope = Object.freeze({
  maxFileBytes: '268435456',
  maxSubmissionBytes: '2147483648',
  maxFilesPerBatch: 200,
});
type FileQuery =
  | { target: 'active'; projectId: string }
  | { target: 'personal' }
  | { target: 'file'; fileId: string };
type SubmissionQuery =
  | { target: 'newSubmission'; projectId: string }
  | { target: 'uiBatch'; projectId: string; runId: string; batchId: string }
  | {
      target: 'uiDescriptor';
      projectId: string;
      runId: string;
      descriptorId: string;
    }
  | {
      target: 'v1Submission';
      projectId: string;
      runId: string;
      submissionId: string;
    };
/** The generated current contract validates the full response without stripping. */
export interface FileResourceCapabilities {
  schemaVersion: 'ath.file-capabilities.v1';
  subject: FileQuery | SubmissionQuery;
  policy: {
    source: 'active' | 'accepted';
    revisionId: string | null;
    digest: string;
  };
  limits: {
    maxFileBytes: string;
    maxSubmissionBytes: string;
    maxFilesPerBatch: number;
  };
  binary: {
    maxFileBytes: string;
    maxSubmissionBytes: string;
    maxFilesPerBatch: number;
  };
  sourceJsonMaxBytes: '16777216';
  maxEvidenceRefsPerCase: 1000;
  sourceJsonConsumesEvidenceSlot: false;
  readOnly: true;
  policyOverrideAccepted: false;
}
function sameSubject(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(right);
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => left[key] === right[key])
  );
}
export async function readResourceCapabilities(
  tool: ToolPort,
  result: ResultPort,
  query: FileQuery | SubmissionQuery,
): Promise<FileResourceCapabilities> {
  const file =
    query.target === 'file' ||
    query.target === 'active' ||
    query.target === 'personal';
  const raw = await tool.callTool('ath_file_transfers', {
    op: file ? 'capabilities' : 'submission-capabilities',
    input: query,
  });
  const value = result.read(raw);
  try {
    result.assertSafe(value);
    validateComponent('file-resources.fileResourceCapabilitiesSchema', value);
    const caps = value as FileResourceCapabilities;
    if (
      !sameSubject(caps.subject, query) ||
      (query.target === 'file' && caps.policy.source === 'active') ||
      (caps.policy.source === 'accepted' && !caps.policy.revisionId)
    )
      throw Error('Mismatched policy subject.');
    if (
      BigInt(caps.limits.maxFileBytes) >
        BigInt(localFileBinaryEnvelope.maxFileBytes) ||
      BigInt(caps.limits.maxSubmissionBytes) >
        BigInt(localFileBinaryEnvelope.maxSubmissionBytes) ||
      caps.limits.maxFilesPerBatch > localFileBinaryEnvelope.maxFilesPerBatch
    )
      throw Error('Unsupported binary envelope.');
    return caps;
  } catch {
    throw new LocalClientError(
      'INVALID_RESOURCE_CAPABILITIES',
      'unknown',
      '未取得匹配原身份且本客户端可执行的文件能力元数据；不猜测、降级或扩Key。',
    );
  }
}
