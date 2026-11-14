import type { ActorContext } from '../../../contracts/src/identity.js';
import {
  resourceCapabilityQuerySchema,
  fileResourceCapabilitiesSchema,
} from '../../../contracts/src/file-resources.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { currentUser, requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { runtimeResourceCapabilities } from '../resource-policy/capabilities.js';
import type {
  FilePolicySnapshot,
  FileResourcePolicies,
  FilePolicyIntent,
} from './resource-policy.js';

/** No policy writer or arbitrary identity lookup: callers resolve actual authorized business records. */
export async function readFileResourceCapabilities(
  db: Pick<Database, 'transaction'>,
  policies: FileResourcePolicies,
  actor: ActorContext,
  raw: unknown,
  ownFilePolicy: (
    tx: SqlExecutor,
    fileId: string,
  ) => Promise<FilePolicySnapshot>,
) {
  const query = resourceCapabilityQuerySchema.parse(raw);
  return db.transaction(async (tx) => {
    let policy: FilePolicySnapshot;
    if (query.target === 'personal') {
      await currentUser(tx, actor);
      if (actor.entrypoint !== 'web' || actor.keyId)
        throw new DomainError('FORBIDDEN', '个人文件能力仅本人Web可读。', 403);
      policy = await policies.read(tx);
    } else if (query.target === 'file')
      policy = await ownFilePolicy(tx, query.fileId);
    else if (query.target === 'active') {
      await requireProject(tx, actor, query.projectId, 'files.transfer');
      policy = await policies.read(tx);
    } else {
      await requireProject(tx, actor, query.projectId, 'results.submit');
      if (query.target === 'newSubmission') policy = await policies.read(tx);
      else {
        const run = (
          await tx.query<{ created_by: string; kind: string }>(
            'SELECT created_by,kind FROM app.runs WHERE project_id=$1 AND id=$2',
            [query.projectId, query.runId],
          )
        ).rows[0];
        if (!run || run.created_by !== actor.userId || run.kind !== 'UI')
          throw new DomainError(
            'NOT_FOUND',
            '没有本人的该本地UI受理身份。',
            404,
          );
        let row: { digest: string } | undefined,
          namespace: FilePolicyIntent['namespace'],
          key: string;
        if (query.target === 'uiBatch') {
          row = (
            await tx.query<{ digest: string }>(
              'SELECT semantic_digest digest FROM app.ui_delivery_batches WHERE project_id=$1 AND run_id=$2 AND owner_id=$3 AND batch_id=$4',
              [query.projectId, query.runId, actor.userId, query.batchId],
            )
          ).rows[0];
          namespace = 'ui.batch';
          key = query.batchId;
        } else if (query.target === 'uiDescriptor') {
          row = (
            await tx.query<{ digest: string }>(
              'SELECT semantic_digest digest FROM app.ui_result_descriptors WHERE project_id=$1 AND run_id=$2 AND owner_id=$3 AND descriptor_id=$4',
              [query.projectId, query.runId, actor.userId, query.descriptorId],
            )
          ).rows[0];
          namespace = 'ui.descriptor';
          key = `${query.runId}:${query.descriptorId}`;
        } else {
          row = (
            await tx.query<{ digest: string }>(
              'SELECT semantic_digest digest FROM app.result_submissions WHERE run_id=$1 AND actor_id=$2 AND submission_id=$3',
              [query.runId, actor.userId, query.submissionId],
            )
          ).rows[0];
          namespace = 'results.submit';
          key = query.submissionId;
        }
        if (!row)
          throw new DomainError('NOT_FOUND', '没有该实际受理回执。', 404);
        policy = await policies.read(tx, {
          ownerId: actor.userId,
          projectId: query.projectId,
          namespace,
          key,
          payloadDigest: row.digest,
          existing: true,
        });
      }
    }
    return fileResourceCapabilitiesSchema.parse({
      schemaVersion: 'ath.file-capabilities.v1',
      subject: query,
      policy: {
        source: policy.source,
        revisionId:
          policy.source === 'legacyDefault' ? null : policy.revisionId,
        digest: policy.digest,
      },
      limits: policy.policy.files,
      binary: {
        maxFileBytes: runtimeResourceCapabilities.maxFileBytes,
        maxSubmissionBytes: runtimeResourceCapabilities.maxSubmissionBytes,
        maxFilesPerBatch: runtimeResourceCapabilities.maxFilesPerBatch,
      },
      sourceJsonMaxBytes: '16777216',
      maxEvidenceRefsPerCase: 1000,
      sourceJsonConsumesEvidenceSlot: false,
      readOnly: true,
      policyOverrideAccepted: false,
    });
  });
}
