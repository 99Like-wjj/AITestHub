import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, Select, Skeleton, Space, Tag } from 'antd';
import type { z } from 'zod';
import type { reportFactsSchema } from '../../../packages/contracts/src/ui-results';
import type { ReportHandling } from '../../../packages/contracts/src/report-handling';
import {
  problemDetailSchema,
  recordProblemReviewRetestInputSchema,
  problemReviewRetestReceiptSchema,
  webDismissProblemInputSchema,
  problemDismissalReceiptSchema,
  problemConfirmationReceiptSchema,
  webProblemBatchPreviewSchema,
  problemBatchReceiptSchema,
} from '../../../packages/contracts/src/issues';
import type {
  Issue,
  Problem,
  ReportProblemReviewScope,
} from '../../../packages/contracts/src/issues';
import { api, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import { IssueEditor } from './issue-forms';
import type { EditorTarget } from './issue-forms';
import { ProblemConfirmationBatch } from './issue-batch';
import { problemStateLabels, useIssueContext } from './issue-context';
import {
  ReportReceiptControl,
  useReportCommandRecovery,
} from './report-command-recovery';
import { ReviewImageAttachments } from './review-image-attachments';
import type { EvidenceGalleryItem } from './evidence-gallery';
import type { Project } from './types';

type Facts = z.infer<typeof reportFactsSchema>;
type Candidate = ReportHandling['problems'][number];
type Detail = z.infer<typeof problemDetailSchema>;
type Outcome = z.infer<typeof recordProblemReviewRetestInputSchema>['outcome'];
type Category = NonNullable<
  z.infer<typeof webDismissProblemInputSchema>['category']
>;
const retestLabels: Record<Outcome, string> = {
  waiting: '待复测',
  reproduced: '已复现',
  notReproduced: '未复现',
  inconclusive: '仍无法判断',
};
const dismissOptions: { value: Category; label: string }[] = [
  { value: 'dataPreparation', label: '数据准备' },
  { value: 'environmentFailure', label: '环境故障' },
  { value: 'expectationChange', label: '业务预期变化' },
  { value: 'notDefect', label: '非缺陷' },
];

export function isBatchReviewable(problem: Candidate) {
  return problem.state === 'pendingConfirmation' && !problem.latestReviewRetest;
}

export function reportProblemLabel(problem: Candidate) {
  return problem.state === 'pendingConfirmation' && problem.latestReviewRetest
    ? retestLabels[problem.latestReviewRetest.outcome]
    : problemStateLabels[problem.state];
}

function readProblem(projectId: string, id: string, signal?: AbortSignal) {
  return api(
    `/projects/${projectId}/problems/${id}`,
    signal ? { signal } : {},
    problemDetailSchema,
  );
}

function retestContext(
  facts: Facts,
  item: Facts['items'][number],
  scope: ReportProblemReviewScope,
) {
  const url = new URL(window.location.href);
  url.hash = `reports?${new URLSearchParams({
    projectId: facts.projectId,
    reportId: scope.reportId,
    revisionId: scope.reportRevisionId,
    resultId: scope.resultId,
    resultRevisionId: scope.resultRevisionId,
    ...(scope.stepOrdinal ? { step: String(scope.stepOrdinal) } : {}),
  })}`;
  const factsLines = [
    `复核用例：${item.scopeItem.content.title}`,
    `场景：${item.scopeItem.scenario.title}`,
    `冻结需求版本：${item.scopeItem.requirementVersionId ?? '未绑定'}`,
    `用例：${item.scopeItem.caseId ?? '未绑定正式用例'}`,
    `执行：${facts.runId} · 环境 ${facts.scope.environmentId} · 构建 ${facts.scope.productBuild ?? '未记录'}`,
    `来源修订：${scope.resultRevisionId}`,
  ];
  const content = item.scopeItem.content;
  if ('steps' in content && content.kind === 'UI') {
    factsLines.push(
      ...(content.steps ?? []).map(
        (step, index) => `${index + 1}. ${step.action}；预期：${step.expected}`,
      ),
    );
  }
  const result = item.result?.content;
  if (result) {
    factsLines.push(
      `实际观察：${result.actualObservations}`,
      ...(result.stepObservations ?? []).map(
        (step) => `步骤 ${step.ordinal}：${step.actual}`,
      ),
    );
  }
  factsLines.push(`受权限保护的报告与步骤证据链接：${url}`);
  return factsLines.join('\n');
}

export function ReportReviewPanel({
  project,
  userId,
  candidate,
  item,
  facts,
  scope,
  readOnly,
  snapshot,
  onChanged,
  onConfirmed,
  onPreview,
}: {
  project: Project;
  userId: string;
  candidate: Candidate;
  item: Facts['items'][number];
  facts: Facts;
  scope: ReportProblemReviewScope;
  readOnly: boolean;
  snapshot: boolean;
  onChanged: () => Promise<void>;
  onConfirmed: (issue: Issue) => void;
  onPreview: (item: EvidenceGalleryItem) => void;
}) {
  const [projection, setProjection] = useState<Detail>();
  const [readError, setReadError] = useState<string>();
  const [copyMessage, setCopyMessage] = useState<string>();
  const [form, setForm] = useState<{
    kind: 'confirm' | 'dismiss' | 'retest';
    session: string;
    problem: Problem;
    scope: ReportProblemReviewScope;
  } | null>(null);
  const { requirements, members } = useIssueContext(
    readOnly ? null : project.id,
    true,
    userId,
  );
  const confirmReceipt = useReportCommandRecovery(
    project.id,
    'problems.confirm',
    snapshot ? null : candidate.id,
  );
  const dismissReceipt = useReportCommandRecovery(
    project.id,
    'problems.dismiss',
    snapshot ? null : candidate.id,
  );
  const retestReceipt = useReportCommandRecovery(
    project.id,
    'problems.review-retest',
    snapshot ? null : candidate.id,
  );
  function acceptCandidateReceipt(value: { problem: { id: string } }) {
    if (value.problem.id !== candidate.id)
      throw new Error('原回执不属于当前候选。');
  }
  useEffect(() => {
    if (snapshot) return;
    const controller = new AbortController();
    setProjection(undefined);
    setReadError(undefined);
    void readProblem(project.id, candidate.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProjection(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setReadError(describeError(failure));
      });
    return () => controller.abort();
  }, [project.id, candidate.id, candidate.rowVersion, snapshot]);
  const latest = candidate.latestReviewRetest;
  const candidateCurrent =
    projection &&
    projection.problem.rowVersion === candidate.rowVersion &&
    projection.problem.state === candidate.state;
  const canConfirm =
    !readOnly &&
    candidateCurrent &&
    candidate.state !== 'confirmed' &&
    (candidate.state === 'dismissed' ||
      !latest ||
      (latest.outcome === 'reproduced' &&
        latest.resultId === scope.resultId &&
        latest.resultRevisionId === scope.resultRevisionId));
  const editor = useMemo<EditorTarget | null>(
    () =>
      form?.kind === 'confirm'
        ? { kind: 'confirm', session: form.session, problem: form.problem }
        : null,
    [form],
  );
  function open(kind: NonNullable<typeof form>['kind']) {
    if (!readOnly && candidateCurrent && projection)
      setForm({
        kind,
        session: crypto.randomUUID(),
        problem: projection.problem,
        scope,
      });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(retestContext(facts, item, scope));
      setCopyMessage('复测资料已复制');
    } catch {
      setCopyMessage('无法复制，请从报告读取复测依据。');
    }
  }
  const original = projection?.results.find(
    (row) => row.resultId === scope.resultId,
  );
  const originalRevisionId =
    original?.revisionId ?? candidate.sourceResultRevisionId;
  const originalUrl = originalRevisionId
    ? `#reports?${new URLSearchParams({
        projectId: project.id,
        reportId: scope.reportId,
        resultId: scope.resultId,
        resultRevisionId: originalRevisionId,
        ...(snapshot ? { revisionId: scope.reportRevisionId } : {}),
      })}`
    : undefined;
  return (
    <section className="report-review-candidate">
      <div className="report-review-candidate-heading">
        <strong>{candidate.title}</strong>
        <Tag>{reportProblemLabel(candidate)}</Tag>
      </div>
      {originalUrl && originalRevisionId !== scope.resultRevisionId && (
        <Alert
          type="warning"
          showIcon
          title="来源采集修订与当前结果有差异"
          action={
            <Button href={originalUrl} size="small">
              查看绑定来源
            </Button>
          }
        />
      )}
      {!snapshot && projection?.problem.decisionNote && (
        <p className="caption">{projection.problem.decisionNote}</p>
      )}
      {readError && <Alert type="error" showIcon title={readError} />}
      {latest && (
        <p className="caption">
          最近复测 · {retestLabels[latest.outcome]} ·{' '}
          {new Date(latest.createdAt).toLocaleString('zh-CN')}
        </p>
      )}
      {projection?.reviewRetests?.length ? (
        <details className="report-review-history">
          <summary>查看复测记录（{projection.reviewRetests.length}）</summary>
          {projection.reviewRetests.map((retest) => (
            <article key={retest.id}>
              <div>
                <Tag>{retestLabels[retest.outcome]}</Tag>
                <small>
                  {new Date(retest.createdAt).toLocaleString('zh-CN')}
                </small>
              </div>
              <p>{retest.note || '已登记待复测'}</p>
              <small>结果修订 {retest.reportReview.resultRevisionId}</small>
              <Space wrap>
                {retest.images.map((image) => (
                  <Button
                    size="small"
                    key={image.fileId}
                    disabled={!image.fileAvailable}
                    onClick={() =>
                      onPreview({
                        fileId: image.fileId,
                        originalName: image.originalName,
                        fileAvailable: image.fileAvailable,
                        manifest: {
                          type: 'screenshot',
                          localEvidenceId: image.fileId,
                          captureCompleteness: 'full',
                          capturedAt: retest.createdAt,
                        },
                        source: 'manualAddition',
                      })
                    }
                  >
                    {image.originalName}
                    {image.fileAvailable ? '' : ' · 原件不可用'}
                  </Button>
                ))}
              </Space>
            </article>
          ))}
        </details>
      ) : null}
      {!readOnly && !form && (
        <Space wrap size={[6, 6]}>
          {candidate.state !== 'confirmed' && (
            <Button
              size="small"
              type="primary"
              disabled={!canConfirm}
              title={canConfirm ? undefined : '当前复测尚未复现或事实已变化'}
              onClick={() => open('confirm')}
            >
              {candidate.state === 'dismissed' ? '重新确认缺陷' : '确认缺陷'}
            </Button>
          )}
          {candidate.state === 'pendingConfirmation' && (
            <>
              {facts.kind === 'UI' ? (
                <Button size="small" onClick={() => void copy()}>
                  复制本地复测资料
                </Button>
              ) : (
                <Button size="small" href="#api-regression">
                  前往接口调试
                </Button>
              )}
              <Button
                size="small"
                disabled={!candidateCurrent}
                onClick={() => open('retest')}
              >
                登记复测
              </Button>
              <Button
                size="small"
                type="text"
                disabled={!candidateCurrent}
                onClick={() => open('dismiss')}
              >
                排除候选
              </Button>
            </>
          )}
        </Space>
      )}
      {copyMessage && (
        <p className="caption" role="status">
          {copyMessage}
        </p>
      )}
      {!form && !snapshot && (
        <div className="report-review-receipts">
          <ReportReceiptControl
            recovery={confirmReceipt}
            onCheck={() => {
              void confirmReceipt.check(
                problemConfirmationReceiptSchema,
                async (receipt) => {
                  acceptCandidateReceipt(receipt);
                  onConfirmed(receipt.issue);
                  await onChanged();
                },
                () => undefined,
              );
            }}
          />
          <ReportReceiptControl
            recovery={dismissReceipt}
            onCheck={() => {
              void dismissReceipt.check(
                problemDismissalReceiptSchema,
                async (receipt) => {
                  acceptCandidateReceipt(receipt);
                  await onChanged();
                },
                () => undefined,
              );
            }}
          />
          <ReportReceiptControl
            recovery={retestReceipt}
            onCheck={() => {
              void retestReceipt.check(
                problemReviewRetestReceiptSchema,
                async (receipt) => {
                  acceptCandidateReceipt(receipt);
                  await onChanged();
                },
                () => undefined,
              );
            }}
          />
        </div>
      )}
      {form?.kind === 'confirm' && editor && (
        <IssueEditor
          key={form.session}
          project={project}
          target={editor}
          requirements={requirements}
          members={members}
          reportReview={form.scope}
          onClose={() => setForm(null)}
          onSaved={async (issue) => {
            onConfirmed(issue);
            await onChanged();
          }}
        />
      )}
      {form && form.kind !== 'confirm' && (
        <ReviewDisposition
          key={form.session}
          project={project}
          target={{ ...form, kind: form.kind }}
          onClose={() => setForm(null)}
          onSaved={async (value) => {
            if (value)
              setProjection((before) =>
                before
                  ? {
                      ...before,
                      problem: value.problem,
                      reviewRetests: [
                        value.reviewRetest,
                        ...(before.reviewRetests ?? []),
                      ],
                    }
                  : before,
              );
            await onChanged();
            setForm(null);
          }}
        />
      )}
    </section>
  );
}

