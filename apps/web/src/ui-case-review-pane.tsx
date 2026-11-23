import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Skeleton, Space } from 'antd';
import { z } from 'zod';
import type { Asset } from '../../../packages/contracts/src/assets';
import {
  uiReviewMeetingDetailSchema,
  uiReviewMeetingListSchema,
  uiReviewMeetingMutationSchema,
  type UiReviewWorkItem,
} from '../../../packages/contracts/src/ui-reviews';
import { api, describeError, isUncertainMutationError } from './api';
import { RecoveryBlock } from './recovery-block';
import { formatBeijingTime } from './beijing-time';
import { currentIdentityOwner } from './identity-context';
import { readUiReviewReceipt, uiReviewPath } from './ui-review-transport';

export type UiCaseReviewRoom = z.infer<typeof uiReviewMeetingDetailSchema>;
export const assessmentLabels = {
  resolved: '确认已解决',
  needsRework: '需要补改',
  inconclusive: '无法确认',
};
const operationSchema = z.strictObject({
  commandId: z.uuid(),
  path: z.string(),
});
type Operation = z.infer<typeof operationSchema>;
type History = z.infer<typeof uiReviewMeetingListSchema>['meetings'];
export type UiCaseReviewDraft = { opinion?: string; assessment?: string };

function latestItems(items: UiReviewWorkItem[], caseId: string) {
  const latest = new Map<string, UiReviewWorkItem>();
  for (const item of items)
    if (item.basis.caseId === caseId) latest.set(item.opinionId, item);
  return [...latest.values()];
}

