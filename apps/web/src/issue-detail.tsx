import { AuxiliaryAction } from './auxiliary-action';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { resultDetailSchema } from '../../../packages/contracts/src/ui-results';
import {
  issueDetailSchema,
  problemDetailSchema,
} from '../../../packages/contracts/src/issues';
import type {
  Issue,
  ReportProblemReviewScope,
} from '../../../packages/contracts/src/issues';
import { api, describeError } from './api';
import { useRequirementMetadata, issueSourceLabels } from './issue-context';
import {
  IssueStateTag,
  IssueSeverityTag,
  ProblemStateTag,
} from './semantic-status';
import { BeijingTime } from './beijing-time';
import { DetailDrawer } from './detail-drawer';
import type { IssueMember, IssueNavigation } from './issue-context';
import type { ActionTarget, EditorTarget, HandlingAction } from './issue-forms';
import type { MergeTarget } from './issue-batch';
import type { Project } from './types';
import { outcomeLabels } from './result-detail';
import { EvidenceGallery } from './evidence-gallery';
import type { EvidenceType } from './evidence-gallery';

export type IssueSelection = { kind: 'issue' | 'problem'; id: string };
type IssueResultLink = { resultId: string; revisionId?: string };
type IssueEvidence = z.infer<typeof issueDetailSchema>['evidence'];
type IssueReviewEvidence = NonNullable<
  z.infer<typeof issueDetailSchema>['reviewEvidence']
>;
type ReviewedResult = z.infer<typeof resultDetailSchema>['result'];

function resultLocation(
  projectId: string,
  link: IssueResultLink,
  ordinal?: number,
  report?: ReportProblemReviewScope,
) {
  const returnTo = window.location.hash;
  const params = new URLSearchParams({
    projectId,
    resultId: link.resultId,
    returnTo,
  });
  const issueId = idSchema.safeParse(
    new URLSearchParams(returnTo.split('?')[1]).get('issueId'),
  );
  if (issueId.success) params.set('fromIssueId', issueId.data);
  if (link.revisionId) params.set('resultRevisionId', link.revisionId);
  if (ordinal !== undefined) params.set('step', String(ordinal));
  if (report) {
    params.set('reportId', report.reportId);
    params.set('revisionId', report.reportRevisionId);
  }
  return `#reports?${params}`;
}

function HumanReviewEvidence({
  projectId,
  entries,
  describeActor,
  onOpen,
}: {
  projectId: string;
  entries: IssueReviewEvidence;
  describeActor: (id: string) => string;
  onOpen: (id: string, evidenceType?: EvidenceType) => void;
}) {
  if (!entries.length) return null;
  return (
    <section className="issue-human-review-evidence" aria-label="人工复核证据">
      <h3>人工复核证据</h3>
      {entries.map((entry) => (
        <Card
          key={entry.eventId}
          size="small"
          title={describeActor(entry.actorId)}
          extra={
            <Typography.Text type="secondary">
              <BeijingTime value={entry.createdAt} detail />
            </Typography.Text>
          }
        >
          {entry.retestNote && (
            <div className="issue-review-evidence-text">
              <label>复测观察</label>
              <p className="preserve-lines">{entry.retestNote}</p>
            </div>
          )}
          {entry.note && (
            <div className="issue-review-evidence-text">
              <label>复核说明</label>
              <p className="preserve-lines">{entry.note}</p>
            </div>
          )}
          {entry.resultId && (
            <a
              href={resultLocation(
                projectId,
                {
                  resultId: entry.resultId,
                  ...(entry.resultRevisionId
                    ? { revisionId: entry.resultRevisionId }
                    : {}),
                },
                entry.reportReview?.stepOrdinal,
                entry.reportReview,
              )}
              className="text-link-button"
            >
              {entry.reportReview?.stepOrdinal
                ? `定位来源第 ${entry.reportReview.stepOrdinal} 步`
                : '打开复核来源报告'}
            </a>
          )}
          {entry.images.length > 0 && (
            <EvidenceGallery
              items={entry.images.map((image) => ({
                fileId: image.fileId,
                originalName: image.originalName,
                fileAvailable: image.fileAvailable,
                source: 'manualAddition',
                manifest: {
                  localEvidenceId: image.fileId,
                  type: 'screenshot',
                  captureCompleteness: 'full',
                  capturedAt: entry.createdAt,
                },
              }))}
              onOpen={(image) => onOpen(image.fileId, 'screenshot')}
            />
          )}
        </Card>
      ))}
    </section>
  );
}

