import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  uiCaseDesignDraftSchema,
  type UiCaseDesignDraft,
  type UiCaseImportPreview,
  type UiCaseImportPreviewInput,
} from '../../../contracts/src/ui-case-import.js';
import type { SqlExecutor } from '../../../persistence/src/database.js';
import { DomainError } from '../errors.js';
import { canonicalJson } from '../operations/service.js';
import { currentRequirementMaterialHead } from '../requirements/material-lock.js';

type DraftScene = UiCaseDesignDraft['scenarios'][number];
type PreviewPackage = UiCaseImportPreview['packages'][number];
type PreviewScene = PreviewPackage['scenes'][number];
type ImportAsset = {
  id: string;
  target_type: 'set' | 'scenario' | 'case';
  parent_id: string | null;
  current_revision_id: string;
  row_version: number;
  title: string;
};
const envelope = z.object({ kind: z.unknown(), schemaVersion: z.unknown() });
export const importItemKey = (packageIndex: number, localId: string) =>
  packageIndex + '/' + localId;

function readDraft(text: string): UiCaseDesignDraft | string {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return '文件不是有效的 UTF-8 JSON。';
  }
  const header = envelope.safeParse(json);
  if (header.data?.schemaVersion === 'ath.case-design.outbox.v2')
    return '这是 Skill 的恢复账本，请选择原始 UI 用例草稿。';
  if (header.data?.schemaVersion !== 'ath.case-design.draft.v2')
    return '请选择用例设计 Skill 的 ath.case-design.draft.v2 草稿文件。';
  if (header.data.kind !== 'UI') return '这是接口草稿，请在自动化测试中处理。';
  const parsed = uiCaseDesignDraftSchema.safeParse(json);
  if (!parsed.success) {
    const list = parsed.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join('.'));
    return '草稿有不符合契约的字段：' + list.join('、');
  }
  const draft = parsed.data;
  const nodes = [...draft.sets, ...draft.scenarios, ...draft.cases];
  const ids = new Set(nodes.map((node) => node.localId));
  const existing = nodes.flatMap((node) =>
    node.existing ? [node.existing.id] : [],
  );
  if (ids.size !== nodes.length || new Set(existing).size !== existing.length)
    return '草稿含重复的本地标识或正式对象。';
  const sets = new Set(draft.sets.map(({ localId }) => localId));
  const scenes = new Set(draft.scenarios.map(({ localId }) => localId));
  if (
    draft.scenarios.some((scene) => !sets.has(scene.setLocalId)) ||
    draft.cases.some((item) => !scenes.has(item.scenarioLocalId)) ||
    draft.gaps.some((gap) => gap.localIds.some((id) => !ids.has(id)))
  )
    return '草稿的场景、用例或资料缺口引用了不存在的父项。';
  return draft;
}

function matchesBase(
  asset: ImportAsset | undefined,
  base: NonNullable<DraftScene['existing']>,
) {
  return (
    asset?.current_revision_id === base.baseRevisionId &&
    asset.row_version === base.rowVersion
  );
}

