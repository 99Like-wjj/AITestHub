import { AuxiliaryAction } from './auxiliary-action';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Drawer,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import {
  issueDetailSchema,
  problemDetailSchema,
} from '../../../packages/contracts/src/issues';
import type { Issue } from '../../../packages/contracts/src/issues';
import { api, describeError } from './api';
import {
  issueStateLabels,
  problemStateLabels,
  severityLabels,
  useRequirementMetadata,
} from './issue-context';
import type { IssueMember, IssueNavigation } from './issue-context';
import type { ActionTarget, EditorTarget, HandlingAction } from './issue-forms';
import type { MergeTarget } from './issue-batch';
import type { Project } from './types';
import { outcomeLabels } from './result-detail';

export type IssueSelection = { kind: 'issue' | 'problem'; id: string };
export function IssueDetailPanel({
  project,
  userId,
  selection,
  members,
  requirements,
  onClose,
  onSelect,
  onEdit,
  onAction,
  onUnmerge,
  onRetest,
  onResult,
  onEvidence,
  onRegisterRefresh,
}: {
  project: Project;
  userId: string;
  selection: IssueSelection | null;
  members: IssueMember[];
  requirements: IssueNavigation;
  onClose: () => void;
  onSelect: (selection: IssueSelection) => void;
  onEdit: (target: EditorTarget) => void;
  onAction: (target: ActionTarget) => void;
  onUnmerge: (target: MergeTarget) => void;
  onRetest: (issues: Issue[]) => void;
  onResult: (id: string, revisionId: string) => void;
  onEvidence: (id: string) => void;
  onRegisterRefresh: (refresh: () => Promise<void>) => void;
}) {
  const [issue, setIssue] = useState<z.infer<typeof issueDetailSchema> | null>(
    null,
  );
  const [problem, setProblem] = useState<z.infer<
    typeof problemDetailSchema
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [handling, setHandling] = useState<HandlingAction | null>(null);
  const epoch = useRef(0);
  async function load(signal?: AbortSignal) {
    const current = ++epoch.current;
    if (!selection) return;
    setLoading(true);
    setError(undefined);
    try {
      if (selection.kind === 'issue') {
        const response = await api(
          `/projects/${project.id}/issues/${selection.id}`,
          signal ? { signal } : {},
          issueDetailSchema,
        );
        if (!signal?.aborted && current === epoch.current) setIssue(response);
      } else {
        const response = await api(
          `/projects/${project.id}/problems/${selection.id}`,
          signal ? { signal } : {},
          problemDetailSchema,
        );
        if (!signal?.aborted && current === epoch.current) setProblem(response);
      }
    } catch (failure) {
      if (!signal?.aborted && current === epoch.current) {
        setIssue(null);
        setProblem(null);
        setError(describeError(failure));
      }
    } finally {
      if (!signal?.aborted && current === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setIssue(null);
    setProblem(null);
    setHandling(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [project.id, selection?.kind, selection?.id]);
  useEffect(
    () => onRegisterRefresh(() => load()),
    [project.id, selection?.kind, selection?.id, onRegisterRefresh],
  );
  const tester = project.roles.includes('tester');
  const developer = project.roles.includes('developer');
  const productRole = project.roles.includes('product');
  const activeIssue = issue?.issue;
  const owner = activeIssue?.assigneeId ?? null;
  const canManageOwned = tester || (developer && owner === userId);
  const canEdit = Boolean(
    activeIssue &&
    (tester ||
      (productRole &&
        activeIssue.source === 'manualProduct' &&
        activeIssue.submittedBy === userId)),
  );
  const actionOptions: {
    value: HandlingAction;
    label: string;
    disabled: boolean;
  }[] = [
    { value: 'claim', label: '主动认领', disabled: Boolean(owner) },
    { value: 'assign', label: '测试组织指派/放回待认领', disabled: !tester },
    { value: 'transfer', label: '转交', disabled: !canManageOwned || !owner },
    {
      value: 'return',
      label: '退回待认领',
      disabled: !canManageOwned || !owner,
    },
    {
      value: 'takeover',
      label: '接替他人负责',
      disabled: !owner || owner === userId,
    },
    {
      value: 'start-processing',
      label: '开始处理',
      disabled:
        !canManageOwned || !owner || activeIssue?.state === 'inProgress',
    },
    {
      value: 'ready-for-retest',
      label: '提交处理，等待复测',
      disabled:
        !canManageOwned || !owner || activeIssue?.state === 'awaitingRetest',
    },
  ];
  const userName = (id: string | null) =>
    id
      ? (members.find((member) => member.id === id)?.displayName ??
        `历史/当前账号 ${id}`)
      : '无负责人';
  const base = activeIssue ?? problem?.problem;
  const requirementMetadata = useRequirementMetadata(
    project.id,
    base?.requirementId ?? null,
    requirements,
  );
  return (
    <Drawer
      open={selection !== null}
      title={
        base
          ? activeIssue
            ? `缺陷详情 · ${activeIssue.number}`
            : `待确认问题 · ${base.id.slice(0, 8)}`
          : '问题/缺陷详情'
      }
      width={740}
      className="issue-detail-drawer"
      footer={
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>关闭</Button>
        </div>
      }
      onClose={onClose}
      destroyOnHidden
    >
      {loading && <Skeleton active />}
      {error && <Alert type="error" title={error} showIcon />}
      <div className="issue-detail-content">
        <div className="between">
          <h2>{base?.title ?? (loading ? '正在读取…' : '尚未取得对象')}</h2>
          <Button
            size="small"
            onClick={() => {
              requirementMetadata.refresh();
              void load();
            }}
            loading={loading}
          >
            刷新
          </Button>
        </div>
        {base && (
          <>
            <p className="caption mt">
              <span title={base.requirementId}>
                {requirementMetadata.requirement?.title ??
                  (requirementMetadata.loading
                    ? '正在读取需求名称…'
                    : '需求名称暂不可用')}
              </span>{' '}
              ·{' '}
              {base.requirementVersionId
                ? (() => {
                    const version =
                      requirementMetadata.requirement?.versions.find(
                        (version) => version.id === base.requirementVersionId,
                      );
                    return version
                      ? `v${version.versionNo}`
                      : requirementMetadata.loading
                        ? '正在读取版本…'
                        : '需求版本资料暂不可用';
                  })()
                : '未指定需求版本'}{' '}
              ·{' '}
              {(
                {
                  manualTester: '测试人员手工发现',
                  manualProduct: '产品人员手工发现',
                  confirmedProblem: '待确认问题经测试确认',
                  uiResult: 'UI结果发现',
                  apiResult: '接口结果发现',
                  extraFinding: '其他人工发现',
                } as Record<string, string>
              )[base.source] ?? base.source}
            </p>
            {requirementMetadata.error && (
              <Alert
                type="warning"
                showIcon
                title="需求/版本名称暂未取得"
                description={requirementMetadata.error}
              />
            )}
          </>
        )}
        {issue && activeIssue && (
          <>
            <div className="row wrap mt">
              <span
                className={`badge ${activeIssue.state === 'pending' ? 'amber' : activeIssue.state === 'inProgress' || activeIssue.state === 'awaitingRetest' ? 'blue' : ''}`}
              >
                {issueStateLabels[activeIssue.state]}
              </span>
              <span className="badge">
                {severityLabels[activeIssue.severity]}
              </span>
              <span className="badge">
                负责人：{userName(activeIssue.assigneeId)}
              </span>
              {activeIssue.assigneeId && !activeIssue.assigneeActive && (
                <span className="badge red">负责人权限失效，身份保留</span>
              )}
            </div>
            <div className="divider" />
            <h3>问题描述</h3>
            <p className="preserve-lines">{activeIssue.description}</p>
            <div className="detail-grid mt">
              <div className="detail-block">
                <label>原始判断</label>
                <p>
                  {issue.resultLinks.length
                    ? '按关联结果分别保留'
                    : '未关联测试结果'}
                </p>
              </div>
              <div className="detail-block">
                <label>人工最终结论</label>
                <p>
                  {issue.resultLinks.length
                    ? '按关联结果分别记录'
                    : '没有可替代的测试结论'}
                </p>
              </div>
            </div>
            {issue.resultLinks.map((link) => (
              <div className="listrow" key={link.resultId}>
                <div className="grow">
                  <b>关联结果</b>
                  <p>
                    {link.resultId} · 关联采集修订 {link.revisionId}
                  </p>
                </div>
                <Button
                  size="small"
                  onClick={() => onResult(link.resultId, link.revisionId)}
                >
                  查看原始与人工结论
                </Button>
              </div>
            ))}
            {activeIssue.mergedIntoId && (
              <Alert
                type="info"
                showIcon
                title={`此条保留原记录，当前合并到 ${activeIssue.mergedIntoId}`}
                action={
                  <Button
                    onClick={() =>
                      onSelect({ kind: 'issue', id: activeIssue.mergedIntoId! })
                    }
                  >
                    查看当前主项
                  </Button>
                }
              />
            )}
            <div className="divider" />
            <Space wrap>
              <AuxiliaryAction
                label="AI严重程度建议"
                source={() => ({
                  purpose: 'issueAdvice',
                  projectId: project.id,
                  issueId: activeIssue.id,
                  mode: 'severity',
                })}
              />
              <AuxiliaryAction
                label="AI分析可能方向"
                source={() => ({
                  purpose: 'issueAdvice',
                  projectId: project.id,
                  issueId: activeIssue.id,
                  mode: 'direction',
                })}
              />
            </Space>
            <h3>处理操作</h3>
            <p className="caption mt">
              处理状态、业务结论与复测分别记录；通过不自动关闭，关闭不生成复测通过。
            </p>
            <Space wrap size={10} className="row wrap mt">
              <Button
                disabled={!canEdit}
                onClick={() =>
                  onEdit({
                    session: crypto.randomUUID(),
                    kind: 'edit',
                    issue: activeIssue,
                  })
                }
              >
                编辑标题/说明
              </Button>
              <Button
                disabled={!canManageOwned}
                onClick={() =>
                  onAction({
                    session: crypto.randomUUID(),
                    kind: 'severity',
                    issue: activeIssue,
                  })
                }
              >
                调整严重程度
              </Button>
              <Button
                disabled={!tester}
                onClick={() =>
                  onAction({
                    session: crypto.randomUUID(),
                    kind: 'verification',
                    issue: activeIssue,
                  })
                }
              >
                登记人工复测
              </Button>
              <Button
                disabled={!tester}
                onClick={() => onRetest([activeIssue])}
              >
                直接准备场景/用例复测
              </Button>
              <Button
                disabled={!tester}
                onClick={() =>
                  onAction({
                    session: crypto.randomUUID(),
                    kind: activeIssue.state === 'closed' ? 'reopen' : 'close',
                    issue: activeIssue,
                  })
                }
              >
                {activeIssue.state === 'closed' ? '明确重新打开' : '明确关闭'}
              </Button>
            </Space>
            <Space wrap size={10} className="row wrap mt">
              <Select
                aria-label="正式缺陷处理动作"
                style={{ minWidth: 270 }}
                value={handling}
                disabled={
                  activeIssue.state === 'closed' || !(tester || developer)
                }
                placeholder="选择实际处理动作"
                options={actionOptions}
                onChange={setHandling}
              />
              <Button
                disabled={
                  !handling ||
                  activeIssue.state === 'closed' ||
                  !(tester || developer) ||
                  Boolean(
                    handling &&
                    actionOptions.find((row) => row.value === handling)
                      ?.disabled,
                  )
                }
                onClick={() => {
                  if (handling)
                    onAction({
                      session: crypto.randomUUID(),
                      kind: 'handling',
                      action: handling,
                      issue: activeIssue,
                    });
                }}
              >
                填写并提交此处理动作
              </Button>
            </Space>
            <div className="divider" />
            <h3>复测记录</h3>
            {issue.verifications.length ? (
              issue.verifications.map((verification) => (
                <div className="listrow" key={verification.id}>
                  <div className="grow">
                    <b>{outcomeLabels[verification.outcome]}</b>
                    <span className="badge">
                      {(
                        {
                          manual: '人工复测',
                          UI: '本地UI复测',
                          API: '接口复测',
                        } as Record<string, string>
                      )[verification.method] ?? verification.method}
                    </span>
                    <p>
                      {userName(verification.actorId)} ·{' '}
                      {new Date(verification.createdAt).toLocaleString('zh-CN')}{' '}
                      · {verification.note || '无补充说明'}
                    </p>
                    {verification.executionProvenance ===
                      'protocol-synthetic' && (
                      <p className="caption">
                        合成协议记录，非真实UI目标执行。
                      </p>
                    )}
                    <div className="row wrap">
                      {verification.attachmentFileIds.map((id) => (
                        <Button
                          key={id}
                          size="small"
                          onClick={() => onEvidence(id)}
                        >
                          查看私有附件
                        </Button>
                      ))}
                      {verification.runId && (
                        <a
                          href={`#reports?projectId=${project.id}&runId=${verification.runId}`}
                        >
                          查看原轮次
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="caption mt">
                尚未记录复测。手工缺陷不虚构测试结果或关联用例。
              </p>
            )}
            <div className="divider" />
            <h3>完整指派路径与业务历史</h3>
            <div className="mt">
              {issue.events.map((event) => (
                <div className="assign-event" key={event.id}>
                  <small>
                    {new Date(event.createdAt).toLocaleString('zh-CN')}
                  </small>
                  <p>
                    <b>{userName(event.actorId)}</b> ·{' '}
                    {(
                      {
                        created: '创建',
                        edited: '更新标题或说明',
                        'details-edited': '更新标题或说明',
                        'severity-changed': '调整严重程度',
                        claim: '主动认领',
                        assign: '组织指派',
                        transfer: '转交',
                        return: '退回待认领',
                        takeover: '接替处理',
                        'start-processing': '开始处理',
                        'ready-for-retest': '等待复测',
                        'manual-verification': '人工复测',
                        closed: '明确关闭',
                        reopened: '明确重新打开',
                        severity: '调整严重程度',
                        merged: '合并关系',
                        unmerged: '解除合并',
                      } as Record<string, string>
                    )[event.action] ?? event.action}
                  </p>
                  <p className="caption">
                    {userName(event.previousOwnerId)} →{' '}
                    {userName(event.newOwnerId)}
                  </p>
                  <Collapse
                    ghost
                    size="small"
                    items={[
                      {
                        key: event.id,
                        label: '查看变更说明与影响',
                        children: (
                          <pre className="code">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        ),
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
            {!!issue.problemLinks.length && (
              <Space wrap size={10} className="row wrap mt">
                {issue.problemLinks.map((row) => (
                  <Button
                    key={row.problemId}
                    onClick={() =>
                      onSelect({ kind: 'problem', id: row.problemId })
                    }
                  >
                    查看保留的问题决定 {row.problemId}
                  </Button>
                ))}
              </Space>
            )}
            {!!issue.merges.length && (
              <Card size="small" title="人工合并关系与撤销历史">
                <Table
                  rowKey="id"
                  pagination={false}
                  dataSource={issue.merges}
                  scroll={{ x: 850 }}
                  columns={[
                    { title: '主项', dataIndex: 'masterId' },
                    { title: '从项', dataIndex: 'sourceId' },
                    {
                      title: '状态',
                      render: (_, row) =>
                        row.undoneAt
                          ? `已解除 ${row.undoneAt}`
                          : '当前有效关系',
                    },
                    {
                      title: '明确操作',
                      render: (_, row) => (
                        <Button
                          disabled={!tester || Boolean(row.undoneAt)}
                          onClick={() =>
                            onUnmerge({
                              session: crypto.randomUUID(),
                              kind: 'unmerge',
                              merge: row,
                            })
                          }
                        >
                          撤销此精确关系
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            )}
            {!!issue.mergedChildren.length && (
              <Space wrap size={10} className="row wrap mt">
                {issue.mergedChildren.map((row) => (
                  <Button
                    key={row.id}
                    onClick={() => onSelect({ kind: 'issue', id: row.id })}
                  >
                    查看保留从项 {row.number}
                  </Button>
                ))}
              </Space>
            )}
          </>
        )}
        {problem && (
          <>
            <Space wrap size={10} className="row wrap mt">
              <Tag>{problemStateLabels[problem.problem.state]}</Tag>
              <Tag>{problem.problem.source}</Tag>
              <Tag>{severityLabels[problem.problem.suggestedSeverity]}</Tag>
              <Tag>
                {problem.problem.sourceExecutionProvenance ===
                'protocol-synthetic'
                  ? '合成协议来源，非真实UI执行'
                  : problem.problem.sourceExecutionProvenance}
              </Tag>
            </Space>
            <div className="divider" />
            <h3>问题描述</h3>
            <p className="preserve-lines">{problem.problem.description}</p>
            <div className="divider" />

            <h3>处理操作</h3>
            {problem.problem.decisionNote && (
              <Alert
                type={
                  problem.problem.state === 'dismissed' ? 'warning' : 'info'
                }
                showIcon
                title={`当前人工决定说明：${problem.problem.decisionNote}`}
              />
            )}
            <Space wrap size={10} className="row wrap mt">
              <Button
                disabled={!tester || problem.problem.state === 'confirmed'}
                onClick={() =>
                  onEdit({
                    session: crypto.randomUUID(),
                    kind: 'confirm',
                    problem: problem.problem,
                  })
                }
              >
                {problem.problem.state === 'dismissed'
                  ? '明确改为正式缺陷'
                  : '测试确认新建/关联正式缺陷'}
              </Button>
              <Button
                disabled={
                  !tester || problem.problem.state !== 'pendingConfirmation'
                }
                onClick={() =>
                  onAction({
                    session: crypto.randomUUID(),
                    kind: 'dismiss',
                    problem: problem.problem,
                  })
                }
              >
                判定非缺陷
              </Button>
              {problem.problem.confirmedIssueId && (
                <Button
                  onClick={() =>
                    onSelect({
                      kind: 'issue',
                      id: problem.problem.confirmedIssueId!,
                    })
                  }
                >
                  查看已关联正式缺陷
                </Button>
              )}
            </Space>
            <Typography.Text type="secondary">
              待确认问题不进入正式缺陷/待认领池。此前非缺陷可由测试明确纠正；旧决定保留，已确认的问题不能再次创建或重绑正式缺陷。
            </Typography.Text>
            <Table
              rowKey="resultId"
              pagination={false}
              dataSource={problem.results}
              scroll={{ x: 900 }}
              columns={[
                { title: '来源结果', dataIndex: 'resultId' },
                {
                  title: '来源采集判断',
                  render: (_, row) => outcomeLabels[row.sourceOutcome],
                },
                {
                  title: '当前采集判断',
                  render: (_, row) => outcomeLabels[row.currentReportedOutcome],
                },
                {
                  title: '独立人工最终结论',
                  render: (_, row) =>
                    row.finalOutcome
                      ? outcomeLabels[row.finalOutcome]
                      : '尚无人工最终结论',
                },
                {
                  title: '版本/事实',
                  render: (_, row) => (
                    <Space direction="vertical">
                      {row.revisionId !== row.currentRevisionId && (
                        <Typography.Text type="warning">
                          当前采集修订已变化，来源修订保留
                        </Typography.Text>
                      )}
                      <Button
                        onClick={() => onResult(row.resultId, row.revisionId)}
                      >
                        查看独立结果历史
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
            <Card size="small" title="人工决定保留历史">
              <Table
                rowKey="id"
                pagination={false}
                dataSource={problem.history}
                columns={[
                  { title: '动作', dataIndex: 'action' },
                  {
                    title: '操作者',
                    render: (_, row) => userName(row.actorId),
                  },
                  { title: '时间', dataIndex: 'createdAt' },
                  {
                    title: '原决定与说明',
                    render: (_, row) => (
                      <pre className="message-code">
                        {JSON.stringify(row.payload, null, 2)}
                      </pre>
                    ),
                  },
                ]}
              />
            </Card>
          </>
        )}
        {(issue || problem) && (
          <Card size="small" title="关联证据（文件与采集语境分别核对）">
            <Table
              rowKey="evidenceId"
              dataSource={issue?.evidence ?? problem?.evidence ?? []}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 800 }}
              columns={[
                {
                  title: '原件',
                  render: (_, row) => (
                    <Button type="link" onClick={() => onEvidence(row.fileId)}>
                      {row.originalName}
                    </Button>
                  ),
                },
                { title: '字节状态', dataIndex: 'fileStatus' },
                {
                  title: '当前可用',
                  render: (_, row) =>
                    row.fileAvailable
                      ? '可按当前权限读取'
                      : '尚未验证/已不可用',
                },
                {
                  title: '来源/完整性',
                  render: (_, row) =>
                    `${row.manifest.source} / ${row.manifest.captureCompleteness}`,
                },
              ]}
            />
          </Card>
        )}
        {base && (
          <details className="caption mt">
            <summary>对象标识与版本信息</summary>
            <p>
              {base.id} · 当前版本 {base.rowVersion}
            </p>
          </details>
        )}
      </div>
    </Drawer>
  );
}
