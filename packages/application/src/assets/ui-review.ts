import { randomUUID } from 'node:crypto';
import {
  uiCaseReviewStageListSchema,
  uiReviewMeetingStateSchema,
  uiReviewReplySchema,
  uiReviewStartSchema,
  uiReviewUpdateSchema,
  type UiReviewBasis,
  type UiReviewMeetingState,
  type UiReviewOpinion,
  type UiReviewWorkItem,
} from '../../../contracts/src/ui-reviews.js';
import { uiCaseContentSchema } from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError, stale } from '../errors.js';
import { audit } from '../events.js';
import { OperationService } from '../operations/service.js';
import { recordBusinessActivity } from '../requirements/service.js';
import {
  assetDto,
  assetSelect,
  ancestors,
  getAsset,
  lockSet,
  type AssetRow,
} from './repository.js';

interface Room {
  id: string;
  requirement_version_id: string;
  case_ids: string[];
  state: unknown;
  row_version: number;
  created_by: string;
  created_at: Date;
}

function meetingSummary(row: Room, state: UiReviewMeetingState) {
  return {
    id: row.id,
    requirementVersionId: row.requirement_version_id,
    rowVersion: row.row_version,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    caseCount: row.case_ids.length,
    finalized: state.finalized,
  };
}

async function readArchivedReview(
  tx: SqlExecutor,
  projectId: string,
  room: Room,
  state: UiReviewMeetingState,
  assets: AssetRow[],
  caseId?: string,
) {
  if (!state.finalized)
    throw new DomainError(
      'PRECONDITIONS_MISSING',
      '这份评审尚未定稿，请从当前评审入口查看。',
      422,
    );
  if (caseId && !room.case_ids.includes(caseId))
    throw new DomainError('NOT_FOUND', '此用例不在原评审范围。', 404);
  const recorded = new Set(state.scope.map((basis) => basis.revisionId));
  for (const assessment of state.assessments ?? [])
    recorded.add(assessment.revisionId);
  for (const item of state.items) {
    recorded.add(item.basis.revisionId);
    if (item.reply) recorded.add(item.reply.revisionId);
  }
  const { rows } = await tx.query<{
    id: string;
    asset_id: string;
    revision_no: number;
    content: unknown;
  }>(
    `SELECT id,asset_id,revision_no,content FROM app.asset_revisions
     WHERE project_id=$1 AND asset_id=ANY($2::uuid[]) AND id=ANY($3::uuid[])
     ORDER BY asset_id,revision_no`,
    [projectId, room.case_ids, [...recorded]],
  );
  const frozenByCase = new Map(rows.map((row) => [row.asset_id, row]));
  return {
    meeting: meetingSummary(room, state),
    state,
    cases: assets.map((asset) => {
      const frozen = frozenByCase.get(asset.id);
      if (!frozen)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '原评审的用例修订不可读取。',
          422,
        );
      return assetDto({
        ...asset,
        current_revision_id: frozen.id,
        revision_no: frozen.revision_no,
        content: frozen.content,
        review_state: 'pending',
      });
    }),
    revisions: rows
      .filter((row) => row.asset_id === caseId)
      .map((row) => ({
        id: row.id,
        revisionNo: row.revision_no,
        content: uiCaseContentSchema.parse(row.content),
      })),
  };
}

function conflict(message: string): never {
  throw new DomainError('BUSINESS_CONFLICT', message, 409);
}

export function latestUiReviewItems(state: UiReviewMeetingState) {
  const items = new Map<string, UiReviewWorkItem>();
  for (const item of state.items)
    items.set(item.basis.caseId + '/' + item.opinionId, item);
  return [...items.values()];
}
function bindingMatches(
  a: UiReviewBasis,
  b: UiReviewBasis,
  includeRowVersion = false,
) {
  return (
    a.revisionId === b.revisionId &&
    a.scenarioRevisionId === b.scenarioRevisionId &&
    a.setRevisionId === b.setRevisionId &&
    (!includeRowVersion || a.rowVersion === b.rowVersion)
  );
}
function sharedBindingMatches(a: UiReviewBasis, b: UiReviewBasis) {
  return (
    a.scenarioRevisionId === b.scenarioRevisionId &&
    a.setRevisionId === b.setRevisionId
  );
}