export function UiCaseReviewPane({
  asset,
  userId,
  writable,
  drafts,
  onRead,
  onBusy,
  onChanged,
  onApprove,
  onCompare,
  onOpenTeam,
  onOpenHistory,
  onSupplement,
}: {
  asset: Asset;
  userId: string;
  writable: boolean;
  drafts: Map<string, UiCaseReviewDraft>;
  onRead: (room: UiCaseReviewRoom | undefined) => void;
  onBusy: (busy: boolean) => void;
  onChanged: () => Promise<void>;
  onApprove: (ids: string[]) => Promise<void>;
  onCompare: (from: string, to: string) => void;
  onOpenTeam: (id: string) => void;
  onOpenHistory: (id: string) => void;
  onSupplement: (origin: {
    meetingId: string;
    opinionId: string;
    round: number;
  }) => void;
}) {
  const path = uiReviewPath(asset.projectId);
  const recoveryKey = [
    'aitesthub:case-review-receipt:v1',
    userId,
    asset.projectId,
    asset.requirementVersionId,
    asset.id,
  ].join(':');
  const [room, setRoom] = useState<UiCaseReviewRoom>();
  const [history, setHistory] = useState<History>([]);
  const [fetchNo, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [preview, setPreview] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [recovery, setRecovery] = useState<Operation | undefined>(() => {
    try {
      const parsed = operationSchema.safeParse(
        JSON.parse(localStorage.getItem(recoveryKey) ?? 'null'),
      );
      if (
        parsed.success &&
        (parsed.data.path === path ||
          (parsed.data.path.startsWith(path + '/') &&
            z.uuid().safeParse(parsed.data.path.slice(path.length + 1))
              .success))
      )
        return parsed.data;
    } catch {
      // 本页草稿独立于浏览器中的操作标识。
    }
    return undefined;
  });
  const [, updateEditor] = useState(0);
  const items = latestItems(room?.state.items ?? [], asset.id);
  const round = Math.max(
    room?.state.caseWorkbenchRound ?? 1,
    ...items.map((item) => item.round),
  );
  const openedScope = room?.state.scope.find(
    (entry) => entry.caseId === asset.id,
  );
  const roomCase = room?.cases.find((entry) => entry.id === asset.id);
  const currentAssessment = room?.state.assessments?.findLast(
    (entry) =>
      entry.caseId === asset.id &&
      entry.revisionId === asset.revisionId &&
      entry.round === round,
  );
  const draftKey = [
    userId,
    asset.projectId,
    asset.requirementVersionId,
    asset.id,
    asset.revisionId,
    room?.meeting.id ?? 'start',
    round,
  ].join(':');
  // The version and active round form a stable draft identity across case switches.
  const draft = drafts.get(draftKey);
  const savedOpinion = room?.state.draftOpinions.find(
    (opinion) =>
      opinion.authorId === userId &&
      opinion.target === 'case' &&
      opinion.caseIds.length === 1 &&
      opinion.caseIds[0] === asset.id,
  );
  const opinion = draft?.opinion ?? savedOpinion?.body ?? '';
  const assessment = draft?.assessment ?? currentAssessment?.note ?? '';
  const savedResolution =
    currentAssessment?.outcome === 'resolved' &&
    draft?.assessment === undefined;
  const waiting = items.filter((item) => item.state === 'waiting');
  const returned = items.filter((item) => item.state === 'returned');
  const staleHandoff = waiting.some(
    (item) => item.basis.revisionId !== asset.revisionId,
  );
  const staleReply = returned.some(
    (item) => item.reply?.revisionId !== asset.revisionId,
  );
  const frozen = Boolean(room?.state.finalized);
  const approved = asset.reviewState === 'approved';
  const blocked =
    loading || Boolean(loadError || recovery) || busy || !writable;
  const matched =
    roomCase?.revisionId === asset.revisionId &&
    roomCase?.rowVersion === asset.rowVersion;
  const ownRoom = room?.state.caseWorkbenchRound !== undefined;
  const openDraft = !frozen && (room || !approved);
  const hasNoChange = Boolean(
    room?.state.noChange.some((entry) => entry.caseId === asset.id),
  );

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      requirementVersionId: asset.requirementVersionId,
      caseId: asset.id,
    });
    setLoading(true);
    setLoadError(undefined);
    void api(
      path + '?' + query,
      { signal: controller.signal },
      uiReviewMeetingListSchema,
    )
      .then(async (data) => {
        const value = data.activeMeetingId
          ? await api(
              path + '/' + data.activeMeetingId + '?caseId=' + asset.id,
              { signal: controller.signal },
              uiReviewMeetingDetailSchema,
            )
          : undefined;
        if (controller.signal.aborted) return;
        setHistory(data.meetings.filter((meeting) => meeting.finalized));
        setRoom(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, asset.id, asset.requirementVersionId, asset.rowVersion, fetchNo]);

  useEffect(() => {
    onRead(room);
    return () => onRead(undefined);
  }, [onRead, room]);

  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [onBusy, busy]);

  function changeDraft(change: UiCaseReviewDraft) {
    drafts.set(draftKey, { ...draft, ...change });
    updateEditor((epoch) => epoch + 1);
  }

  function reload() {
    setLoading(true);
    refresh((number) => number + 1);
  }

  async function confirmed(
    result: z.infer<typeof uiReviewMeetingMutationSchema>,
  ) {
    const active = await api(
      path + '/' + result.meeting.id + '?caseId=' + asset.id,
      {},
      uiReviewMeetingDetailSchema,
    );
    setRoom(active);
    setHistory((previous) =>
      active.meeting.finalized
        ? [
            active.meeting,
            ...previous.filter((entry) => entry.id !== active.meeting.id),
          ]
        : previous,
    );
    return active;
  }

  async function mutate(
    body: Record<string, unknown>,
    message: string,
    keepDraft = false,
  ) {
    if (blocked || inFlight.current || currentIdentityOwner() !== userId)
      return false;
    const command: Operation = {
      commandId: crypto.randomUUID(),
      path: room ? path + '/' + room.meeting.id : path,
    };
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(command));
      try {
        const result = await api(
          command.path,
          {
            method: 'POST',
            body: {
              commandId: command.commandId,
              ...(room ? { rowVersion: room.meeting.rowVersion } : {}),
              ...body,
            },
          },
          uiReviewMeetingMutationSchema,
        );
        localStorage.removeItem(recoveryKey);
        if (!keepDraft) drafts.delete(draftKey);
        setNotice(message);
        try {
          await confirmed(result);
          if (
            body.action === 'finalize' ||
            body.action === 'assess-case' ||
            body.action === 'decide'
          )
            await onChanged();
        } catch (failure) {
          setError('操作已保存，读取新状态失败。' + describeError(failure));
          reload();
        }
        return true;
      } catch (failure) {
        if (isUncertainMutationError(failure)) {
          setRecovery(command);
          setError('提交结果未知，请查询原回执。');
        } else {
          localStorage.removeItem(recoveryKey);
          setError(describeError(failure));
          reload();
        }
      }
    } catch {
      setError('浏览器无法保存操作标识，请保留当前草稿。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    return false;
  }

  async function recover() {
    if (
      !recovery ||
      inFlight.current ||
      !writable ||
      currentIdentityOwner() !== userId
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await readUiReviewReceipt(
        path,
        recovery.path,
        recovery.commandId,
      );
      if (result.status === 'completed' && result.response !== null) {
        localStorage.removeItem(recoveryKey);
        setRecovery(undefined);
        setNotice('已找回原评审回执。');
        await confirmed(result.response);
        await onChanged();
      } else if (result.status === 'failed') {
        localStorage.removeItem(recoveryKey);
        setRecovery(undefined);
        setError('原操作已明确失败，草稿可重新核对。');
      } else {
        setError('平台尚未确认原操作，请稍后核对。');
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function createBody(
    initial?: { kind: 'opinion'; body: string } | { kind: 'no-change' },
  ) {
    return {
      requirementVersionId: asset.requirementVersionId,
      caseIds: [asset.id],
      caseWorkbenchBasis: {
        revisionId: asset.revisionId,
        rowVersion: asset.rowVersion,
        ...(initial ? { draft: initial } : {}),
      },
    };
  }

  async function saveOpinion() {
    if (!opinion.trim() || (room && (!matched || frozen))) return false;
    return mutate(
      room
        ? {
            action: 'save-draft',
            opinion: {
              target: 'case',
              targetId: asset.id,
              caseIds: [asset.id],
              body: opinion.trim(),
              ...(savedOpinion ? { id: savedOpinion.id } : {}),
            },
          }
        : createBody({ kind: 'opinion', body: opinion.trim() }),
      '评审草稿已保存。',
    );
  }

  async function previewOpinion() {
    if (
      opinion.trim() &&
      opinion.trim() !== savedOpinion?.body &&
      !(await saveOpinion())
    )
      return;
    setPreview(true);
  }

  async function openTeam() {
    if (!room) return;
    if (
      opinion.trim() &&
      opinion.trim() !== savedOpinion?.body &&
      !frozen &&
      !(await saveOpinion())
    )
      return;
    onOpenTeam(room.meeting.id);
  }

  async function saveAssessment(
    outcome: 'resolved' | 'needsRework' | 'inconclusive',
  ) {
    if (!matched || !assessment.trim()) return;
    const saved = await mutate(
      {
        action: 'assess-case',
        caseId: asset.id,
        revisionId: asset.revisionId,
        outcome,
        note: assessment.trim(),
        ...(outcome === 'needsRework'
          ? { instruction: assessment.trim() }
          : {}),
      },
      outcome === 'needsRework'
        ? '补改意见已交接给本地 AI。'
        : '人工复审说明已保存。',
    );
    if (saved && outcome === 'resolved') {
      if (approved) reload();
      else await onApprove([asset.id]);
    }
  }

  const handoffText = [
    '通过官方 MCP 工具 ath_reviews 读取待 AI 修改的评审意见。',
    JSON.stringify(
      {
        op: 'meeting-handoff',
        projectId: asset.projectId,
        id: room?.meeting.id,
      },
      null,
      2,
    ),
    ...waiting.map(
      (item) =>
        '意见 ' +
        item.opinionId +
        ' · 用例 ' +
        asset.id +
        ' · 第 ' +
        item.round +
        ' 轮 · 基准 r' +
        item.basis.revisionNo +
        ' (' +
        item.basis.revisionId +
        ')',
    ),
  ].join('\n');

  async function copyHandoff() {
    try {
      await navigator.clipboard.writeText(handoffText);
      setNotice('已复制官方 MCP 交接范围。');
    } catch {
      setHandoff(true);
    }
  }

  return (
    <div className="ui-case-review-pane">
      {!writable && (
        <Alert type="info" showIcon title="当前账号没有项目测试评审权限。" />
      )}
      {(error || loadError) && (
        <Alert type="error" showIcon title={error ?? loadError} />
      )}
      {notice && (
        <p className="ui-case-review-notice" role="status">
          {notice}
        </p>
      )}
      {recovery && (
        <RecoveryBlock
          title="核对用例评审回执"
          variant="pending"
          reference={recovery.commandId}
          actions={
            <Button size="small" onClick={() => void recover()} loading={busy}>
              查询原回执
            </Button>
          }
        />
      )}
      {loadError && (
        <Button size="small" onClick={reload}>
          重新读取评审
        </Button>
      )}
      {loading && !room ? <Skeleton active paragraph={{ rows: 2 }} /> : null}
      {!loading && !loadError && (
        <>
          {openDraft && writable && (
            <>
              <div className="ui-case-review-row">
                <strong>评审记录与优化建议</strong>
                <span className="caption">基于 r{asset.revisionNo}</span>
              </div>
              <label htmlFor="ui-case-review-opinion">需要 AI 补清的内容</label>
              <Input.TextArea
                id="ui-case-review-opinion"
                rows={4}
                value={opinion}
                maxLength={10000}
                disabled={blocked || Boolean(room && !matched)}
                onChange={(event) =>
                  changeDraft({ opinion: event.target.value })
                }
                placeholder="例如补清页面入口、关键操作、可判定的预期和需要核对的事实。"
              />
              {savedOpinion && (
                <span className="caption">
                  服务器草稿 · {formatBeijingTime(savedOpinion.createdAt, true)}
                </span>
              )}
              <Space wrap size={6}>
                <Button
                  size="small"
                  disabled={
                    blocked || !opinion.trim() || Boolean(room && !matched)
                  }
                  onClick={() => void saveOpinion()}
                >
                  保存草稿
                </Button>
                {room && !ownRoom ? (
                  <Button
                    size="small"
                    type="primary"
                    disabled={blocked}
                    onClick={() => void openTeam()}
                  >
                    在团队评审定稿
                  </Button>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    disabled={
                      blocked ||
                      Boolean(room && !matched) ||
                      (!opinion.trim() && !hasNoChange)
                    }
                    onClick={() => void previewOpinion()}
                  >
                    {hasNoChange && !opinion.trim()
                      ? '进入人工复审'
                      : '提交给本地 AI'}
                  </Button>
                )}
              </Space>
              <Button
                size="small"
                type="link"
                disabled={
                  blocked ||
                  hasNoChange ||
                  Boolean(opinion.trim()) ||
                  Boolean(room && !matched)
                }
                onClick={() =>
                  void mutate(
                    room
                      ? { action: 'no-change', caseId: asset.id }
                      : createBody({ kind: 'no-change' }),
                    '已记录无需修改。',
                    true,
                  )
                }
              >
                {hasNoChange ? '已记录无需修改' : '记录无需修改'}
              </Button>
            </>
          )}
          {!room && approved && (
            <>
              <div className="ui-case-review-row">
                <strong>已批准 r{asset.revisionNo}</strong>
              </div>
              <div className="ui-case-review-message">
                可发起新一轮继续优化。原批准与已冻结的执行计划仍可查阅。
              </div>
              {writable && (
                <Button
                  size="small"
                  type="primary"
                  disabled={blocked}
                  onClick={() =>
                    void mutate(createBody(), '新一轮评审已开启。')
                  }
                >
                  发起新一轮评审
                </Button>
              )}
            </>
          )}
          {frozen && room && (
            <>
              {waiting.length > 0 && (
                <div className="ui-case-review-row">
                  <strong>待 AI 修改 · {waiting.length} 项</strong>
                  <span className="caption">第 {round} 轮</span>
                </div>
              )}
              {staleHandoff && (
                <Alert
                  type="warning"
                  showIcon
                  title="待回传意见的基准与当前修订不同。"
                  action={
                    <Button
                      size="small"
                      onClick={() => onOpenTeam(room.meeting.id)}
                    >
                      核对原会话
                    </Button>
                  }
                />
              )}
              {room.state.opinions
                .filter((entry) => entry.caseIds.includes(asset.id))
                .map((entry) => {
                  const item = items.find(
                    (value) => value.opinionId === entry.id,
                  );
                  const reply = item?.reply;
                  return (
                    <article className="ui-case-review-message" key={entry.id}>
                      <strong>
                        本轮原意见
                        {item ? ' · 基准 r' + item.basis.revisionNo : ''}
                      </strong>
                      <p className="preserve-lines">{entry.body}</p>
                      {item?.instruction && (
                        <p className="preserve-lines">
                          补改要求 · {item.instruction}
                        </p>
                      )}
                      {reply && item && (
                        <>
                          <strong>
                            AI 回传 ·{' '}
                            {
                              {
                                changed: '已修改',
                                retained: '保留原文',
                                unaddressed: '未解决',
                              }[reply.outcome]
                            }
                          </strong>
                          <p className="preserve-lines">{reply.body}</p>
                          <Button
                            type="link"
                            size="small"
                            onClick={() =>
                              onCompare(item.basis.revisionId, reply.revisionId)
                            }
                          >
                            查看本轮修订差异
                          </Button>
                          {!ownRoom &&
                            writable &&
                            item.state === 'returned' && (
                              <Button
                                size="small"
                                disabled={
                                  blocked ||
                                  !matched ||
                                  item.reply?.revisionId !== asset.revisionId
                                }
                                onClick={() =>
                                  void mutate(
                                    {
                                      action: 'decide',
                                      decision: 'resolve',
                                      caseId: asset.id,
                                      revisionId: asset.revisionId,
                                      opinionId: item.opinionId,
                                    },
                                    '此项意见已确认解决。',
                                    true,
                                  )
                                }
                              >
                                确认此项已解决
                              </Button>
                            )}
                        </>
                      )}
                      {writable && item && (
                        <Button
                          type="link"
                          size="small"
                          disabled={busy}
                          onClick={() =>
                            onSupplement({
                              meetingId: room.meeting.id,
                              opinionId: item.opinionId,
                              round: item.round,
                            })
                          }
                        >
                          按此意见补充用例
                        </Button>
                      )}
                    </article>
                  );
                })}
              {waiting.length > 0 && (
                <Space wrap size={6}>
                  <Button size="small" onClick={() => void copyHandoff()}>
                    复制交接说明
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      reload();
                      void onChanged().catch((failure: unknown) =>
                        setError(describeError(failure)),
                      );
                    }}
                  >
                    读取最新回传
                  </Button>
                </Space>
              )}
              {waiting.length === 0 && (!ownRoom || !matched || staleReply) && (
                <Button
                  size="small"
                  onClick={() => onOpenTeam(room.meeting.id)}
                >
                  打开团队评审
                </Button>
              )}
              {waiting.length === 0 &&
                writable &&
                matched &&
                (ownRoom || returned.length === 0) && (
                  <>
                    <div className="ui-case-review-row">
                      <strong>人工复审</strong>
                      <span className="caption">当前 r{asset.revisionNo}</span>
                    </div>
                    <label htmlFor="ui-case-review-assessment">
                      人工复审说明
                    </label>
                    <Input.TextArea
                      id="ui-case-review-assessment"
                      rows={3}
                      value={assessment}
                      maxLength={10000}
                      disabled={blocked}
                      onChange={(event) =>
                        changeDraft({ assessment: event.target.value })
                      }
                      placeholder="写下确认依据，或填写下一轮需要补改的内容。"
                    />
                    <Space wrap size={6}>
                      <Button
                        size="small"
                        disabled={blocked || !assessment.trim()}
                        onClick={() => void saveAssessment('needsRework')}
                      >
                        继续补改
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        disabled={blocked || !assessment.trim() || staleReply}
                        onClick={() =>
                          void (savedResolution && !approved
                            ? onApprove([asset.id])
                            : saveAssessment('resolved'))
                        }
                      >
                        {savedResolution && !approved
                          ? '批准当前修订'
                          : '人工复审通过'}
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        disabled={blocked || !assessment.trim()}
                        onClick={() => void saveAssessment('inconclusive')}
                      >
                        记录无法确认
                      </Button>
                    </Space>
                    {staleReply && (
                      <Alert
                        type="warning"
                        showIcon
                        title="回传基准与当前修订不同，请先核对修订差异。"
                      />
                    )}
                  </>
                )}
            </>
          )}
        </>
      )}
      <details className="ui-case-review-history" open={history.length === 0}>
        <summary>
          用例评审记录{history.length ? ' · ' + history.length + ' 次会话' : ''}
        </summary>
        {!history.length && <p className="caption">暂无已定稿的评审记录。</p>}
        {history.map((entry) => (
          <div className="ui-case-review-row" key={entry.id}>
            <span className="caption">
              {formatBeijingTime(entry.createdAt, true)}
            </span>
            <Button
              size="small"
              type="link"
              disabled={busy}
              onClick={() => onOpenHistory(entry.id)}
            >
              查看评审快照
            </Button>
          </div>
        ))}
      </details>
      <Modal
        title="确认本次评审意见"
        open={preview}
        onCancel={() => setPreview(false)}
        okText="定稿并交接"
        confirmLoading={busy}
        okButtonProps={{ disabled: blocked || !room || frozen || !matched }}
        onOk={async () => {
          if (await mutate({ action: 'finalize' }, '评审意见已定稿。'))
            setPreview(false);
        }}
      >
        <p>
          基准修订 r{openedScope?.revisionNo ?? asset.revisionNo} · 第 {round}{' '}
          轮
        </p>
        {room?.state.draftOpinions.map((entry) => (
          <p className="preserve-lines" key={entry.id}>
            {entry.body}
          </p>
        ))}
        {hasNoChange && !room?.state.draftOpinions.length && (
          <p>该用例无需修改，定稿后可填写人工复审结论。</p>
        )}
      </Modal>
      <Modal
        title="复制交接说明"
        open={handoff}
        onCancel={() => setHandoff(false)}
        footer={<Button onClick={() => setHandoff(false)}>关闭</Button>}
      >
        <Input.TextArea
          readOnly
          rows={8}
          aria-label="官方 MCP 交接说明"
          value={handoffText}
          onFocus={(event) => event.target.select()}
        />
      </Modal>
    </div>
  );
}