function ReviewDisposition({
  project,
  target,
  onClose,
  onSaved,
}: {
  project: Project;
  target: {
    kind: 'dismiss' | 'retest';
    session: string;
    problem: Problem;
    scope: ReportProblemReviewScope;
  };
  onClose: () => void;
  onSaved: (
    value?: z.infer<typeof problemReviewRetestReceiptSchema>,
  ) => Promise<void>;
}) {
  const [form] = Form.useForm<{
    outcome: Outcome;
    category: Category;
    note: string;
  }>();
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const command = useBusinessCommand(target.session);
  const operation =
    target.kind === 'retest' ? 'problems.review-retest' : 'problems.dismiss';
  const recovery = useReportCommandRecovery(
    project.id,
    operation,
    target.problem.id,
  );
  const base = `/projects/${project.id}/problems/${target.problem.id}`;
  const disabled = command.pending || recovery.commandId !== null;
  async function save(values: {
    outcome: Outcome;
    category: Category;
    note: string;
  }) {
    if (busy || recovery.commandId) return;
    if (target.kind === 'retest') {
      const receipt = await command.run((commandId) => {
        const body = recordProblemReviewRetestInputSchema.parse({
          commandId,
          rowVersion: target.problem.rowVersion,
          reportReview: target.scope,
          outcome: values.outcome,
          note: values.note ?? '',
          reviewAttachmentFileIds: files,
        });
        return recovery.send(commandId, () =>
          api(
            `${base}/review-retests`,
            { method: 'POST', body },
            problemReviewRetestReceiptSchema,
          ),
        );
      });
      if (receipt) await onSaved(receipt);
    } else {
      const receipt = await command.run((commandId) => {
        const body = webDismissProblemInputSchema.parse({
          commandId,
          rowVersion: target.problem.rowVersion,
          reportReview: target.scope,
          category: values.category,
          note: values.note,
        });
        return recovery.send(commandId, () =>
          api(
            `${base}/dismiss`,
            { method: 'POST', body },
            problemDismissalReceiptSchema,
          ),
        );
      });
      if (receipt) await onSaved();
    }
  }
  function recover() {
    const original = recovery.commandId;
    if (!original) return;
    const allowNew = () => command.closeRecoveredReceipt(original);
    if (target.kind === 'retest') {
      void recovery.check(
        problemReviewRetestReceiptSchema,
        async (receipt) => {
          if (receipt.problem.id !== target.problem.id)
            throw new Error('原复测回执不属于当前候选。');
          command.confirmRecoveredReceipt();
          await onSaved(receipt);
        },
        allowNew,
      );
    } else {
      void recovery.check(
        problemDismissalReceiptSchema,
        async (receipt) => {
          if (receipt.problem.id !== target.problem.id)
            throw new Error('原排除回执不属于当前候选。');
          command.confirmRecoveredReceipt();
          await onSaved();
        },
        allowNew,
      );
    }
  }
  const observation = (
    <Form.Item
      name="note"
      label={target.kind === 'retest' ? '复测说明' : '排除理由'}
      rules={
        target.kind === 'dismiss'
          ? [{ required: true, whitespace: true, max: 10000 }]
          : [{ max: 10000 }]
      }
    >
      <Input.TextArea rows={3} maxLength={10000} disabled={disabled} />
    </Form.Item>
  );
  return (
    <CommandDialog
      inline
      open
      title={target.kind === 'retest' ? '登记候选复测' : '排除候选'}
      command={command}
      dirty={dirty || files.length > 0}
      busy={busy}
      allowSave={!recovery.commandId}
      onClose={onClose}
      onSave={() => form.submit()}
      saveLabel={target.kind === 'retest' ? '保存复测记录' : '确认排除候选'}
    >
      <ReportReceiptControl recovery={recovery} onCheck={recover} />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ outcome: 'waiting', category: 'notDefect', note: '' }}
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => void save(values)}
      >
        {target.kind === 'retest' ? (
          <>
            <Form.Item
              name="outcome"
              label="复测状态"
              rules={[{ required: true }]}
            >
              <Select
                disabled={disabled}
                options={Object.entries(retestLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
            <ReviewImageAttachments
              projectId={project.id}
              runId={target.problem.runId}
              disabled={disabled}
              value={files}
              onChange={setFiles}
              onBusyChange={setBusy}
            >
              {observation}
            </ReviewImageAttachments>
          </>
        ) : (
          <>
            <Form.Item
              name="category"
              label="排除分类"
              rules={[{ required: true }]}
            >
              <Select disabled={disabled} options={dismissOptions} />
            </Form.Item>
            {observation}
          </>
        )}
      </Form>
    </CommandDialog>
  );
}