function caseReviewRound(state: UiReviewMeetingState, caseId: string) {
  return Math.max(
    state.caseWorkbenchRound ?? 1,
    ...state.items
      .filter((item) => item.basis.caseId === caseId)
      .map((item) => item.round),
  );
}

function currentCaseAssessment(
  state: UiReviewMeetingState,
  current: UiReviewBasis,
) {
  return state.assessments?.findLast(
    (entry) =>
      entry.caseId === current.caseId &&
      entry.revisionId === current.revisionId,
  );
}

function currentCaseReview(
  state: UiReviewMeetingState,
  current: UiReviewBasis,
) {
  return (
    state.noChange.some(
      (basis) =>
        basis.caseId === current.caseId && bindingMatches(basis, current),
    ) ||
    latestUiReviewItems(state).some(
      (item) =>
        item.basis.caseId === current.caseId &&
        item.reply?.revisionId === current.revisionId &&
        sharedBindingMatches(item.basis, current),
    )
  );
}

function caseHasOpenItems(state: UiReviewMeetingState, caseId: string) {
  return latestUiReviewItems(state).some(
    (item) => item.basis.caseId === caseId && item.state !== 'resolved',
  );
}

function pendingCaseReview(
  state: UiReviewMeetingState,
  current: UiReviewBasis,
) {
  return (
    currentCaseReview(state, current) &&
    currentCaseAssessment(state, current)?.outcome !== 'resolved'
  );
}

function makeBasis(asset: AssetRow, chain: AssetRow[]): UiReviewBasis {
  const scene = chain.find((row) => row.target_type === 'scenario');
  const set = chain.find((row) => row.target_type === 'set');
  if (asset.kind !== 'UI' || asset.target_type !== 'case' || !scene || !set)
    throw new DomainError('NOT_FOUND', '该范围内没有此 UI 用例。', 404);
  return {
    caseId: asset.id,
    revisionId: asset.current_revision_id,
    revisionNo: asset.revision_no,
    rowVersion: asset.row_version,
    scenarioRevisionId: scene.current_revision_id,
    setRevisionId: set.current_revision_id,
  };
}

export async function uiMeetingGate(
  tx: SqlExecutor,
  asset: AssetRow,
  chain: AssetRow[],
) {
  const current = makeBasis(asset, chain);
  const rooms = (
    await tx.query<Pick<Room, 'id' | 'state'>>(
      'SELECT id,state FROM app.ui_review_meetings WHERE project_id=$1 AND case_ids @> ARRAY[$2]::uuid[] ORDER BY created_at DESC,id DESC',
      [asset.project_id, asset.id],
    )
  ).rows;
  const reasons: string[] = [];
  const history: Array<{
    meetingId: string;
    opinionId: string;
    round: number;
    revisionId: string;
  }> = [];
  let checkedCurrentReview = false;
  for (const room of rooms) {
    const state = uiReviewMeetingStateSchema.parse(room.state);
    if (!state.finalized) continue;
    const assessment = currentCaseAssessment(state, current);
    if (
      !checkedCurrentReview &&
      state.caseWorkbenchRound &&
      currentCaseReview(state, current)
    ) {
      checkedCurrentReview = true;
      if (assessment?.outcome !== 'resolved')
        reasons.push('请保存当前修订的人工复审通过结论后再批准。');
    }
    if (assessment?.outcome === 'inconclusive')
      reasons.push('当前修订的人工复审结论为无法确认。');
    for (const item of latestUiReviewItems(state).filter(
      (value) => value.basis.caseId === asset.id,
    )) {
      // A past, resolved meeting does not claim that future edits still satisfy it.
      // Its original human decision remains in history. A new revision is pending
      // in the asset service and must still be explicitly approved again.
      if (item.state !== 'resolved') {
        reasons.push('会议意见仍待修改或人工确认。');
      } else if (
        item.decision?.acceptedRevisionId === current.revisionId &&
        sharedBindingMatches(item.basis, current)
      ) {
        history.push({
          meetingId: room.id,
          opinionId: item.opinionId,
          round: item.round,
          revisionId: current.revisionId,
        });
      } else if (!item.decision?.acceptedRevisionId) {
        throw Error('Resolved UI review item has no accepted revision.');
      }
    }
  }
  history.sort((a, b) => a.meetingId.localeCompare(b.meetingId));
  return { reasons: [...new Set(reasons)], history };
}