function IssueDescription({
  projectId,
  text,
}: {
  projectId: string;
  text: string;
}) {
  return (
    <p className="preserve-lines">
      {text.split(/(https?:\/\/[^\s<>"']+)/u).map((part, index) => {
        if (index % 2 === 0) return part;
        try {
          const url = new URL(part);
          if (
            url.origin !== window.location.origin ||
            !url.hash.startsWith('#reports?')
          )
            return part;
          const query = new URLSearchParams(url.hash.slice('#reports?'.length));
          const candidate = idSchema.safeParse(query.get('resultId'));
          if (!candidate.success || query.get('projectId') !== projectId)
            return part;
          const revision = idSchema.safeParse(query.get('resultRevisionId'));
          const link = {
            resultId: candidate.data,
            ...(revision.success ? { revisionId: revision.data } : {}),
          };
          return (
            <a
              key={`${index}:${candidate.data}`}
              href={resultLocation(projectId, link)}
              className="text-link-button"
            >
              打开关联测试结果
            </a>
          );
        } catch {
          return part;
        }
      })}
    </p>
  );
}

function LinkedResultEvidence({
  projectId,
  link,
  items,
  onOpen,
}: {
  projectId: string;
  link: IssueResultLink | undefined;
  items: IssueEvidence;
  onOpen: (fileId: string, evidenceType?: EvidenceType) => void;
}) {
  const [detail, setDetail] = useState<ReviewedResult | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const id = link?.resultId;
  useEffect(() => {
    setDetail(null);
    setLoadError(undefined);
    if (!id) return;
    const abort = new AbortController();
    void api(
      `/projects/${projectId}/results/${id}`,
      { signal: abort.signal },
      resultDetailSchema,
    )
      .then(({ result }) => {
        if (!abort.signal.aborted) setDetail(result);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setLoadError(describeError(error));
      });
    return () => abort.abort();
  }, [id, projectId]);
  const requested =
    detail?.id === id && link?.revisionId
      ? detail?.history.find((row) => row.id === link.revisionId)
      : undefined;
  const originalContent =
    requested?.content ??
    (detail?.id === id && !link?.revisionId ? detail?.content : undefined);
  const scope = detail?.id === id ? detail?.scopeItem : undefined;
  const observations = new Map(
    originalContent?.stepObservations?.map((observation) => [
      observation.ordinal,
      observation,
    ]),
  );
  const visibleCase = scope?.kind === 'UI' ? scope : undefined;
  const gaps = originalContent?.evidenceGaps ?? [];
  return (
    <div className="issue-repro-evidence-grid">
      <Card
        size="small"
        title="复现步骤"
        extra={
          link && <a href={resultLocation(projectId, link)}>打开关联结果 ↗</a>
        }
      >
        {id && !detail && !loadError && (
          <Skeleton active paragraph={{ rows: 2 }} />
        )}
        {loadError && <Alert type="warning" title={loadError} />}
        {!id && (
          <Typography.Text type="secondary">
            暂无关联用例步骤，详见问题描述。
          </Typography.Text>
        )}
        {requested && (
          <div className="row wrap issue-review-snapshot">
            <Tag>结果 r{requested.revisionNo}</Tag>
            {visibleCase?.revisionNo && (
              <Tag>用例 r{visibleCase.revisionNo}</Tag>
            )}
            <Tag
              color={
                originalContent?.originalOutcome === 'failed'
                  ? 'red'
                  : 'default'
              }
            >
              {outcomeLabels[requested.content.originalOutcome]}
            </Tag>
          </div>
        )}
        {detail && link?.revisionId && !requested && (
          <Alert type="warning" title="关联采集修订暂不可读取" />
        )}
        {visibleCase?.preconditions.length ? (
          <p className="caption">
            前置条件　{visibleCase.preconditions.join(' · ')}
          </p>
        ) : null}
        {visibleCase &&
          (visibleCase.steps.length ? (
            <ol className="issue-repro-steps">
              {visibleCase.steps.map((step, index) => {
                const ordinal = index + 1;
                const observed = observations.get(ordinal);
                return (
                  <li
                    className={observed?.outcome === 'failed' ? 'failed' : ''}
                    key={ordinal}
                  >
                    <strong>{step.action}</strong>
                    <div>
                      <span>预期</span> {step.expected ?? '原步骤未记录预期'}
                    </div>
                    <div>
                      <span>实际</span> {observed?.actual ?? '此步骤无独立观察'}
                    </div>
                    {observed?.outcome === 'failed' && link && (
                      <a href={resultLocation(projectId, link, ordinal)}>
                        查看第 {ordinal} 步实测
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <Alert type="info" title="原版本未记录分步" />
          ))}
        {originalContent && !observations.size && (
          <p className="preserve-lines mt">
            {originalContent.actualObservations}
          </p>
        )}
      </Card>
      <Card size="small" title="证据预览">
        <EvidenceGallery
          items={items}
          onOpen={(item) => onOpen(item.fileId, item.manifest.type)}
          emptyText="此缺陷暂没有可查看的证据"
        />
        {gaps.map((gap, index) => (
          <p className="issue-evidence-gap" key={`${gap.label}:${index}`}>
            <strong>{gap.label}</strong> ·{' '}
            {
              {
                notCaptured: '未采集',
                pendingUpload: '已采集待上传',
                uploadFailed: '上传失败',
              }[gap.state]
            }
            <br />
            {gap.reason}
          </p>
        ))}
      </Card>
    </div>
  );
}

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
  onEvidence: (id: string, evidenceType?: EvidenceType) => void;
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
  const version = requirementMetadata.requirement?.versions.find(
    (entry) => entry.id === base?.requirementVersionId,
  );
  return (
    <DetailDrawer
      open={selection !== null}
      title={base?.title ?? '问题/缺陷详情'}
      meta={
        base && (
          <>
            {activeIssue
              ? `缺陷详情 · ${activeIssue.number}`
              : `待确认问题 · ${base.id.slice(0, 8)}`}{' '}
            ·{' '}
            <span title={base.requirementId}>
              {requirementMetadata.requirement?.title ??
                (requirementMetadata.loading
                  ? '正在读取需求名称…'
                  : '需求名称暂不可用')}
            </span>{' '}
            ·{' '}
            {base.requirementVersionId
              ? version
                ? `v${version.versionNo}`
                : requirementMetadata.loading
                  ? '正在读取版本…'
                  : '需求版本资料暂不可用'
              : '未指定需求版本'}{' '}
            · {issueSourceLabels[base.source]}
          </>
        )
      }
      wide
      extra={
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
      }
      onClose={onClose}
    >
      {loading && <Skeleton active />}
      {error && <Alert type="error" title={error} showIcon />}
      <div className="issue-detail-content">
        {base && requirementMetadata.error && (
          <Alert
            type="warning"
            showIcon
            title="需求/版本名称暂未取得"
            description={requirementMetadata.error}
          />
        )}
        {issue && activeIssue && (
          <>
            <div className="row wrap mt">
              <IssueStateTag state={activeIssue.state} />
              <IssueSeverityTag severity={activeIssue.severity} />
              <span className="badge">
                负责人：{userName(activeIssue.assigneeId)}
              </span>
              {activeIssue.assigneeId && !activeIssue.assigneeActive && (
                <span className="badge red">负责人权限失效，身份保留</span>
              )}
            </div>
            {issue.resultLinks.length > 0 && <h3>原始执行证据</h3>}
            <LinkedResultEvidence
              projectId={project.id}
              link={issue.resultLinks[0]}
              items={issue.evidence}
              onOpen={onEvidence}
            />
            <HumanReviewEvidence
              projectId={project.id}
              entries={issue.reviewEvidence ?? []}
              describeActor={userName}
              onOpen={onEvidence}
            />
            <div className="divider" />
            <h3>问题描述</h3>
            <IssueDescription
              projectId={project.id}
              text={activeIssue.description}
            />
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
                <Button size="small" href={resultLocation(project.id, link)}>
                  打开关联结果
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
                      <BeijingTime value={verification.createdAt} detail /> ·{' '}
                      {verification.note || '无补充说明'}
                    </p>
                    {verification.executionProvenance ===
                      'protocol-synthetic' && (
                      <p className="caption">
                        合成协议记录，非真实UI目标执行。
                      </p>
                    )}
                    {verification.method === 'manual' && (
                      <p className="caption">
                        {verification.scopeSnapshot ? (
                          <>
                            当次需求版本：
                            {verification.scopeSnapshot.requirementVersionNo
                              ? `V${verification.scopeSnapshot.requirementVersionNo}`
                              : '未绑定具体版本'}
                            {verification.scopeSnapshot.requirementVersionId
                              ? ` · ${verification.scopeSnapshot.requirementVersionId}`
                              : ''}
                            <br />
                            当次范围：
                            {verification.scopeSnapshot.scopeDescription}
                          </>
                        ) : (
                          '旧记录未单独冻结范围和版本；不能用当前缺陷资料代替当次事实。'
                        )}
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
                    <BeijingTime value={event.createdAt} detail />
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
              <ProblemStateTag state={problem.problem.state} />
              <Tag>{problem.problem.source}</Tag>
              <IssueSeverityTag severity={problem.problem.suggestedSeverity} />
              <Tag>
                {problem.problem.sourceExecutionProvenance ===
                'protocol-synthetic'
                  ? '合成协议来源，非真实UI执行'
                  : problem.problem.sourceExecutionProvenance}
              </Tag>
            </Space>
            <div className="divider" />
            <h3>问题描述</h3>
            <IssueDescription
              projectId={project.id}
              text={problem.problem.description}
            />
            <LinkedResultEvidence
              projectId={project.id}
              link={problem.results[0]}
              items={problem.evidence}
              onOpen={onEvidence}
            />
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
          <Collapse
            items={[
              {
                key: 'all-evidence',
                label: '证据文件明细',
                children: (
                  <Table
                    rowKey="evidenceId"
                    dataSource={issue?.evidence ?? problem?.evidence ?? []}
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 800 }}
                    columns={[
                      {
                        title: '原件',
                        render: (_, row) => (
                          <Button
                            type="link"
                            onClick={() =>
                              onEvidence(row.fileId, row.manifest.type)
                            }
                          >
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
                ),
              },
            ]}
          />
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
    </DetailDrawer>
  );
}
