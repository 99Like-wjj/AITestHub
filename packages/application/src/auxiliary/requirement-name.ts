import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  auxiliaryModelSnapshotSchema,
  auxiliaryRequestInputSchema,
} from '../../../contracts/src/auxiliary.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { requireProjectDraftWrite } from '../access/policy.js';
import type { ConfigurationService } from '../configuration/service.js';
import { truncateConversationText } from '../conversations/title.js';
import { DomainError } from '../errors.js';
import { audit } from '../events.js';
import { capacityPolicies } from '../recovery/capacity-policy.js';
import { assertNewWorkAllowed } from '../recovery/maintenance.js';
import type { RequirementNameAdmission } from '../requirements/service.js';
import { assertSafeModelInput } from '../security/model-input.js';
import { automaticDigest, automaticNameHash } from './automatic-common.js';
import {
  auxiliaryModelSnapshot,
  resolveNewAuxiliarySelection,
} from './model-snapshot.js';
import type { AuxiliaryTaskRow } from './service.js';
import { auxiliarySourceSnapshotSchema } from './sources.js';

const dataScope = 'authorizedRelevantTestData';
const intentKey = (id: string) => `requirement-workspace-name:v1:${id}`;
const nameSourceSchema = z.strictObject({
  schemaVersion: z.literal('ath.requirement-workspace-name.v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  originKeyId: z.uuid().nullable(),
});
const modelInput = (title: string, summary: string) => ({
  title,
  summary: truncateConversationText(summary.trim(), 800),
});
const invalidSource = () =>
  new DomainError(
    'PRECONDITIONS_MISSING',
    '需求精简名的原资料或访问权限已变化，侧栏继续使用正式名称。',
    422,
  );

export function isRequirementNameTask(row: AuxiliaryTaskRow) {
  return row.origin === 'background';
}

/** Registers the single background call in the creation transaction. Only a source
 * fingerprint is stored in the task. The worker reads the authorized version. */
export function requirementNameAdmission(
  configuration: ConfigurationService,
  assertCredentialAbsent: (
    selection: { credentialRef: string; modelServiceId: string },
    input: unknown,
    tx: SqlExecutor,
  ) => Promise<void>,
): RequirementNameAdmission {
  return async (tx, actor, requirement, version) => {
    const ready = await tx.query(
      "SELECT 1 FROM pg_attribute WHERE attrelid='app.requirements'::regclass AND attname='workspace_name_task_id' AND NOT attisdropped",
    );
    if (!ready.rowCount) return;

    const input = modelInput(requirement.title, version.summary);
    const taskId = randomUUID();
    let model;
    try {
      await assertNewWorkAllowed(tx, true);
      await capacityPolicies.read(tx);
      const selection = await resolveNewAuxiliarySelection(
        configuration,
        tx,
        actor,
      );
      if (!selection.allowedDataScopes.includes(dataScope))
        throw new DomainError(
          'FORBIDDEN',
          '系统辅助模型没有获准接收项目资料。',
          403,
        );
      assertSafeModelInput(input);
      await assertCredentialAbsent(selection, input, tx);
      model = auxiliaryModelSnapshot(selection);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await audit(
        tx,
        actor,
        'requirement.workspace-name-skipped',
        requirement.id,
        requirement.projectId,
        { errorCode: error.code },
      );
      return;
    }

    const commandId = intentKey(requirement.id);
    const request = auxiliaryRequestInputSchema.parse({
      commandId,
      purpose: 'alias',
      projectId: requirement.projectId,
      requirementId: requirement.id,
      baseRowVersion: requirement.rowVersion,
      text: '生成需求分组名称',
      dataScope,
    });
    const source = auxiliarySourceSnapshotSchema.parse({
      meta: {
        kind: 'requirementName',
        projectId: requirement.projectId,
        objectId: requirement.id,
        revisionId: version.id,
        conversationId: null,
        rowVersion: requirement.rowVersion,
        truncated: input.summary !== version.summary.trim(),
      },
      payload: nameSourceSchema.parse({
        schemaVersion: 'ath.requirement-workspace-name.v1',
        digest: automaticDigest(input),
        originKeyId: actor.keyId ?? null,
      }),
      candidateIds: [],
    });
    await tx.query(
      `INSERT INTO app.auxiliary_tasks(id,owner_id,project_id,command_id,purpose,request,source_snapshot,model_snapshot,origin)
       VALUES($1,$2,$3,$4,'alias',$5,$6,$7,'background')`,
      [
        taskId,
        actor.userId,
        requirement.projectId,
        commandId,
        request,
        source,
        model,
      ],
    );
    await tx.query(
      'UPDATE app.requirements SET workspace_name_task_id=$3 WHERE id=$1 AND project_id=$2',
      [requirement.id, requirement.projectId, taskId],
    );
    await audit(
      tx,
      actor,
      'requirement.workspace-name-accepted',
      requirement.id,
      requirement.projectId,
      { taskId, versionId: version.id },
    );
  };
}

/** Validates the persisted job, original member/key and exact source on each dispatch. */
export async function readRequirementNameInput(
  tx: SqlExecutor,
  row: AuxiliaryTaskRow,
) {
  const source = auxiliarySourceSnapshotSchema.parse(row.source_snapshot);
  const request = auxiliaryRequestInputSchema.parse(row.request);
  const model = auxiliaryModelSnapshotSchema.parse(row.model_snapshot);
  const { meta } = source;
  if (
    !isRequirementNameTask(row) ||
    !row.project_id ||
    row.purpose !== 'alias' ||
    request.purpose !== 'alias' ||
    request.dataScope !== dataScope ||
    !model.allowedDataScopes.includes(dataScope) ||
    meta.kind !== 'requirementName' ||
    meta.projectId !== row.project_id ||
    !meta.objectId ||
    !meta.revisionId ||
    request.projectId !== row.project_id ||
    request.requirementId !== meta.objectId ||
    request.commandId !== row.command_id ||
    row.command_id !== intentKey(meta.objectId)
  )
    throw invalidSource();
  const seal = nameSourceSchema.parse(source.payload);
  const actor: ActorContext = {
    userId: row.owner_id,
    entrypoint: seal.originKeyId ? 'official-mcp' : 'internal-ai',
    ...(seal.originKeyId ? { keyId: seal.originKeyId } : {}),
    requestId: row.id,
  };
  await requireProjectDraftWrite(
    tx,
    actor,
    row.project_id,
    'requirements.write',
  );
  const version = (
    await tx.query<{ title: string; summary: string }>(
      `SELECT r.title,v.summary FROM app.requirements r
       JOIN app.requirement_versions v ON v.requirement_id=r.id AND v.project_id=r.project_id
       WHERE r.id=$1 AND r.project_id=$2 AND r.workspace_name_task_id=$3
         AND v.id=$4 AND v.version_no=1 AND v.created_by=$5 AND r.created_by=$5
         AND r.archived_at IS NULL FOR SHARE OF r`,
      [meta.objectId, row.project_id, row.id, meta.revisionId, row.owner_id],
    )
  ).rows[0];
  if (!version) throw invalidSource();
  const input = modelInput(version.title, version.summary);
  if (automaticDigest(input) !== seal.digest) throw invalidSource();
  assertSafeModelInput(input);
  return { input, requirementId: meta.objectId, projectId: row.project_id };
}

export async function applyRequirementName(
  tx: SqlExecutor,
  row: AuxiliaryTaskRow,
  name: string,
) {
  const source = await readRequirementNameInput(tx, row).catch((error) => {
    if (!(error instanceof DomainError)) throw error;
    return null;
  });
  if (!source) return;
  await tx.query(
    `UPDATE app.requirements SET workspace_name=$4,workspace_name_title_hash=$5
     WHERE id=$1 AND project_id=$2 AND workspace_name_task_id=$3 AND workspace_name IS NULL`,
    [
      source.requirementId,
      source.projectId,
      row.id,
      name,
      automaticNameHash(source.input.title),
    ],
  );
}