export function ReportReviewBatch({
  project,
  userId,
  rows,
  session,
  onClose,
  onSaved,
}: {
  project: Project;
  userId: string;
  rows: {
    candidate: Candidate;
    scope: ReportProblemReviewScope;
    title: string;
    evidence: string;
  }[];
  session: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { requirements, members } = useIssueContext(project.id, true, userId);
  const [loaded, setLoaded] = useState<Problem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      rows.map(async ({ candidate }) => {
        const { problem } = await readProblem(
          project.id,
          candidate.id,
          controller.signal,
        );
        // Retain the row version from the exact reviewed selection, so an intervening
        // change is shown by the server as an ineligible item.
        return { ...problem, rowVersion: candidate.rowVersion };
      }),
    ).then(
      (items) => {
        if (!controller.signal.aborted) setLoaded(items);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [project.id, rows]);
  const target = useMemo(
    () => (loaded ? { session, problems: loaded } : null),
    [loaded, session],
  );
  const basis = useMemo(
    () => new Map(rows.map(({ candidate, ...row }) => [candidate.id, row])),
    [rows],
  );
  if (!target)
    return (
      <section className="report-inline-command">
        <h2>批量确认范围</h2>
        {error ? (
          <Alert type="error" showIcon title={error} />
        ) : (
          <Skeleton active />
        )}
        <Button onClick={onClose}>关闭</Button>
      </section>
    );
  return (
    <ProblemConfirmationBatch
      projectId={project.id}
      target={target}
      requirements={requirements}
      members={members}
      reportBasis={basis}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function ReportBatchRecovery({
  projectId,
  reportId,
  onChanged,
}: {
  projectId: string;
  reportId: string;
  onChanged: () => Promise<void>;
}) {
  const preview = useReportCommandRecovery(
    projectId,
    'problems.preview-confirm',
    reportId,
  );
  const commit = useReportCommandRecovery(
    projectId,
    'problems.confirm-batch',
    reportId,
  );
  const [receipt, setReceipt] =
    useState<z.infer<typeof problemBatchReceiptSchema>>();
  if (
    !preview.commandId &&
    !commit.commandId &&
    !receipt &&
    !preview.message &&
    !commit.message
  )
    return null;
  return (
    <section className="report-inline-command" aria-label="原批量处理回执">
      <h2>原批量处理回执</h2>
      <ReportReceiptControl
        recovery={preview}
        onCheck={() => {
          const original = preview.commandId;
          void preview.check(
            webProblemBatchPreviewSchema,
            (value) => {
              if (
                value.previewId !== original ||
                value.items.some(
                  (row) => row.decision.reportReview?.reportId !== reportId,
                )
              )
                throw new Error('原预览没有绑定当前报告。');
            },
            () => undefined,
          );
        }}
      />
      <ReportReceiptControl
        recovery={commit}
        onCheck={() => {
          void commit.check(
            problemBatchReceiptSchema,
            async (value) => {
              setReceipt(value);
              await onChanged();
            },
            () => undefined,
          );
        }}
      />
      {receipt && (
        <ul>
          {receipt.results.map((row) => (
            <li key={row.problemId}>
              {
                {
                  confirmed: '已确认',
                  alreadyConfirmed: '此前已确认',
                  conflict: '并发冲突',
                  skipped: '已跳过',
                }[row.status]
              }
              {' · '}
              {row.issue ? (
                <a
                  href={`#issues?${new URLSearchParams({ projectId, issueId: row.issue.id })}`}
                >
                  {row.issue.number} · {row.issue.title}
                </a>
              ) : (
                row.problemId
              )}
              {row.code ? ' · ' + row.code : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