function normalizedTitle(title: string) {
  return title.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export async function inspectUiCaseImport(
  tx: SqlExecutor,
  projectId: string,
  input: UiCaseImportPreviewInput,
) {
  const requirement = (
    await tx.query<{
      material_lock_version_id: string | null;
      archived_at: Date | null;
    }>(
      'SELECT material_lock_version_id,archived_at FROM app.requirements WHERE project_id=$1 AND id=$2',
      [projectId, input.requirementId],
    )
  ).rows[0];
  if (!requirement)
    throw new DomainError('NOT_FOUND', '所选项目中没有该需求。', 404);
  if (requirement.archived_at)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '已归档需求不能导入用例。',
      422,
    );
  const availableBasis =
    requirement.material_lock_version_id ??
    (await currentRequirementMaterialHead(tx, projectId, input.requirementId))
      .id;
  const versions = await tx.query<{ id: string }>(
    'SELECT id FROM app.requirement_versions WHERE project_id=$1 AND requirement_id=$2',
    [projectId, input.requirementId],
  );
  const allowedBasis = new Set(versions.rows.map(({ id }) => id));
  const rows = await tx.query<ImportAsset>(
    `SELECT a.id,a.target_type,a.parent_id,a.current_revision_id,a.row_version,rev.content->>'title' AS title
     FROM app.test_assets a
     JOIN app.requirement_versions v ON v.id=a.requirement_version_id AND v.project_id=a.project_id
     JOIN app.asset_revisions rev ON rev.id=a.current_revision_id
     WHERE a.project_id=$1 AND v.requirement_id=$2 AND a.kind='UI' AND a.removed_at IS NULL
     ORDER BY a.id`,
    [projectId, input.requirementId],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const byTitle = new Map<string, string[]>();
  for (const row of rows.rows) {
    if (row.target_type !== 'scenario') continue;
    const key = normalizedTitle(row.title);
    const ids = byTitle.get(key) ?? [];
    ids.push(row.id);
    byTitle.set(key, ids);
  }
  const mappings = new Map(
    input.mappings.map((entry) => [
      importItemKey(entry.packageIndex, entry.sceneLocalId),
      entry.target,
    ]),
  );
  if (mappings.size !== input.mappings.length)
    throw new DomainError(
      'VALIDATION_ERROR',
      '同一场景只能指定一个导入目标。',
      400,
    );
  const drafts = new Map<number, UiCaseDesignDraft>();
  const seenDrafts = new Set<string>();
  const packages = input.sources.map<PreviewPackage>((source, packageIndex) => {
    const view: PreviewPackage = {
      packageIndex,
      label: source.label,
      errors: [],
      gaps: [],
      scenes: [],
    };
    const draft = readDraft(source.text);
    if (typeof draft === 'string') return { ...view, errors: [draft] };
    drafts.set(packageIndex, draft);
    if (seenDrafts.has(draft.draftId))
      view.errors.push('这个草稿已经出现在前面的文件中。');
    seenDrafts.add(draft.draftId);
    if (
      draft.projectId !== projectId ||
      (draft.requirementId && draft.requirementId !== input.requirementId) ||
      !allowedBasis.has(draft.requirementVersionId)
    )
      view.errors.push('草稿的项目、需求或资料快照与所选目标不一致。');
    if (!draft.cases.length) view.errors.push('草稿里没有可供导入的 UI 用例。');
    view.draftId = draft.draftId;
    view.projectId = draft.projectId;
    if (draft.requirementId) view.requirementId = draft.requirementId;
    view.requirementVersionId = draft.requirementVersionId;
    view.oldBasis =
      allowedBasis.has(draft.requirementVersionId) &&
      draft.requirementVersionId !== availableBasis;
    view.gaps = draft.gaps.map(({ description, blocksSubmission }) => ({
      description,
      blocksSubmission,
    }));
    if (draft.optimizationNotes.length)
      view.gaps.push({
        description: '草稿包含评审优化说明，请通过原评审流程提交说明。',
        blocksSubmission: false,
      });
    const casesByScene = new Map<string, UiCaseDesignDraft['cases']>();
    for (const item of draft.cases) {
      const items = casesByScene.get(item.scenarioLocalId) ?? [];
      items.push(item);
      casesByScene.set(item.scenarioLocalId, items);
    }
    const sets = new Map(draft.sets.map((set) => [set.localId, set]));
    view.scenes = draft.scenarios.map<PreviewScene>((scene) => {
      const problems: string[] = [];
      const set = sets.get(scene.setLocalId);
      const formalSet = set?.existing && byId.get(set.existing.id);
      if (
        set?.existing &&
        (formalSet?.target_type !== 'set' ||
          !matchesBase(formalSet, set.existing))
      )
        problems.push('草稿引用的归属已失效或已变更，请重新生成草稿。');
      if (set?.existing?.action === 'revise')
        problems.push(
          '草稿包含内部归属修订，请通过用例设计 Skill 处理该修订。',
        );
      const matching = byTitle.get(normalizedTitle(scene.title)) ?? [];
      const declared = mappings.get(importItemKey(packageIndex, scene.localId));
      const target =
        declared ??
        (scene.existing || matching.length
          ? undefined
          : { kind: 'new' as const });
      const resolved =
        target?.kind === 'existing' ? byId.get(target.sceneId) : undefined;
      if (!target) problems.push('请明确选择复用场景或另建场景。');
      if (target?.kind === 'existing' && resolved?.target_type !== 'scenario')
        problems.push('所选场景不在此需求的可维护范围。');
      if (
        scene.existing &&
        (scene.existing.id !== resolved?.id ||
          !matchesBase(resolved, scene.existing) ||
          (set?.existing && resolved?.parent_id !== set.existing.id))
      )
        problems.push('请选择草稿指定的原场景，并核对其当前修订。');
      const cases = (casesByScene.get(scene.localId) ?? []).map((item) => {
        const itemProblems = draft.gaps
          .filter(
            (gap) =>
              gap.blocksSubmission &&
              (!gap.localIds.length ||
                gap.localIds.some(
                  (id) =>
                    id === item.localId ||
                    id === scene.localId ||
                    id === scene.setLocalId,
                )),
          )
          .map((gap) => gap.description);
        if (!item.steps?.length || !item.assertions?.length)
          itemProblems.push('缺少可执行步骤或业务断言。');
        const base = item.existing;
        if (base?.action === 'reference')
          itemProblems.push('只引用当前用例，无需导入。');
        if (base?.action === 'revise') {
          const saved = byId.get(base.id);
          if (
            !resolved ||
            saved?.target_type !== 'case' ||
            saved.parent_id !== resolved.id ||
            !matchesBase(saved, base)
          )
            itemProblems.push('请选择原场景，并核对要修订用例的基准。');
        }
        return {
          caseLocalId: item.localId,
          title: item.title,
          testPoint: item.testPoint,
          expected: item.expected,
          problems: itemProblems,
          ...(!itemProblems.length
            ? { action: base ? ('revise' as const) : ('create' as const) }
            : {}),
        };
      });
      return {
        sceneLocalId: scene.localId,
        title: scene.title,
        matchedSceneIds: [
          ...new Set([
            ...matching,
            ...(scene.existing ? [scene.existing.id] : []),
          ]),
        ].filter((id) => byId.get(id)?.target_type === 'scenario'),
        ...(target ? { target } : {}),
        problems,
        cases,
      };
    });
    return view;
  });
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        projectId,
        requirementId: input.requirementId,
        sources: input.sources,
        mappings: input.mappings,
        availableBasis,
        packages,
      }),
    )
    .digest('hex');
  return { drafts, preview: { digest, packages } };
}
