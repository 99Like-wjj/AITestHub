import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { AuxiliarySourceInput } from '../../../contracts/src/auxiliary.js';
import {
  auxiliarySourceMetaSchema,
  auxiliaryMaterialStructuralLimit,
} from '../../../contracts/src/auxiliary.js';
import { apiCaseContentSchema } from '../../../contracts/src/domain.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { conversationRow, personalActor } from '../conversations/common.js';
import { DomainError, stale } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';
import type { PersonalFileReader } from '../conversations/references.js';
import {
  materialSchema,
  materialInputSchema,
} from '../../../contracts/src/domain.js';
import { sanitizeSourceLinkFields } from '../../../contracts/src/source-links.js';
import { frozenConversationReferenceSchema } from '../../../contracts/src/conversations.js';

export const auxiliarySourceSnapshotSchema = z.strictObject({
  materialSources: z
    .array(
      z.strictObject({
        candidateId: z.uuid().nullable(),
        materials: z.array(materialInputSchema.or(materialSchema)),
      }),
    )
    .optional(),
  parentSources: z.array(frozenConversationReferenceSchema).optional(),
  meta: auxiliarySourceMetaSchema,
  payload: z.json(),
  candidateIds: z.array(z.uuid()).max(200),
});
/** Exact frozen version, current authorization. No account/credential/config secret is a model source. */
export async function authorizeAuxiliarySource(
  tx: SqlExecutor,
  actor: ActorContext,
  input: AuxiliarySourceInput,
) {
  if (input.purpose === 'alias') {
    await personalActor(tx, actor, true);
    if (!input.conversationId) {
      const projectId = z.uuid().parse(input.projectId),
        requirementId = z.uuid().parse(input.requirementId);
      await requireProject(tx, actor, projectId, 'project.read');
      const group = (
        await tx.query<{ row_version: number; formal_title: string }>(
          `SELECT g.row_version,r.title formal_title FROM app.ai_requirement_groups g JOIN app.requirements r ON r.id=g.requirement_id AND r.project_id=g.project_id
      JOIN app.requirement_participants rp ON rp.requirement_id=r.id AND rp.project_id=r.project_id AND rp.user_id=g.owner_id AND rp.active WHERE g.owner_id=$1 AND g.project_id=$2 AND g.requirement_id=$3 FOR SHARE OF r`,
          [actor.userId, projectId, requirementId],
        )
      ).rows[0];
      if (!group)
        throw new DomainError(
          'NOT_FOUND',
          '没有此本人当前参与的需求分组。',
          404,
        );
      return group;
    }
    const conversation = await conversationRow(
      tx,
      actor,
      input.conversationId,
      false,
      true,
    );
    return conversation;
  }
  await requireProject(
    tx,
    actor,
    input.projectId,
    input.purpose === 'requirementLookup'
      ? 'requirements.write'
      : input.purpose === 'sqlReview'
        ? 'assets.write'
        : 'project.read',
  );
  if (
    input.purpose === 'requirementLookup' &&
    input.materials?.some((material) => material.fileResourceId)
  ) {
    await requireProject(tx, actor, input.projectId, 'files.transfer');
    const ids = input.materials.flatMap((material) =>
      material.fileResourceId ? [material.fileResourceId] : [],
    );
    const readable = await tx.query(
      "SELECT id FROM app.file_resources WHERE id=ANY($1::uuid[]) AND owner_scope='project' AND project_id=$2 AND status='verified' AND deleted_at IS NULL FOR SHARE",
      [Array.from(new Set(ids)), input.projectId],
    );
    if (readable.rowCount !== new Set(ids).size)
      throw new DomainError(
        'FILE_NOT_READY',
        '本次材料须为当前Key有权读取的同项目已验证文件；个人/跨项目/已删资源不作为查重资料。',
        422,
      );
  }
  if (
    input.purpose === 'issueAdvice' &&
    !(
      await tx.query('SELECT 1 FROM app.issues WHERE project_id=$1 AND id=$2', [
        input.projectId,
        input.issueId,
      ])
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目没有该正式缺陷。', 404);
  if (
    input.purpose === 'sqlReview' &&
    !(
      await tx.query(
        `SELECT 1 FROM app.test_assets a JOIN app.asset_revisions v ON v.asset_id=a.id
  WHERE a.project_id=$1 AND a.id=$2 AND v.id=$3 AND a.kind='API' AND a.target_type='case'`,
        [input.projectId, input.caseId, input.caseRevisionId],
      )
    ).rowCount
  )
    throw new DomainError('NOT_FOUND', '此项目没有该接口用例修订。', 404);
  return null;
}
export async function freezeAuxiliarySource(
  tx: SqlExecutor,
  actor: ActorContext,
  input: AuxiliarySourceInput,
) {
  const conversation = await authorizeAuxiliarySource(tx, actor, input);
  let snapshot: unknown;
  if (input.purpose === 'alias') {
    if (conversation?.row_version !== input.baseRowVersion) stale();
    snapshot = {
      meta: {
        kind: input.conversationId ? 'conversation' : 'requirementGroup',
        projectId: input.conversationId ? null : input.projectId,
        objectId: input.conversationId ?? input.requirementId,
        conversationId: input.conversationId ?? null,
        revisionId: null,
        rowVersion: input.baseRowVersion,
        truncated: false,
      },
      payload: {
        text: input.conversationId
          ? input.text
          : 'formal_title' in conversation!
            ? conversation.formal_title
            : '',
      },
      candidateIds: [],
    };
  } else if (input.purpose === 'requirementLookup') {
    const rows = (
      await tx.query<{
        id: string;
        title: string;
        business_number: string | null;
        summary: string;
        version_id: string;
        materials: unknown;
      }>(
        `SELECT r.id,r.title,r.business_number,v.id version_id,v.summary,v.materials FROM app.requirements r JOIN LATERAL (SELECT id,summary,materials FROM app.requirement_versions WHERE requirement_id=r.id ORDER BY version_no DESC LIMIT 1) v ON true WHERE r.project_id=$1 ORDER BY r.business_updated_at DESC,r.id LIMIT 201 FOR SHARE OF r`,
        [input.projectId],
      )
    ).rows;
    const candidates = rows.slice(0, 200).map((r) => ({
      requirementId: r.id,
      title: r.title,
      businessNumber: r.business_number,
      summary: r.summary.slice(0, 1000),
      requirementVersionId: r.version_id,
    }));
    snapshot = {
      meta: {
        kind: 'requirementDraft',
        projectId: input.projectId,
        objectId: null,
        conversationId: null,
        revisionId: null,
        truncated:
          rows.length > 200 || rows.some((row) => row.summary.length > 1000),
      },
      payload: {
        title: input.title,
        businessNumber: input.businessNumber,
        summary: input.summary,
        candidates,
      },
      candidateIds: candidates.map((c) => c.requirementId),
      materialSources: [
        { candidateId: null, materials: input.materials ?? [] },
        ...rows.slice(0, 200).map((row) => ({
          candidateId: row.id,
          materials: materialSchema
            .array()
            .parse(
              sanitizeSourceLinkFields({ materials: row.materials }).materials,
            ),
        })),
      ],
    };
  } else if (input.purpose === 'sqlReview') {
    const row = (
      await tx.query<{ content: unknown }>(
        'SELECT content FROM app.asset_revisions WHERE asset_id=$1 AND id=$2',
        [input.caseId, input.caseRevisionId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '没有此接口用例修订。', 404);
    const content = apiCaseContentSchema.parse(row.content);
    const step =
      content.cleanup.mode === 'none'
        ? null
        : content.cleanup.steps.find(
            (s) => s.cleanupStepId === input.cleanupStepId && s.type === 'sql',
          );
    if (!step || step.type !== 'sql')
      throw new DomainError('NOT_FOUND', '所选修订中没有该SQL清理步骤。', 404);
    snapshot = {
      meta: {
        kind: 'caseRevision',
        projectId: input.projectId,
        objectId: input.caseId,
        conversationId: null,
        revisionId: input.caseRevisionId,
        truncated: false,
      },
      payload: {
        title: content.title,
        testPoint: content.testPoint,
        driver: step.driver,
        statement: step.statement,
        parameters: step.parameters,
        requiredTargets: step.requiredTargets,
      },
      candidateIds: [],
    };
  } else {
    const issue = (
      await tx.query<{
        title: string;
        description: string;
        severity: string;
        row_version: number;
      }>(
        'SELECT title,description,severity,row_version FROM app.issues WHERE project_id=$1 AND id=$2',
        [input.projectId, input.issueId],
      )
    ).rows[0];
    if (!issue)
      throw new DomainError('NOT_FOUND', '此项目没有该正式缺陷。', 404);
    snapshot = {
      meta: {
        kind: 'issue',
        projectId: input.projectId,
        objectId: input.issueId,
        conversationId: null,
        revisionId: null,
        rowVersion: issue.row_version,
        truncated: issue.description.length > 24000,
      },
      payload: {
        title: issue.title,
        description: issue.description.slice(0, 24000),
        severity: issue.severity,
        rowVersion: issue.row_version,
        mode: input.mode,
      },
      candidateIds: [],
    };
  }
  const validated = auxiliarySourceSnapshotSchema.parse(snapshot);
  assertSafeModelInput(validated);
  return validated;
}

/** Read outside SQL transactions; callers freeze/recheck metadata and current permission before accepting. */
export async function hydrateAuxiliarySource(
  actor: ActorContext,
  input: AuxiliarySourceInput,
  source: z.infer<typeof auxiliarySourceSnapshotSchema>,
  reader?: PersonalFileReader,
) {
  if (input.purpose !== 'requirementLookup') return source;
  const notes: string[] = [],
    texts: {
      candidateId: string | null;
      materials: { name: string; text: string | null; state: string }[];
    }[] = [];
  let remaining = 100000,
    count = 0;
  const cache = new Map<
    string,
    Awaited<ReturnType<PersonalFileReader['readText']>>
  >();
  for (const group of source.materialSources ?? []) {
    if (!group.materials.length)
      notes.push(
        `${group.candidateId ?? '当前草稿'}: 未提供原文材料，仅有名称/摘要`,
      );
    const materials = [];
    for (const material of group.materials) {
      if (count++ >= 400) {
        notes.push(
          `${group.candidateId ?? '当前草稿'}: 材料读取数量上限，存在未读取原件`,
        );
        break;
      }
      let text: string | null = null,
        state = 'unsupported';
      if (material.fileResourceId && reader && remaining > 0) {
        const result =
          cache.get(material.fileResourceId) ??
          (await reader.readText(actor, material.fileResourceId));
        cache.set(material.fileResourceId, result);
        text = result.text;
        state = result.state;
        if (text && text.length > remaining) {
          text = text.slice(0, remaining);
          state = 'incomplete';
        }
        remaining -= text?.length ?? 0;
      }
      if (state !== 'readable')
        notes.push(
          `${group.candidateId ?? '当前草稿'} / ${material.originalName}: ${material.sourceLink ? '链接未抓取' : state === 'incomplete' ? '仅部分正文' : '未读取正文'}`,
        );
      materials.push({ name: material.originalName, text, state });
    }
    texts.push({ candidateId: group.candidateId, materials });
  }
  const current = texts.find((group) => group.candidateId === null),
    payload = z.record(z.string(), z.json()).parse(source.payload);
  source.payload = {
    ...payload,
    materials: current?.materials ?? [],
    candidateMaterials: texts.filter((group) => group.candidateId !== null),
  };
  source.meta.truncated = source.meta.truncated || notes.length > 0;
  source.meta.unreadMaterials =
    notes.length > auxiliaryMaterialStructuralLimit
      ? [
          ...notes.slice(0, auxiliaryMaterialStructuralLimit - 1),
          `另有${notes.length - auxiliaryMaterialStructuralLimit + 1}项未读说明未列出；本次材料读取或上下文范围不完整，不能据此认定没有重复。`,
        ]
      : notes;
  assertSafeModelInput(source);
  return source;
}
export async function assertAuxiliaryMaterialAccess(
  tx: SqlExecutor,
  actor: ActorContext,
  input: AuxiliarySourceInput,
  source: z.infer<typeof auxiliarySourceSnapshotSchema>,
) {
  const ids = [
    ...new Set(
      (source.materialSources ?? []).flatMap((group) =>
        group.materials.flatMap((material) =>
          material.fileResourceId ? [material.fileResourceId] : [],
        ),
      ),
    ),
  ];
  if (!ids.length) return;
  if (!('projectId' in input) || !input.projectId)
    throw new DomainError('FORBIDDEN', '材料必须属于本项目。', 403);
  await requireProject(tx, actor, input.projectId, 'files.transfer');
  const rows = await tx.query(
    "SELECT id FROM app.file_resources WHERE id=ANY($1::uuid[]) AND owner_scope='project' AND project_id=$2 AND status='verified' AND deleted_at IS NULL FOR SHARE",
    [ids, input.projectId],
  );
  if (rows.rowCount !== ids.length)
    throw new DomainError(
      'FILE_NOT_READY',
      '比较材料包含不可读、跨项目或已删除文件。',
      422,
    );
}
