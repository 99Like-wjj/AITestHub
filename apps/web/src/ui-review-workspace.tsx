import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Radio,
  Select,
  Skeleton,
  Space,
  Tag,
} from 'antd';
import { z } from 'zod';
import type { Asset } from '../../../packages/contracts/src/assets';
import {
  uiCaseAssessmentOutcomeSchema,
  uiReviewMeetingDetailSchema,
  uiReviewMeetingListSchema,
  uiReviewMeetingMutationSchema,
  type UiReviewWorkItem,
} from '../../../packages/contracts/src/ui-reviews';
import { api, describeError, isUncertainMutationError } from './api';
import { PageHeading } from './page-heading';
import { UiCaseText } from './ui-case-reader';
export { UiCaseText } from './ui-case-reader';
import './ui-review-workspace.css';

export type UiReviewRoom = z.infer<typeof uiReviewMeetingDetailSchema>;
type Room = UiReviewRoom;
type AssessmentOutcome = z.infer<typeof uiCaseAssessmentOutcomeSchema>;
const assessmentLabels: Record<AssessmentOutcome, string> = {
  resolved: '确认已解决',
  needsRework: '需要补改',
  inconclusive: '无法确认',
};
export { assessmentLabels };
type Meetings = z.infer<typeof uiReviewMeetingListSchema>['meetings'];
type Target = 'case' | 'scenario' | 'set';
type Command = {
  commandId: string;
  path: string;
  body: Record<string, unknown>;
};
const stepLabels = ['会议评审', 'AI 修改', '人工复审'];
const statuses = {
  waiting: '待修改',
  returned: '待确认',
  resolved: '已解决',
  rework: '已退回',
} as const;
const revisionLabel = (room: Room, id: string) =>
  room.revisions.find((item) => item.id === id)?.revisionNo;

function latestItems(items: UiReviewWorkItem[], caseId: string) {
  const byOpinion = new Map<string, UiReviewWorkItem>();
  for (const item of items)
    if (item.basis.caseId === caseId) byOpinion.set(item.opinionId, item);
  return [...byOpinion.values()];
}