type UiReviewUpdate = ReturnType<typeof uiReviewUpdateSchema.parse>;
type OpinionInput = Extract<
  UiReviewUpdate,
  { action: 'supplement' }
>['opinion'];

export class UiReviewService {
  readonly operations: OperationService;

  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }

  async stages(
    actor: ActorContext,
    projectId: string,
    requirementVersionId: string | null,
    requirementId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const cases = (
        await tx.query<
          Pick<AssetRow, 'id' | 'current_revision_id' | 'review_state'>
        >(
          `SELECT id,current_revision_id,review_state FROM app.test_assets a
           WHERE project_id=$1 AND ($2::uuid IS NULL OR requirement_version_id=$2) AND kind='UI'
             AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM app.requirement_versions v WHERE v.project_id=a.project_id AND v.id=a.requirement_version_id AND v.requirement_id=$3))
             AND target_type='case' AND removed_at IS NULL
           ORDER BY created_at,id LIMIT 10000`,
          [projectId, requirementVersionId, requirementId ?? null],
        )
      ).rows;
      if (!cases.length) return { items: [] };
      const revisions = new Map(
        cases.map((asset) => [asset.id, asset.current_revision_id]),
      );
      const waiting = new Set<string>();
      const human = new Set<string>();
      const reopened = new Set<string>();
      const uncertain = new Set<string>();
      const states = (
        await tx.query<{ state: unknown }>(
          `SELECT state FROM app.ui_review_meetings m
           WHERE project_id=$1 AND ($2::uuid IS NULL OR requirement_version_id=$2) AND state->>'finalized'='true'
             AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM app.requirement_versions v WHERE v.project_id=m.project_id AND v.id=m.requirement_version_id AND v.requirement_id=$3))`,
          [projectId, requirementVersionId, requirementId ?? null],
        )
      ).rows;
      for (const row of states) {
        const state = uiReviewMeetingStateSchema.parse(row.state);
        for (const basis of state.noChange) {
          if (revisions.get(basis.caseId) !== basis.revisionId) continue;
          human.add(basis.caseId);
          if (
            state.caseWorkbenchRound &&
            currentCaseAssessment(state, basis)?.outcome !== 'resolved'
          )
            reopened.add(basis.caseId);
        }
        for (const entry of latestUiReviewItems(state)) {
          const revisionId = revisions.get(entry.basis.caseId);
          if (
            entry.state === 'waiting' &&
            revisionId === entry.basis.revisionId
          )
            waiting.add(entry.basis.caseId);
          if (
            entry.state === 'returned' &&
            revisionId === entry.reply?.revisionId
          ) {
            human.add(entry.basis.caseId);
            if (state.caseWorkbenchRound) reopened.add(entry.basis.caseId);
          }
        }
        const assessed = new Map<string, string>();
        for (const entry of state.assessments ?? [])
          if (entry.revisionId === revisions.get(entry.caseId))
            assessed.set(entry.caseId, entry.outcome);
        for (const [caseId, outcome] of assessed)
          if (outcome === 'inconclusive') uncertain.add(caseId);
      }
      return uiCaseReviewStageListSchema.parse({
        items: cases.map((asset) => ({
          caseId: asset.id,
          revisionId: asset.current_revision_id,
          stage:
            waiting.has(asset.id) || asset.review_state === 'needsOptimization'
              ? 'needsOptimization'
              : uncertain.has(asset.id) || reopened.has(asset.id)
                ? 'waitingHuman'
                : asset.review_state === 'approved'
                  ? 'approved'
                  : human.has(asset.id) || asset.review_state === 'aiOptimized'
                    ? 'waitingHuman'
                    : 'pending',
        })),
      });
    });
  }

  async list(
    actor: ActorContext,
    projectId: string,
    requirementVersionId: string | null,
    caseId?: string,
    archivedOnly = false,
    requirementId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = (
        await tx.query<Room>(
          `SELECT * FROM app.ui_review_meetings m WHERE project_id=$1 AND ($2::uuid IS NULL OR requirement_version_id=$2)
             AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM app.requirement_versions v WHERE v.project_id=m.project_id AND v.id=m.requirement_version_id AND v.requirement_id=$5))
             AND ($3::uuid IS NULL OR case_ids @> ARRAY[$3]::uuid[])
             AND (NOT $4 OR state->>'finalized'='true')
           ORDER BY created_at DESC,id DESC LIMIT 100`,
          [
            projectId,
            requirementVersionId,
            caseId ?? null,
            archivedOnly,
            requirementId ?? null,
          ],
        )
      ).rows;
      const meetings = rows.map((row) =>
        meetingSummary(row, uiReviewMeetingStateSchema.parse(row.state)),
      );
      const caseVersion =
        requirementVersionId ?? rows[0]?.requirement_version_id;
      if (!caseId || archivedOnly || !caseVersion || !rows.length)
        return { meetings };
      const [asset] = await this.assets(tx, projectId, [caseId], caseVersion);
      if (!asset) return { meetings };
      const basis = makeBasis(asset, await ancestors(tx, asset));
      const candidates = rows.map((row) => ({
        id: row.id,
        state: uiReviewMeetingStateSchema.parse(row.state),
      }));
      const active =
        candidates.find(({ state }) => caseHasOpenItems(state, caseId)) ??
        candidates.find(
          ({ state }) =>
            !state.finalized &&
            state.scope.some(
              (entry) =>
                entry.caseId === caseId && bindingMatches(entry, basis, true),
            ),
        ) ??
        candidates.find(
          ({ state }) =>
            state.finalized &&
            currentCaseReview(state, basis) &&
            (asset.review_state !== 'approved' ||
              (state.caseWorkbenchRound && pendingCaseReview(state, basis))),
        );
      return { meetings, ...(active ? { activeMeetingId: active.id } : {}) };
    });
  }

  async get(
    actor: ActorContext,
    projectId: string,
    id: string,
    caseId?: string,
    archived = false,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const room = await this.room(tx, projectId, id);
      const state = uiReviewMeetingStateSchema.parse(room.state);
      const assets = await this.assets(
        tx,
        projectId,
        room.case_ids,
        room.requirement_version_id,
        true,
      );
      if (archived)
        return readArchivedReview(tx, projectId, room, state, assets, caseId);
      const revisions =
        caseId && room.case_ids.includes(caseId)
          ? await tx.query<{
              id: string;
              revision_no: number;
              content: unknown;
            }>(
              'SELECT id,revision_no,content FROM app.asset_revisions WHERE project_id=$1 AND asset_id=$2 ORDER BY revision_no',
              [projectId, caseId],
            )
          : null;
      return {
        meeting: meetingSummary(room, state),
        state,
        cases: assets.map(assetDto),
        revisions:
          revisions?.rows.map((row) => ({
            id: row.id,
            revisionNo: row.revision_no,
            content: uiCaseContentSchema.parse(row.content),
          })) ?? [],
      };
    });
  }

  async create(actor: ActorContext, projectId: string, raw: unknown) {
    const input = uiReviewStartSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.meeting-create',
      input.commandId,
      input,
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
      },
      async (tx) => {
        const assets = await this.assets(
          tx,
          projectId,
          input.caseIds,
          input.requirementVersionId,
        );
        await this.lockAssets(tx, projectId, assets);
        const refreshed = await this.assets(
          tx,
          projectId,
          input.caseIds,
          input.requirementVersionId,
        );
        const state: UiReviewMeetingState = {
          scope: [],
          noChange: [],
          draftOpinions: [],
          opinions: [],
          items: [],
          finalized: false,
        };
        for (const asset of refreshed)
          state.scope.push(makeBasis(asset, await ancestors(tx, asset)));
        if (input.caseWorkbenchBasis) {
          const [basis] = state.scope;
          if (
            input.caseIds.length !== 1 ||
            !basis ||
            basis.revisionId !== input.caseWorkbenchBasis.revisionId ||
            basis.rowVersion !== input.caseWorkbenchBasis.rowVersion
          )
            stale();
          const existing = (
            await tx.query<Pick<Room, 'state'>>(
              'SELECT state FROM app.ui_review_meetings WHERE project_id=$1 AND case_ids @> ARRAY[$2]::uuid[]',
              [projectId, basis.caseId],
            )
          ).rows.map((row) => uiReviewMeetingStateSchema.parse(row.state));
          if (
            existing.some(
              (entry) =>
                caseHasOpenItems(entry, basis.caseId) ||
                (entry.finalized &&
                  entry.caseWorkbenchRound &&
                  pendingCaseReview(entry, basis)) ||
                (!entry.finalized &&
                  entry.scope.some(
                    (previous) =>
                      previous.caseId === basis.caseId &&
                      bindingMatches(previous, basis, true),
                  )),
            )
          )
            conflict('当前用例有可继续处理的评审会话，请打开该会话。');
          state.caseWorkbenchRound =
            1 +
            existing.reduce(
              (round, entry) =>
                entry.finalized
                  ? Math.max(round, caseReviewRound(entry, basis.caseId))
                  : round,
              0,
            );
          const draft = input.caseWorkbenchBasis.draft;
          if (draft?.kind === 'no-change') state.noChange.push(basis);
          if (draft?.kind === 'opinion')
            state.draftOpinions.push({
              id: randomUUID(),
              authorId: actor.userId,
              createdAt: new Date().toISOString(),
              body: draft.body,
              target: 'case',
              targetId: basis.caseId,
              caseIds: [basis.caseId],
            });
        }
        const row = (
          await tx.query<Room>(
            'INSERT INTO app.ui_review_meetings(project_id,requirement_version_id,case_ids,state,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [
              projectId,
              input.requirementVersionId,
              input.caseIds,
              JSON.stringify(state),
              actor.userId,
            ],
          )
        ).rows[0];
        if (!row) throw Error('UI review insert returned no row.');
        await audit(tx, actor, 'reviews.meeting-created', row.id, projectId, {
          caseCount: input.caseIds.length,
        });
        return { meeting: meetingSummary(row, state) };
      },
      projectId,
    );
  }

  async update(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = uiReviewUpdateSchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.meeting-update',
      input.commandId,
      { id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'reviews.approve');
      },
      async (tx) => {
        const room = await this.lockRoom(tx, projectId, id);
        if (room.row_version !== input.rowVersion) stale();
        const state = uiReviewMeetingStateSchema.parse(room.state);
        switch (input.action) {
          case 'save-draft': {
            if (state.finalized) conflict('已定稿的意见可在复审时补充。');
            const previous = state.draftOpinions.find(
              (o) => o.id === input.opinion.id,
            );
            if (input.opinion.id && !previous)
              conflict('草稿已移除或不属于本次评审。');
            if (state.caseWorkbenchRound) {
              if (previous && previous.authorId !== actor.userId)
                conflict('只能编辑自己的评审草稿。');
              for (const id of input.opinion.caseIds) {
                const current = await this.basis(tx, projectId, room, id);
                const opened = state.scope.find((entry) => entry.caseId === id);
                if (!opened || !bindingMatches(opened, current, true)) stale();
              }
            }
            const entry = await this.opinion(
              tx,
              projectId,
              room,
              input.opinion,
              actor.userId,
              previous,
            );
            state.draftOpinions = [
              ...state.draftOpinions.filter((o) => o.id !== entry.id),
              entry,
            ];
            break;
          }
          case 'remove-draft':
            if (
              state.finalized ||
              !state.draftOpinions.some(
                (o) =>
                  o.id === input.opinionId &&
                  (!state.caseWorkbenchRound || o.authorId === actor.userId),
              )
            )
              conflict('只有本次尚未定稿的意见可移除。');
            state.draftOpinions = state.draftOpinions.filter(
              (o) => o.id !== input.opinionId,
            );
            break;
          case 'no-change': {
            if (state.finalized) conflict('此会议已经定稿。');
            const current = await this.basis(tx, projectId, room, input.caseId);
            const basis = state.scope.find(
              (item) => item.caseId === input.caseId,
            );
            if (!basis || !bindingMatches(basis, current, true)) stale();
            state.noChange = [
              ...state.noChange.filter((mark) => mark.caseId !== input.caseId),
              current,
            ];
            break;
          }
          case 'finalize': {
            if (state.finalized) conflict('此会议已经定稿。');
            const included = new Set([
              ...state.noChange.map((b) => b.caseId),
              ...state.draftOpinions.flatMap((o) => o.caseIds),
            ]);
            if (!included.size) conflict('请先记录意见或标记无需修改。');
            const current = new Map<string, UiReviewBasis>();
            for (const caseId of included) {
              const currentBasis = await this.basis(
                tx,
                projectId,
                room,
                caseId,
              );
              const opened = state.scope.find(
                (value) => value.caseId === caseId,
              );
              if (!opened || !bindingMatches(opened, currentBasis, true))
                stale();
              current.set(caseId, currentBasis);
            }
            for (const entry of state.draftOpinions) {
              for (const caseId of entry.caseIds) {
                const basis = current.get(caseId);
                if (!basis)
                  throw Error('UI review target has no current basis.');
                state.items.push({
                  opinionId: entry.id,
                  basis,
                  round: state.caseWorkbenchRound ?? 1,
                  state: 'waiting',
                });
              }
            }
            state.opinions = state.draftOpinions;
            state.draftOpinions = [];
            state.noChange = state.noChange.filter(
              (b) =>
                !state.items.some((item) => item.basis.caseId === b.caseId),
            );
            state.finalized = true;
            await this.markCases(
              tx,
              projectId,
              [...included],
              'pending',
              Boolean(state.caseWorkbenchRound),
            );
            await this.markCases(
              tx,
              projectId,
              state.items.map((item) => item.basis.caseId),
              'needsOptimization',
              Boolean(state.caseWorkbenchRound),
            );
            break;
          }
          case 'supplement': {
            if (!state.finalized) conflict('请先完成会议定稿。');
            const entry = await this.opinion(
              tx,
              projectId,
              room,
              input.opinion,
              actor.userId,
            );
            const round =
              1 +
              state.items.reduce(
                (round, item) => Math.max(round, item.round),
                0,
              );
            for (const caseId of entry.caseIds) {
              const basis = await this.basis(tx, projectId, room, caseId);
              state.items.push({
                opinionId: entry.id,
                basis,
                round,
                state: 'waiting',
              });
            }
            state.opinions.push(entry);
            await this.markCases(
              tx,
              projectId,
              entry.caseIds,
              'needsOptimization',
            );
            break;
          }
          case 'assess-case': {
            if (!state.finalized) conflict('请先完成会议定稿。');
            const current = await this.basis(tx, projectId, room, input.caseId);
            if (current.revisionId !== input.revisionId) stale();
            const open = latestUiReviewItems(state).filter(
              (item) =>
                item.basis.caseId === input.caseId && item.state !== 'resolved',
            );
            if (open.some((item) => item.state === 'waiting'))
              conflict(
                '此用例仍有等待 AI 回传的意见。回传后可保存人工复审结论。',
              );
            if (state.caseWorkbenchRound && !currentCaseReview(state, current))
              stale();
            const round = caseReviewRound(state, input.caseId);
            const time = new Date().toISOString();
            const decision = { actorId: actor.userId, time };
            if (state.caseWorkbenchRound && input.outcome === 'resolved') {
              for (const item of open) {
                if (
                  item.state !== 'returned' ||
                  item.reply?.revisionId !== current.revisionId ||
                  !sharedBindingMatches(item.basis, current)
                )
                  stale();
                item.state = 'resolved';
                item.decision = {
                  ...decision,
                  acceptedRevisionId: current.revisionId,
                };
              }
            }
            if (input.outcome === 'needsRework') {
              if (!input.instruction)
                throw new DomainError(
                  'VALIDATION_ERROR',
                  '请填写本轮补改要求。',
                  400,
                );
              const next =
                Math.max(round, ...state.items.map((item) => item.round)) + 1;
              if (state.caseWorkbenchRound && open.length) {
                for (const item of open) {
                  item.state = 'rework';
                  item.decision = decision;
                  state.items.push({
                    opinionId: item.opinionId,
                    basis: current,
                    round: next,
                    state: 'waiting',
                    instruction: input.instruction,
                  });
                }
              } else {
                const entry = await this.opinion(
                  tx,
                  projectId,
                  room,
                  {
                    target: 'case',
                    targetId: input.caseId,
                    caseIds: [input.caseId],
                    body: input.instruction,
                  },
                  actor.userId,
                );
                state.opinions.push(entry);
                state.items.push({
                  opinionId: entry.id,
                  basis: current,
                  round: next,
                  state: 'waiting',
                });
              }
              await this.markCases(
                tx,
                projectId,
                [input.caseId],
                'needsOptimization',
                Boolean(state.caseWorkbenchRound),
              );
            }
            (state.assessments ??= []).push({
              caseId: input.caseId,
              revisionId: current.revisionId,
              round,
              outcome: input.outcome,
              note: input.note,
              ...(input.instruction ? { instruction: input.instruction } : {}),
              actorId: actor.userId,
              time,
            });
            break;
          }
          case 'decide': {
            if (!state.finalized) conflict('请先完成会议定稿。');
            const current = await this.basis(tx, projectId, room, input.caseId);
            if (current.revisionId !== input.revisionId) stale();
            const item = latestUiReviewItems(state).find(
              (value) =>
                value.basis.caseId === input.caseId &&
                value.opinionId === input.opinionId,
            );
            if (!item) conflict('此用例没有该会议意见。');
            const decision = {
              actorId: actor.userId,
              time: new Date().toISOString(),
            };
            if (input.decision === 'resolve') {
              if (
                item.state !== 'returned' ||
                item.reply?.revisionId !== current.revisionId ||
                !sharedBindingMatches(item.basis, current)
              )
                stale();
              item.state = 'resolved';
              item.decision = {
                ...decision,
                acceptedRevisionId: current.revisionId,
              };
            } else {
              item.state = 'rework';
              item.decision ??= decision;
              const round =
                1 +
                state.items.reduce(
                  (round, value) => Math.max(round, value.round),
                  item.round,
                );
              const inherited = state.opinions.find(
                (entry) => entry.id === item.opinionId,
              );
              state.items.push({
                opinionId: item.opinionId,
                basis: current,
                round,
                state: 'waiting',
                ...((input.instruction ?? inherited?.body)
                  ? { instruction: input.instruction ?? inherited?.body }
                  : {}),
              });
              await this.markCases(
                tx,
                projectId,
                [input.caseId],
                'needsOptimization',
              );
            }
            break;
          }
        }
        return this.save(tx, actor, projectId, room, state, input.action);
      },
      projectId,
    );
  }

  async handoff(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'assets.write');
      const room = await this.room(tx, projectId, id);
      const state = uiReviewMeetingStateSchema.parse(room.state);
      const items = [];
      for (const item of latestUiReviewItems(state).filter(
        (entry) => entry.state === 'waiting',
      )) {
        const current = await this.basis(
          tx,
          projectId,
          room,
          item.basis.caseId,
        );
        const asset = await getAsset(tx, projectId, item.basis.caseId);
        const opinion = state.opinions.find(
          (entry) => entry.id === item.opinionId,
        );
        if (!opinion) throw Error('UI review target has no source opinion.');
        items.push({
          ...item,
          opinion,
          baseChanged: !bindingMatches(current, item.basis),
          asset: assetDto(asset),
        });
      }
      return { meeting: meetingSummary(room, state), items };
    });
  }

  async reply(
    actor: ActorContext,
    projectId: string,
    id: string,
    raw: unknown,
  ) {
    const input = uiReviewReplySchema.parse(raw);
    return this.operations.execute(
      actor,
      'reviews.meeting-reply',
      input.commandId,
      { id, ...input },
      async (tx) => {
        await requireProject(tx, actor, projectId, 'assets.write');
      },
      async (tx) => {
        const room = await this.lockRoom(tx, projectId, id);
        const state = uiReviewMeetingStateSchema.parse(room.state);
        const item = latestUiReviewItems(state).find(
          (value) =>
            value.basis.caseId === input.caseId &&
            value.opinionId === input.opinionId,
        );
        if (
          !item ||
          item.state !== 'waiting' ||
          item.round !== input.round ||
          item.basis.revisionId !== input.baseRevisionId
        )
          stale();
        const current = await this.basis(tx, projectId, room, input.caseId);
        if (
          current.revisionId !== input.revisionId ||
          !sharedBindingMatches(item.basis, current)
        )
          stale();
        // A reply may attach the exact base or its direct successor only.
        const unchanged = current.revisionId === item.basis.revisionId;
        if (
          unchanged
            ? input.outcome === 'changed'
            : current.revisionNo !== item.basis.revisionNo + 1
        )
          stale();
        item.reply = {
          body: input.body,
          outcome: input.outcome,
          revisionId: input.revisionId,
          actorId: actor.userId,
          time: new Date().toISOString(),
        };
        item.state = 'returned';
        await this.markCases(
          tx,
          projectId,
          [input.caseId],
          'aiOptimized',
          Boolean(state.caseWorkbenchRound),
        );
        return this.save(tx, actor, projectId, room, state, 'reply');
      },
      projectId,
    );
  }

  private async room(
    tx: SqlExecutor,
    projectId: string,
    id: string,
    lock = false,
  ) {
    const row = (
      await tx.query<Room>(
        'SELECT * FROM app.ui_review_meetings WHERE project_id=$1 AND id=$2' +
          (lock ? ' FOR UPDATE' : ''),
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '此项目没有该评审会议。', 404);
    return row;
  }
  private async assets(
    tx: SqlExecutor,
    projectId: string,
    ids: string[],
    versionId: string,
    includeRemoved = false,
  ) {
    const rows = (
      await tx.query<AssetRow>(
        `${assetSelect} WHERE a.project_id=$1 AND a.id=ANY($2::uuid[]) AND a.kind='UI'
          AND a.target_type='case' AND a.requirement_version_id=$3 AND ($4 OR a.removed_at IS NULL)`,
        [projectId, ids, versionId, includeRemoved],
      )
    ).rows;
    const found = new Map(rows.map((asset) => [asset.id, asset]));
    return ids.map((id) => {
      const asset = found.get(id);
      if (!asset)
        throw new DomainError(
          'NOT_FOUND',
          '评审范围只能包含同一需求版本的 UI 用例。',
          404,
        );
      return asset;
    });
  }
  private async lockAssets(
    tx: SqlExecutor,
    projectId: string,
    assets: AssetRow[],
  ) {
    for (const setId of [
      ...new Set(assets.map((asset) => asset.set_id)),
    ].sort())
      await lockSet(tx, projectId, setId);
  }
  private async lockRoom(tx: SqlExecutor, projectId: string, id: string) {
    const before = await this.room(tx, projectId, id);
    await this.lockAssets(
      tx,
      projectId,
      await this.assets(
        tx,
        projectId,
        before.case_ids,
        before.requirement_version_id,
        true,
      ),
    );
    return this.room(tx, projectId, id, true);
  }
  private async basis(
    tx: SqlExecutor,
    projectId: string,
    room: Room,
    id: string,
  ) {
    if (!room.case_ids.includes(id))
      throw new DomainError('NOT_FOUND', '此用例不属于本次评审。', 404);
    const asset = await getAsset(tx, projectId, id);
    return makeBasis(asset, await ancestors(tx, asset));
  }
  private async opinion(
    tx: SqlExecutor,
    projectId: string,
    room: Room,
    input: OpinionInput,
    actorId: string,
    previous?: UiReviewOpinion,
  ) {
    if (input.caseIds.some((id) => !room.case_ids.includes(id)))
      conflict('意见不能超出评审会议用例范围。');
    const cases = await this.assets(
      tx,
      projectId,
      input.caseIds,
      room.requirement_version_id,
    );
    if (
      cases.some(
        (row) =>
          input.targetId !==
          (input.target === 'case'
            ? row.id
            : input.target === 'scenario'
              ? row.parent_id
              : row.set_id),
      )
    )
      conflict('受影响用例须对应本次选定的用例、场景或测试集。');
    return {
      ...input,
      id: previous?.id ?? randomUUID(),
      authorId: previous?.authorId ?? actorId,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
  }
  private async markCases(
    tx: SqlExecutor,
    projectId: string,
    ids: string[],
    value: AssetRow['review_state'],
    preserveApproved = false,
  ) {
    if (!ids.length) return;
    await tx.query(
      `UPDATE app.test_assets SET review_state=$3,row_version=row_version+1,updated_at=clock_timestamp()
       WHERE project_id=$1 AND id=ANY($2::uuid[]) AND (NOT $4 OR review_state<>'approved')`,
      [projectId, ids, value, preserveApproved],
    );
  }
  private async save(
    tx: SqlExecutor,
    actor: ActorContext,
    projectId: string,
    room: Room,
    state: UiReviewMeetingState,
    action: string,
  ) {
    const row = (
      await tx.query<Room>(
        'UPDATE app.ui_review_meetings SET state=$2,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [room.id, JSON.stringify(uiReviewMeetingStateSchema.parse(state))],
      )
    ).rows[0];
    if (!row) throw Error('UI review update returned no row.');
    if (state.finalized)
      await recordBusinessActivity(tx, projectId, room.requirement_version_id);
    await audit(tx, actor, 'reviews.meeting-' + action, room.id, projectId, {
      rowVersion: row.row_version,
    });
    return { meeting: meetingSummary(row, state) };
  }
}