export function UiReviewWorkspace({
  projectId,
  userId,
  requirementVersionId,
  requirementTitle,
  versionNo,
  assets,
  scenarioTitles,
  initialCases,
  tester,
  onReturn,
  onApprove,
  updated,
  inlineCaseId,
  inlineDrafts,
  onBusyChange,
  onSupplement,
  onRead,
  onCompare,
}: {
  projectId: string;
  userId: string;
  requirementVersionId: string;
  requirementTitle: string;
  versionNo: number;
  assets: Asset[];
  scenarioTitles: Map<string, string>;
  initialCases: string[];
  tester: boolean;
  onReturn: () => void;
  onApprove: (ids: string[]) => Promise<void>;
  updated: () => Promise<void>;
  inlineCaseId?: string;
  inlineDrafts?: Map<string, string>;
  onBusyChange?: (busy: boolean) => void;
  onSupplement?: (origin: {
    meetingId: string;
    opinionId: string;
    round: number;
  }) => void;
  onRead?: (room: Room | undefined) => void;
  onCompare?: (from: string, to: string) => void;
}) {
  const path = '/projects/' + projectId + '/assets/ui-review-meetings';
  const storageKey =
    'aitesthub:ui-review-command:' +
    userId +
    ':' +
    projectId +
    ':' +
    requirementVersionId;
  const [roomId, setRoomId] = useState<string>();
  const [room, setRoom] = useState<Room>();
  const [meetings, setMeetings] = useState<Meetings>([]);
  const [focus, setFocus] = useState(inlineCaseId ?? '');
  const [selection, setSelection] = useState(initialCases);
  const [body, setBody] = useState(() =>
    inlineCaseId ? (inlineDrafts?.get(inlineCaseId) ?? '') : '',
  );
  const [target, setTarget] = useState<Target>('case');
  const [affected, setAffected] = useState<string[]>([]);
  const [editId, setEditId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] =
    useState<Pick<Command, 'commandId' | 'path'>>();
  const [error, setError] = useState<string>();
  const [handoff, setHandoff] = useState(false);
  const [finalize, setFinalize] = useState(false);
  const [forPlan, setForPlan] = useState<string[]>();
  const [returnItem, setReturnItem] = useState<UiReviewWorkItem>();
  const [instruction, setInstruction] = useState('');
  const [receiptNotice, setReceiptNotice] = useState<string>();
  const [assessmentOutcome, setAssessmentOutcome] =
    useState<AssessmentOutcome>();
  const [assessmentNote, setAssessmentNote] = useState('');
  const [assessmentInstruction, setAssessmentInstruction] = useState('');
  const [confirmAssessment, setConfirmAssessment] = useState(false);

  useEffect(() => {
    onRead?.(room);
    return () => onRead?.(undefined);
  }, [onRead, room]);

  useEffect(() => {
    onBusyChange?.(submitting);
    return () => onBusyChange?.(false);
  }, [onBusyChange, submitting]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const recovered = z
          .object({ commandId: z.uuid(), path: z.string() })
          .safeParse(JSON.parse(raw));
        if (
          recovered.success &&
          (recovered.data.path === path ||
            recovered.data.path.startsWith(path + '/'))
        )
          setUncertain(recovered.data);
      }
    } catch {
      /* Existing drafts stay available when local storage is unavailable. */
    }
  }, [storageKey, path]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ requirementVersionId });
    if (inlineCaseId) query.set('caseId', inlineCaseId);
    void api(
      path + '?' + query,
      { signal: controller.signal },
      uiReviewMeetingListSchema,
    )
      .then((reply) => {
        if (controller.signal.aborted) return;
        setMeetings(reply.meetings);
        const requested = new URLSearchParams(
          window.location.hash.split('?')[1],
        ).get('meetingId');
        if (inlineCaseId) setRoomId(reply.meetings[0]?.id);
        else if (
          requested &&
          reply.meetings.some((item) => item.id === requested)
        )
          setRoomId(requested);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(describeError(err));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [path, requirementVersionId, inlineCaseId]);
  useEffect(() => {
    if (!roomId) {
      setRoom(undefined);
      return;
    }
    const controller = new AbortController();
    const params = focus ? '?caseId=' + focus : '';
    void api(
      path + '/' + roomId + params,
      { signal: controller.signal },
      uiReviewMeetingDetailSchema,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          inlineCaseId &&
          !value.cases.some((item) => item.id === inlineCaseId)
        ) {
          setError('此评审会话不包含当前用例。');
          setRoom(undefined);
          return;
        }
        setRoom(value);
        if (!value.cases.some((item) => item.id === focus))
          setFocus(value.cases[0]?.id ?? '');
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [path, roomId, focus, assets, inlineCaseId]);
  const active = room?.cases.find((item) => item.id === focus);
  const items = room?.state.items ?? [];
  const openItems = room && active ? latestItems(items, active.id) : [];
  const outstanding =
    room?.cases.flatMap((asset) =>
      latestItems(items, asset.id).filter((item) => item.state === 'waiting'),
    ) ?? [];
  const stage = !room?.state.finalized ? 0 : outstanding.length ? 1 : 2;
  const currentRound = items.reduce(
    (round, item) => Math.max(round, item.round),
    0,
  );
  const changedCases = new Set(items.map((item) => item.basis.caseId));
  const reviewedCases = new Set([
    ...(room?.state.noChange.map((item) => item.caseId) ?? []),
    ...changedCases,
  ]);
  const awaitingReview =
    room?.cases
      .filter(
        (asset) =>
          reviewedCases.has(asset.id) &&
          !asset.removedAt &&
          asset.reviewState !== 'approved' &&
          latestItems(items, asset.id).every(
            (item) => item.state === 'resolved',
          ),
      )
      .map((asset) => asset.id) ?? [];
  const eligible =
    room?.cases
      .filter(
        (asset) =>
          !asset.removedAt &&
          asset.reviewState === 'approved' &&
          (room.state.noChange.some((mark) => mark.caseId === asset.id) ||
            room.state.items.some((item) => item.basis.caseId === asset.id)),
      )
      .map((asset) => asset.id) ?? [];
  const frozenFocus = Boolean(active?.removedAt);
  const targetId =
    target === 'case'
      ? active?.id
      : target === 'scenario'
        ? active?.parentId
        : active?.setId;
  const applicable =
    room?.cases.filter(
      (asset) =>
        !asset.removedAt &&
        targetId ===
          (target === 'case'
            ? asset.id
            : target === 'scenario'
              ? asset.parentId
              : asset.setId),
    ) ?? [];
  const affectedCaseIds =
    target === 'case' && targetId
      ? [targetId]
      : affected.filter((id) => applicable.some((asset) => asset.id === id));
  const activateRoom = (id: string | undefined) => {
    if (!inlineCaseId) {
      const query = new URLSearchParams(window.location.hash.split('?')[1]);
      if (id) query.set('meetingId', id);
      else query.delete('meetingId');
      window.history.replaceState(null, '', '#cases?' + query.toString());
    }
    if (roomId !== id) {
      setRoom(undefined);
      setFocus(inlineCaseId ?? '');
    }
    setRoomId(id);
  };
  async function send(command: Command) {
    setSubmitting(true);
    setError(undefined);
    setReceiptNotice(undefined);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          commandId: command.commandId,
          path: command.path,
        }),
      );
      const result = await api(
        command.path,
        { method: 'POST', body: command.body },
        uiReviewMeetingMutationSchema,
      );
      localStorage.removeItem(storageKey);
      setUncertain(undefined);
      setMeetings((previous) => [
        result.meeting,
        ...previous.filter((item) => item.id !== result.meeting.id),
      ]);
      activateRoom(result.meeting.id);
      try {
        if (command.path !== path)
          setRoom(
            await api(
              command.path + (focus ? '?caseId=' + focus : ''),
              {},
              uiReviewMeetingDetailSchema,
            ),
          );
        if (
          command.body.action === 'finalize' ||
          command.body.action === 'decide' ||
          command.body.action === 'assess-case' ||
          command.body.action === 'supplement'
        )
          await updated();
      } catch (err) {
        setError('操作已确认，刷新评审视图时遇到问题。' + describeError(err));
      }
      return true;
    } catch (err) {
      if (isUncertainMutationError(err)) {
        setUncertain(command);
        setError('操作结果未知，已保留原提交标识。请核对原操作。');
      } else {
        localStorage.removeItem(storageKey);
        setUncertain(undefined);
        setError(describeError(err));
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }
  const makeCommand = (targetPath: string, input: Record<string, unknown>) => {
    const commandId = crypto.randomUUID();
    return { commandId, path: targetPath, body: { commandId, ...input } };
  };
  async function recover() {
    if (!uncertain) return;
    const command = uncertain;
    setSubmitting(true);
    setError(undefined);
    try {
      const operation =
        command.path === path
          ? 'reviews.meeting-create'
          : 'reviews.meeting-update';
      const raw = await api(
        path +
          '/receipt/' +
          encodeURIComponent(command.commandId) +
          '?operation=' +
          operation,
        {},
        z.strictObject({
          status: z.enum(['completed', 'failed', 'pending', 'unknown']),
          response: uiReviewMeetingMutationSchema.nullable(),
        }),
      );
      if (raw.status === 'completed' && raw.response) {
        localStorage.removeItem(storageKey);
        setUncertain(undefined);
        const value = raw.response;
        setMeetings((previous) => [
          value.meeting,
          ...previous.filter((item) => item.id !== value.meeting.id),
        ]);
        activateRoom(value.meeting.id);
        setRoom(
          await api(
            path + '/' + value.meeting.id + (focus ? '?caseId=' + focus : ''),
            {},
            uiReviewMeetingDetailSchema,
          ),
        );
        await updated();
        setReceiptNotice('已找回原回执。');
      } else if (raw.status === 'failed') {
        localStorage.removeItem(storageKey);
        setUncertain(undefined);
        setError('原操作已明确失败，可以核对内容后重新提交。');
      } else setError('平台尚未确认原操作，请保留原标识继续核对。');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }
  function update(input: Record<string, unknown>) {
    if (!room || uncertain) return Promise.resolve(false);
    return send(
      makeCommand(path + '/' + room.meeting.id, {
        rowVersion: room.meeting.rowVersion,
        ...input,
      }),
    );
  }
  function resetEditor() {
    setBody('');
    setTarget('case');
    setAffected([]);
    setEditId(undefined);
  }
  function openCase(id: string) {
    setFocus(id);
    resetEditor();
  }
  async function saveOpinion() {
    if (!room || !targetId || !affectedCaseIds.length) return;
    const result = await update({
      action: room.state.finalized ? 'supplement' : 'save-draft',
      opinion: {
        body,
        target,
        targetId,
        caseIds: affectedCaseIds,
        ...(editId ? { id: editId } : {}),
      },
    });
    if (result) {
      if (inlineCaseId) inlineDrafts?.delete(inlineCaseId);
      resetEditor();
    }
  }
  const currentAssessment = room?.state.assessments?.findLast(
    (entry) =>
      entry.caseId === active?.id && entry.revisionId === active.revisionId,
  );
  const assessmentChanged = Boolean(
    assessmentOutcome || assessmentNote.trim() || assessmentInstruction.trim(),
  );
  const assessmentAllowed = Boolean(
    active &&
    room?.state.finalized &&
    tester &&
    !frozenFocus &&
    active.reviewState !== 'approved' &&
    !openItems.some((item) => item.state === 'waiting'),
  );
  function clearAssessmentForm() {
    setAssessmentOutcome(undefined);
    setAssessmentNote('');
    setAssessmentInstruction('');
  }
  async function saveAssessment() {
    if (
      !active ||
      !assessmentOutcome ||
      !assessmentAllowed ||
      !assessmentNote.trim()
    )
      return;
    if (
      await update({
        action: 'assess-case',
        caseId: active.id,
        revisionId: active.revisionId,
        outcome: assessmentOutcome,
        note: assessmentNote.trim(),
        ...(assessmentOutcome === 'needsRework' && assessmentInstruction.trim()
          ? { instruction: assessmentInstruction.trim() }
          : {}),
      })
    ) {
      clearAssessmentForm();
      setConfirmAssessment(false);
    }
  }
  const checkReady = Boolean(
    active &&
    !active.removedAt &&
    room?.state.finalized &&
    (room.state.noChange.some((b) => b.caseId === active.id) ||
      openItems.length) &&
    openItems.every((item) => item.state === 'resolved') &&
    currentAssessment?.outcome !== 'inconclusive' &&
    (!inlineCaseId ||
      (currentAssessment?.outcome === 'resolved' && !assessmentChanged)),
  );
  const blocked = submitting || Boolean(uncertain);
  const controls = (
    <Space wrap>
      {!inlineCaseId && <Button onClick={onReturn}>返回用例库</Button>}
      {room?.state.finalized && (
        <Button onClick={() => setHandoff(true)} disabled={!outstanding.length}>
          查看交接说明
        </Button>
      )}
      {room && !room.state.finalized && tester && (
        <Button
          type="primary"
          disabled={
            blocked ||
            (!room.state.draftOpinions.length && !room.state.noChange.length)
          }
          onClick={() => setFinalize(true)}
        >
          确认本次意见
        </Button>
      )}
      {room?.state.finalized && tester && !inlineCaseId && (
        <Button
          disabled={!awaitingReview.length || blocked}
          onClick={() => void onApprove(awaitingReview)}
        >
          预览批准（{awaitingReview.length}）
        </Button>
      )}
      {room?.state.finalized && tester && !inlineCaseId && (
        <Button
          type="primary"
          disabled={!eligible.length || blocked}
          onClick={() => setForPlan(eligible)}
        >
          加入执行范围（{eligible.length}）
        </Button>
      )}
      {inlineCaseId &&
        room &&
        active &&
        tester &&
        !frozenFocus &&
        (room.state.finalized ? (
          <Button
            type="primary"
            size="small"
            disabled={
              blocked || !checkReady || active.reviewState === 'approved'
            }
            onClick={() => void onApprove([active.id])}
          >
            {active.reviewState === 'approved' ? '已批准' : '批准当前修订'}
          </Button>
        ) : (
          <Button
            size="small"
            disabled={
              blocked ||
              room.state.noChange.some((basis) => basis.caseId === active.id)
            }
            onClick={() =>
              void update({ action: 'no-change', caseId: active.id })
            }
          >
            {room.state.noChange.some((basis) => basis.caseId === active.id)
              ? '已记录无需修改'
              : '记录无需修改'}
          </Button>
        ))}
    </Space>
  );
  const startingAssets = inlineCaseId
    ? assets.filter((asset) => asset.id === inlineCaseId)
    : assets;
  return (
    <>
      {inlineCaseId ? (
        controls
      ) : (
        <PageHeading
          eyebrow="UI CASE REVIEW"
          title="用例评审"
          description={requirementTitle + ' · v' + versionNo}
          actions={controls}
        />
      )}
      {error && (
        <Alert
          className="mb"
          type="error"
          showIcon
          title={error}
          action={
            uncertain ? (
              <Button onClick={() => void recover()} loading={submitting}>
                查询原回执
              </Button>
            ) : undefined
          }
        />
      )}
      {uncertain && !error && (
        <Alert
          className="mb"
          type="warning"
          showIcon
          title="有原评审操作待核对"
          action={
            <Button onClick={() => void recover()} loading={submitting}>
              查询原回执
            </Button>
          }
        />
      )}
      {receiptNotice && (
        <Alert className="mb" type="success" showIcon title={receiptNotice} />
      )}
      <div
        className={inlineCaseId ? 'ui-review-inline-session' : 'panel pad mb'}
      >
        <Space wrap>
          <Select
            aria-label="评审会话"
            style={inlineCaseId ? { maxWidth: '100%' } : { minWidth: 280 }}
            value={roomId ?? ''}
            disabled={loading || blocked}
            options={[
              { value: '', label: '新建评审会议' },
              ...meetings.map((item) => ({
                value: item.id,
                label: `${new Date(item.createdAt).toLocaleString('zh-CN')} · ${item.caseCount} 条用例 · ${item.finalized ? '已定稿' : '记录中'}`,
              })),
            ]}
            onChange={(id: string) => {
              activateRoom(id || undefined);
              if (!inlineCaseId) resetEditor();
            }}
          />
          {room && (
            <Button
              onClick={() =>
                void (focus
                  ? api(
                      path + '/' + room.meeting.id + '?caseId=' + focus,
                      {},
                      uiReviewMeetingDetailSchema,
                    )
                      .then(setRoom)
                      .catch((err: unknown) => setError(describeError(err)))
                  : updated())
              }
            >
              刷新
            </Button>
          )}
        </Space>
      </div>
      {roomId && !room ? (
        <Skeleton active />
      ) : !room ? (
        <section
          className={inlineCaseId ? 'ui-review-inline-session' : 'panel pad'}
        >
          <h2>确认本次评审范围</h2>
          {startingAssets.length ? (
            <>
              <Checkbox
                checked={
                  Boolean(startingAssets.length) &&
                  selection.length === startingAssets.length
                }
                disabled={!tester || blocked}
                onChange={(e) =>
                  setSelection(
                    e.target.checked
                      ? startingAssets.map((item) => item.id)
                      : [],
                  )
                }
              >
                全选当前用例
              </Checkbox>
              <Checkbox.Group
                className="ui-review-start-list"
                value={selection}
                disabled={!tester || blocked}
                options={startingAssets.map((asset) => ({
                  value: asset.id,
                  label: asset.title + ' · r' + asset.revisionNo,
                }))}
                onChange={setSelection}
              />
              {tester && (
                <Button
                  type="primary"
                  loading={submitting}
                  disabled={blocked || !selection.length}
                  onClick={() =>
                    void send(
                      makeCommand(path, {
                        requirementVersionId,
                        caseIds: selection,
                      }),
                    )
                  }
                >
                  开始评审
                </Button>
              )}
            </>
          ) : (
            <Empty description="当前范围还没有 UI 用例" />
          )}
        </section>
      ) : (
        <>
          <div
            className="ui-review-stages panel pad mb"
            aria-label="评审进程"
            hidden={Boolean(inlineCaseId)}
          >
            {stepLabels.map((label, i) => (
              <div key={label} className={stage === i ? 'selected' : ''}>
                <strong>{label}</strong>
                <small>
                  {i === 0
                    ? room.state.finalized
                      ? '意见已定稿'
                      : '记录意见与范围'
                    : i === 1
                      ? outstanding.length
                        ? outstanding.length + ' 项待回传'
                        : '经官方 MCP 交接'
                      : '逐条确认、批准或退回补改'}
                </small>
              </div>
            ))}
          </div>
          {room.state.finalized && currentRound > 0 && (
            <p className="caption mb" role="status">
              第 {currentRound} 轮 · 人工复审可退回 AI 补改，已批准{' '}
              {eligible.length} / {reviewedCases.size} 条
            </p>
          )}
          <div
            className={
              inlineCaseId ? 'ui-review-inline-room' : 'ui-review-layout'
            }
          >
            {!inlineCaseId && (
              <>
                <aside className="panel pad">
                  <h2>评审目录</h2>
                  {[...new Set(room.cases.map((asset) => asset.parentId))].map(
                    (parent) => (
                      <section key={parent ?? ''} className="mb">
                        <h3>
                          {scenarioTitles.get(parent ?? '') ?? '用例场景'}
                        </h3>
                        {room.cases
                          .filter((asset) => asset.parentId === parent)
                          .map((asset) => (
                            <button
                              type="button"
                              key={asset.id}
                              className={
                                asset.id === focus
                                  ? 'ui-review-entry selected'
                                  : 'ui-review-entry'
                              }
                              onClick={() => openCase(asset.id)}
                            >
                              <strong>{asset.title}</strong>
                              <small>
                                r{asset.revisionNo} ·{' '}
                                {asset.removedAt
                                  ? '已移除'
                                  : asset.reviewState === 'approved'
                                    ? '已批准'
                                    : latestItems(items, asset.id).some(
                                          (item) => item.state === 'waiting',
                                        )
                                      ? '待修改'
                                      : '待复审'}
                              </small>
                            </button>
                          ))}
                      </section>
                    ),
                  )}
                </aside>
                <section className="panel pad">
                  {active ? (
                    <>
                      <Space wrap className="mb">
                        <h2>{active.title}</h2>
                        <Tag>当前 r{active.revisionNo}</Tag>
                      </Space>
                      {tester &&
                        (!room.state.finalized ? (
                          <Button
                            size="small"
                            disabled={
                              blocked ||
                              frozenFocus ||
                              room.state.noChange.some(
                                (basis) => basis.caseId === active.id,
                              )
                            }
                            onClick={() =>
                              void update({
                                action: 'no-change',
                                caseId: active.id,
                              })
                            }
                          >
                            {room.state.noChange.some(
                              (basis) => basis.caseId === active.id,
                            )
                              ? '已记录无需修改'
                              : '记录无需修改'}
                          </Button>
                        ) : (
                          <Button
                            type="primary"
                            size="small"
                            disabled={
                              blocked ||
                              !checkReady ||
                              active.reviewState === 'approved'
                            }
                            onClick={() => void onApprove([active.id])}
                          >
                            {active.reviewState === 'approved'
                              ? '已批准'
                              : '批准当前修订'}
                          </Button>
                        ))}
                      <UiCaseText content={active.content} />
                      {items.filter(
                        (item) => item.basis.caseId === active.id && item.reply,
                      ).length > 0 && (
                        <section>
                          <h3>历次回传与版本差异</h3>
                          {[...items]
                            .reverse()
                            .filter(
                              (item) =>
                                item.basis.caseId === active.id && item.reply,
                            )
                            .map((item) => {
                              const source = room.revisions.find(
                                (rev) => rev.id === item.basis.revisionId,
                              );
                              const reply = room.revisions.find(
                                (rev) => rev.id === item.reply?.revisionId,
                              );
                              const text = (revision: typeof source) =>
                                revision
                                  ? [
                                      revision.content.testPoint,
                                      ...(revision.content.steps?.map(
                                        (step) =>
                                          step.action +
                                          (step.expected
                                            ? '\n预期 ' + step.expected
                                            : ''),
                                      ) ?? []),
                                      revision.content.expected,
                                    ].join('\n')
                                  : '版本内容加载中';
                              return (
                                <details
                                  key={item.opinionId + '-' + item.round}
                                  className="ui-review-diff"
                                >
                                  <summary>
                                    第 {item.round} 轮 · r
                                    {item.basis.revisionNo} → r
                                    {(item.reply &&
                                      revisionLabel(
                                        room,
                                        item.reply.revisionId,
                                      )) ||
                                      '—'}{' '}
                                    · {statuses[item.state]}
                                  </summary>
                                  <p className="preserve-lines">
                                    {item.reply?.body}
                                  </p>
                                  <div className="ui-review-compare">
                                    <div>
                                      <strong>基准修订</strong>
                                      <pre>{text(source)}</pre>
                                    </div>
                                    <div>
                                      <strong>回传修订</strong>
                                      <pre>{text(reply)}</pre>
                                    </div>
                                  </div>
                                </details>
                              );
                            })}
                        </section>
                      )}
                    </>
                  ) : (
                    <Empty description="请选择用例" />
                  )}
                </section>
              </>
            )}
            <aside
              className={
                inlineCaseId ? 'ui-review-inline-opinions' : 'panel pad'
              }
            >
              <h2>{room.state.finalized ? '评审意见与复审' : '会议意见'}</h2>
              {assessmentAllowed && (
                <section className="ui-review-opinion ui-review-opinion-form">
                  <h3>人工评审结果</h3>
                  {currentAssessment && (
                    <p className="caption preserve-lines">
                      已保存 · {assessmentLabels[currentAssessment.outcome]} ·{' '}
                      {currentAssessment.note}
                    </p>
                  )}
                  <Select
                    aria-label="复审结论"
                    placeholder="复审结论"
                    value={assessmentOutcome}
                    options={uiCaseAssessmentOutcomeSchema.options.map(
                      (value) => ({ value, label: assessmentLabels[value] }),
                    )}
                    onChange={setAssessmentOutcome}
                    disabled={blocked}
                  />
                  <Input.TextArea
                    aria-label="评审说明"
                    placeholder="填写复核依据和说明"
                    rows={2}
                    maxLength={10000}
                    value={assessmentNote}
                    disabled={blocked}
                    onChange={(event) => setAssessmentNote(event.target.value)}
                  />
                  {assessmentOutcome === 'needsRework' && (
                    <Input.TextArea
                      aria-label="下一轮补改意见"
                      placeholder="具体说明下一轮需要修改的内容"
                      rows={2}
                      maxLength={10000}
                      value={assessmentInstruction}
                      disabled={blocked}
                      onChange={(event) =>
                        setAssessmentInstruction(event.target.value)
                      }
                    />
                  )}
                  <Button
                    size="small"
                    disabled={
                      blocked ||
                      !assessmentOutcome ||
                      !assessmentNote.trim() ||
                      (assessmentOutcome === 'needsRework' &&
                        !assessmentInstruction.trim())
                    }
                    onClick={() =>
                      assessmentOutcome === 'needsRework'
                        ? setConfirmAssessment(true)
                        : void saveAssessment()
                    }
                  >
                    保存评审结果
                  </Button>
                  {openItems.some((item) => item.state === 'returned') && (
                    <p className="caption">
                      请同时确认下方各项已回传意见的处理结果。
                    </p>
                  )}
                </section>
              )}
              {active && (
                <>
                  {(room.state.finalized
                    ? room.state.opinions
                    : room.state.draftOpinions
                  )
                    .filter((item) => item.caseIds.includes(active.id))
                    .map((opinion) => {
                      const assessment = openItems.find(
                        (item) => item.opinionId === opinion.id,
                      );
                      return (
                        <article key={opinion.id} className="ui-review-opinion">
                          <Space wrap>
                            <Tag>
                              {opinion.target === 'case'
                                ? '用例意见'
                                : opinion.target === 'scenario'
                                  ? '场景意见'
                                  : '测试集意见'}
                            </Tag>
                            {assessment && (
                              <Tag>{statuses[assessment.state]}</Tag>
                            )}
                            {tester && onSupplement && assessment && (
                              <Button
                                size="small"
                                disabled={blocked}
                                onClick={() =>
                                  onSupplement({
                                    meetingId: room.meeting.id,
                                    opinionId: opinion.id,
                                    round: assessment.round,
                                  })
                                }
                              >
                                补充用例
                              </Button>
                            )}
                          </Space>
                          <p className="preserve-lines">{opinion.body}</p>
                          {assessment?.instruction && (
                            <p className="preserve-lines">
                              补改说明 {assessment.instruction}
                            </p>
                          )}
                          {assessment?.reply && (
                            <>
                              <p className="preserve-lines">
                                处理说明 {assessment.reply.body}
                              </p>
                              {onCompare && (
                                <Button
                                  size="small"
                                  onClick={() => {
                                    if (assessment.reply)
                                      onCompare(
                                        assessment.basis.revisionId,
                                        assessment.reply.revisionId,
                                      );
                                  }}
                                >
                                  查看本轮修订差异
                                </Button>
                              )}
                            </>
                          )}
                          {tester && !room.state.finalized && (
                            <Space wrap>
                              <Button
                                size="small"
                                disabled={blocked}
                                onClick={() => {
                                  setEditId(opinion.id);
                                  setBody(opinion.body);
                                  setTarget(opinion.target);
                                  setAffected(opinion.caseIds);
                                }}
                              >
                                编辑
                              </Button>
                              <Button
                                size="small"
                                disabled={blocked}
                                onClick={() =>
                                  void update({
                                    action: 'remove-draft',
                                    opinionId: opinion.id,
                                  })
                                }
                              >
                                移除
                              </Button>
                            </Space>
                          )}
                          {tester &&
                            assessment &&
                            room.state.finalized &&
                            !frozenFocus && (
                              <Space wrap>
                                {assessment.state === 'returned' && (
                                  <Button
                                    size="small"
                                    disabled={
                                      blocked ||
                                      assessment.reply?.revisionId !==
                                        active.revisionId
                                    }
                                    onClick={() =>
                                      void update({
                                        action: 'decide',
                                        decision: 'resolve',
                                        caseId: active.id,
                                        revisionId: active.revisionId,
                                        opinionId: opinion.id,
                                      })
                                    }
                                  >
                                    确认已解决
                                  </Button>
                                )}
                                {assessment.state !== 'waiting' ||
                                assessment.basis.revisionId !==
                                  active.revisionId ? (
                                  <Button
                                    size="small"
                                    disabled={blocked}
                                    onClick={() => {
                                      setInstruction('');
                                      setReturnItem(assessment);
                                    }}
                                  >
                                    退回补改
                                  </Button>
                                ) : null}
                              </Space>
                            )}
                        </article>
                      );
                    })}
                  {tester && !frozenFocus && (
                    <div className="ui-review-opinion-form">
                      <h3>
                        {editId
                          ? '编辑意见'
                          : room.state.finalized
                            ? '补充修改意见'
                            : '记录评审意见'}
                      </h3>
                      <Radio.Group
                        aria-label="意见对象"
                        value={target}
                        onChange={(event) => {
                          setTarget(event.target.value as Target);
                          setAffected([active.id]);
                        }}
                      >
                        <Radio.Button value="case">用例</Radio.Button>
                        <Radio.Button value="scenario">场景</Radio.Button>
                        <Radio.Button value="set">测试集</Radio.Button>
                      </Radio.Group>
                      {target !== 'case' && (
                        <Checkbox.Group
                          aria-label="受影响用例"
                          className="ui-review-start-list"
                          value={affected}
                          onChange={setAffected}
                          options={applicable.map((asset) => ({
                            value: asset.id,
                            label: asset.title,
                          }))}
                        />
                      )}
                      <Input.TextArea
                        aria-label="修改意见"
                        placeholder="写下需要修改的内容和检验口径"
                        value={body}
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        maxLength={10000}
                        onChange={(event) => {
                          setBody(event.target.value);
                          if (inlineCaseId && !editId)
                            inlineDrafts?.set(inlineCaseId, event.target.value);
                        }}
                        disabled={blocked}
                      />
                      <Space wrap>
                        {editId && (
                          <Button size="small" onClick={resetEditor}>
                            取消编辑
                          </Button>
                        )}
                        <Button
                          type="primary"
                          size="small"
                          disabled={
                            blocked || !body.trim() || !affectedCaseIds.length
                          }
                          onClick={() => void saveOpinion()}
                        >
                          {room.state.finalized
                            ? '记录并退回 AI'
                            : '保存评审意见'}
                        </Button>
                      </Space>
                    </div>
                  )}
                </>
              )}
            </aside>
          </div>
        </>
      )}
      <Modal
        title="确认退回补改"
        open={confirmAssessment}
        confirmLoading={submitting}
        okText="保存并退回"
        onCancel={() => setConfirmAssessment(false)}
        onOk={() => void saveAssessment()}
      >
        <p>将按当前 r{active?.revisionNo} 开启下一轮。</p>
        <p className="preserve-lines">{assessmentInstruction}</p>
      </Modal>
      <Modal
        title="确认本次评审意见"
        open={finalize}
        onCancel={() => setFinalize(false)}
        okText="定稿并交接"
        confirmLoading={submitting}
        onOk={async () => {
          if (await update({ action: 'finalize' })) setFinalize(false);
        }}
      >
        <ul>
          {room?.state.draftOpinions.map((entry) => (
            <li key={entry.id}>
              {entry.body}
              <br />
              {entry.caseIds
                .map((id) => {
                  const item = room.cases.find((asset) => asset.id === id);
                  return item ? item.title + ' r' + item.revisionNo : id;
                })
                .join('、')}
            </li>
          ))}
        </ul>
        {!!room?.state.noChange.length && (
          <p>{room.state.noChange.length} 条已记录无需修改，进入人工复审。</p>
        )}
      </Modal>
      <Modal
        title="本地 AI 交接说明"
        open={handoff}
        onCancel={() => setHandoff(false)}
        footer={<Button onClick={() => setHandoff(false)}>关闭</Button>}
      >
        <p>
          在本地通过官方 MCP
          读取当前待修改意见。回传按原会议、轮次和基准修订关联。
        </p>
        <Input.TextArea
          readOnly
          rows={5}
          aria-label="MCP 交接参数"
          value={JSON.stringify(
            { op: 'meeting-handoff', projectId, id: room?.meeting.id },
            null,
            2,
          )}
        />
        <ul>
          {outstanding.map((item) => (
            <li key={item.basis.caseId + '-' + item.opinionId}>
              {
                room?.cases.find((asset) => asset.id === item.basis.caseId)
                  ?.title
              }{' '}
              · 第 {item.round} 轮 · r{item.basis.revisionNo}
            </li>
          ))}
        </ul>
      </Modal>
      <Modal
        title="退回 AI 补改"
        open={Boolean(returnItem)}
        onCancel={() => setReturnItem(undefined)}
        okText="退回补改"
        confirmLoading={submitting}
        onOk={async () => {
          if (!active || !returnItem) return;
          if (
            await update({
              action: 'decide',
              decision: 'return',
              caseId: active.id,
              revisionId: active.revisionId,
              opinionId: returnItem.opinionId,
              ...(instruction.trim() ? { instruction } : {}),
            })
          )
            setReturnItem(undefined);
        }}
      >
        <p>保留原意见和此前的回传记录，并以当前修订开启下一轮。</p>
        <Input.TextArea
          aria-label="补改说明"
          value={instruction}
          rows={4}
          onChange={(event) => setInstruction(event.target.value)}
          maxLength={10000}
        />
      </Modal>
      <Modal
        title="选择本轮执行范围"
        open={Boolean(forPlan)}
        onCancel={() => setForPlan(undefined)}
        okText="带入计划"
        okButtonProps={{
          disabled: !forPlan?.some((id) => eligible.includes(id)),
        }}
        onOk={() => {
          const query = new URLSearchParams({
            projectId,
            kind: 'UI',
            versionId: requirementVersionId,
          });
          for (const id of forPlan ?? [])
            if (eligible.includes(id)) query.append('caseId', id);
          window.location.hash = 'plans?' + query.toString();
        }}
      >
        <Checkbox.Group
          aria-label="计划用例"
          className="ui-review-start-list"
          value={forPlan ?? []}
          options={
            room?.cases
              .filter((asset) => eligible.includes(asset.id))
              .map((asset) => ({ label: asset.title, value: asset.id })) ?? []
          }
          onChange={setForPlan}
        />
      </Modal>
    </>
  );
}
