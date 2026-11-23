import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
} from 'antd';
import { BugOutlined, LinkOutlined, PictureOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  fileReportIssueInputSchema,
  fileReportIssueReceiptSchema,
  issueListResponseSchema,
  reportIssueAssigneesSchema,
  resultRetestInputSchema,
  resultRetestListSchema,
  resultRetestReceiptSchema,
  type ReportProblemReviewScope,
} from '../../../packages/contracts/src/issues';
import type { reportFactsSchema } from '../../../packages/contracts/src/ui-results';
import type { ReportHandling } from '../../../packages/contracts/src/report-handling';
import { api, describeError } from './api';
import { BeijingTime } from './beijing-time';
import { CommandDialog, useBusinessCommand } from './business-command';
import { EvidenceGallery, type EvidenceGalleryItem } from './evidence-gallery';
import { severityLabels } from './issue-context';
import {
  ReportReceiptControl,
  useReportCommandRecovery,
} from './report-command-recovery';
import {
  ReviewImageAttachments,
  type ReviewPendingFile,
} from './review-image-attachments';
import { IssueStateTag } from './semantic-status';

type Retest = z.infer<typeof resultRetestListSchema>['retests'][number];
type FactItem = z.infer<typeof reportFactsSchema>['items'][number];
type Issue = ReportHandling['issues'][number];
type IssueMode = 'new' | 'existing';
const retestOptions = {
  reproduced: '已复现',
  notReproduced: '未复现',
  inconclusive: '证据不足',
} as const;
const draftSchema = z.object({
  outcome: z.enum(['reproduced', 'notReproduced', 'inconclusive']).optional(),
  reproduction: z.string(),
  note: z.string(),
  step: z.number().int().min(1).max(100).optional(),
  time: z.string(),
  files: z.array(z.string()),
});
type Draft = z.infer<typeof draftSchema>;
const localDateTime = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};

function ReportIssueDialog({
  projectId,
  scope,
  mode,
  description,
  retest,
  onClose,
  onSaved,
}: {
  projectId: string;
  scope: ReportProblemReviewScope;
  mode: IssueMode;
  description: string;
  retest?: Retest | undefined;
  onClose: () => void;
  onSaved: (
    issue: z.infer<typeof fileReportIssueReceiptSchema>['issue'],
  ) => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState(description);
  const [severity, setSeverity] = useState<'severe' | 'normal' | 'minor'>(
    'normal',
  );
  const [assigneeId, setAssignee] = useState<string>();
  const [issueId, setIssue] = useState<string>();
  const [assignees, setAssignees] = useState<
    z.infer<typeof reportIssueAssigneesSchema>['users']
  >([]);
  const [issues, setIssues] = useState<
    z.infer<typeof issueListResponseSchema>['issues']
  >([]);
  const [loadError, setLoadError] = useState<string>();
  const command = useBusinessCommand(mode);
  const recovery = useReportCommandRecovery(
    projectId,
    'issues.file-from-report',
    scope.resultRevisionId,
  );
  const sending = command.pending || Boolean(recovery.commandId);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const loading =
      mode === 'new'
        ? api(
            `/projects/${projectId}/issues/report-assignees`,
            options,
            reportIssueAssigneesSchema,
          ).then((value) => {
            if (!controller.signal.aborted) setAssignees(value.users);
          })
        : api(
            `/projects/${projectId}/issues?scope=all&participationOnly=false&includeMerged=false`,
            options,
            issueListResponseSchema,
          ).then((value) => {
            if (!controller.signal.aborted) setIssues(value.issues);
          });
    void loading.catch((error) => {
      if (!controller.signal.aborted) setLoadError(describeError(error));
    });
    return () => controller.abort();
  }, [mode, projectId]);
  function accept(receipt: z.infer<typeof fileReportIssueReceiptSchema>) {
    if (
      receipt.source.resultId !== scope.resultId ||
      receipt.source.resultRevisionId !== scope.resultRevisionId
    )
      throw new Error('原提单回执不属于此结果修订。');
    command.confirmRecoveredReceipt();
    onSaved(receipt.issue);
  }
  async function save() {
    const target = issues.find((issue) => issue.id === issueId);
    const receipt = await command.run((commandId) => {
      const body = fileReportIssueInputSchema.parse({
        commandId,
        reportReview: scope,
        ...(retest ? { retestId: retest.id } : {}),
        ...(mode === 'new'
          ? { target: mode, title, description: text, assigneeId, severity }
          : {
              target: mode,
              issueId: target?.id,
              issueRowVersion: target?.rowVersion,
            }),
      });
      return recovery.send(commandId, () =>
        api(
          `/projects/${projectId}/issues/file-from-report`,
          { method: 'POST', body },
          fileReportIssueReceiptSchema,
        ),
      );
    });
    if (receipt) accept(receipt);
  }
  return (
    <CommandDialog
      open
      title={mode === 'new' ? '提缺陷并指派' : '关联已有缺陷'}
      command={command}
      dirty={Boolean(title || text !== description || assigneeId || issueId)}
      onClose={onClose}
      onSave={() => void save()}
      saveLabel={mode === 'new' ? '确认提单并指派' : '确认关联'}
      allowSave={
        !sending &&
        (mode === 'new'
          ? Boolean(title.trim() && text.trim() && assigneeId)
          : Boolean(issueId))
      }
    >
      <ReportReceiptControl
        recovery={recovery}
        onCheck={() => {
          if (recovery.commandId)
            void recovery.check(fileReportIssueReceiptSchema, accept, () =>
              command.closeRecoveredReceipt(recovery.commandId!),
            );
        }}
      />
      {loadError && <Alert type="error" showIcon title={loadError} />}
      <p className="caption">
        来源已绑定当前结果修订
        {scope.stepOrdinal ? `的步骤 ${scope.stepOrdinal}` : ''}。
        {retest ? '已附本次人工复测及其截图。' : '报告证据可从缺陷详情查看。'}
      </p>
      <Form layout="vertical">
        {mode === 'new' ? (
          <>
            <Form.Item label="缺陷标题" htmlFor="report-issue-title" required>
              <Input
                id="report-issue-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="写清实际异常与触发条件"
                disabled={sending}
              />
            </Form.Item>
            <Form.Item
              label="复现说明、预期与实际"
              htmlFor="report-issue-description"
              required
            >
              <Input.TextArea
                id="report-issue-description"
                autoSize={{ minRows: 7, maxRows: 12 }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={sending}
              />
            </Form.Item>
            <Space orientation="vertical" className="report-result-form-fields">
              <Form.Item label="严重程度">
                <Select
                  aria-label="严重程度"
                  value={severity}
                  onChange={setSeverity}
                  disabled={sending}
                  options={Object.entries(severityLabels).map(
                    ([value, label]) => ({ value, label }),
                  )}
                />
              </Form.Item>
              <Form.Item label="指派给" required>
                <Select
                  aria-label="指派给"
                  showSearch={{ optionFilterProp: 'label' }}
                  value={assigneeId}
                  onChange={setAssignee}
                  disabled={sending}
                  placeholder="选择项目成员"
                  options={assignees.map((user) => ({
                    value: user.id,
                    label: `${user.displayName}${user.developer ? ' · 开发' : ''}`,
                  }))}
                />
              </Form.Item>
            </Space>
          </>
        ) : (
          <Form.Item label="已有缺陷" required>
            <Select
              aria-label="已有缺陷"
              showSearch={{ optionFilterProp: 'label' }}
              value={issueId}
              onChange={setIssue}
              disabled={sending}
              placeholder="按编号或标题搜索"
              options={issues.map((issue) => ({
                value: issue.id,
                label: `${issue.number} · ${issue.title}`,
              }))}
            />
          </Form.Item>
        )}
      </Form>
    </CommandDialog>
  );
}

export function ReportResultReview({
  projectId,
  userId,
  scope,
  item,
  runId,
  environment,
  issues,
  summary,
  readOnlyReason,
  pendingFiles,
  onPendingFiles,
  onOpenFile,
  onIssueSaved,
}: {
  projectId: string;
  userId: string;
  scope: ReportProblemReviewScope;
  item: FactItem;
  runId: string;
  environment: string;
  issues: readonly Issue[];
  summary: ReactNode;
  readOnlyReason?: string | undefined;
  pendingFiles?: readonly ReviewPendingFile[] | undefined;
  onPendingFiles: (files: ReviewPendingFile[]) => void;
  onOpenFile: (item: EvidenceGalleryItem) => void;
  onIssueSaved: (
    issue: z.infer<typeof fileReportIssueReceiptSchema>['issue'],
  ) => void;
}) {
  const current = item.result!;
  const content = item.scopeItem.content;
  const steps =
    content.kind === 'UI' && 'steps' in content ? (content.steps ?? []) : [];
  const step = scope.stepOrdinal ? steps[scope.stepOrdinal - 1] : undefined;
  const reference =
    current.content.actualActions?.join('\n') ||
    step?.action ||
    (content.kind === 'API'
      ? content.steps
          .map((entry, index) => `${index + 1}. ${entry.method} ${entry.name}`)
          .join('\n')
      : steps
          .map((entry, index) => `${index + 1}. ${entry.action}`)
          .join('\n'));
  const key = `aitesthub:human-retest:draft:v1:${userId}:${projectId}:${scope.resultRevisionId}`;
  const newDraft = (): Draft => ({
    reproduction: reference,
    note: '',
    time: localDateTime(),
    files: [],
    ...(scope.stepOrdinal ? { step: scope.stepOrdinal } : {}),
  });
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = draftSchema.safeParse(
        JSON.parse(sessionStorage.getItem(key) ?? 'null'),
      );
      if (saved.success) return saved.data;
    } catch {
      /* Continue with a new local draft. */
    }
    return newDraft();
  });
  const [retests, setRetests] = useState<Retest[]>();
  const [loadError, setLoadError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [editMode, setEditing] = useState<boolean>();
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [issueMode, setIssueMode] = useState<IssueMode>();
  const [detail, setDetail] = useState(false);
  const latest = retests?.[0];
  const editing = editMode ?? Boolean(!readOnlyReason && retests && !latest);
  const reproduced = latest?.outcome === 'reproduced' ? latest : undefined;
  const [base, setBase] = useState<string | null>(null);
  const command = useBusinessCommand(
    editing ? `${scope.resultRevisionId}:${base ?? ''}` : null,
  );
  const recovery = useReportCommandRecovery(
    projectId,
    'results.human-retest',
    scope.resultRevisionId,
  );
  const resultPath = `/projects/${projectId}/results/${scope.resultId}/human-retests`;
  const query = new URLSearchParams({
    reportId: scope.reportId,
    reportRevisionId: scope.reportRevisionId,
    resultRevisionId: scope.resultRevisionId,
  });
  const canFile =
    !readOnlyReason &&
    (latest?.outcome === 'reproduced' ||
      (current.content.originalOutcome === 'failed' &&
        Boolean(
          current.content.actualObservations.trim() ||
          current.content.stepObservations?.length ||
          current.content.observations?.length,
        )));
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(undefined);
    void api(
      `${resultPath}?${query}`,
      { signal: controller.signal },
      resultRetestListSchema,
    )
      .then(({ retests: found }) => {
        if (!controller.signal.aborted) setRetests(found);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeError(error));
      });
    return () => controller.abort();
  }, [resultPath, query.toString(), reload]);
  function cache(value: Draft) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
  function change(patch: Partial<Draft>) {
    setDraft((previous) => {
      const next = { ...previous, ...patch };
      cache(next);
      return next;
    });
  }
  function accept(receipt: z.infer<typeof resultRetestReceiptSchema>) {
    if (receipt.retest.reportReview.resultRevisionId !== scope.resultRevisionId)
      throw new Error('原复测回执不属于此结果修订。');
    setRetests((current) => [
      receipt.retest,
      ...(current ?? []).filter((entry) => entry.id !== receipt.retest.id),
    ]);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* The accepted receipt is authoritative. */
    }
    onPendingFiles([]);
    setDraft(newDraft());
    setNotice('复测记录已提交');
    setEditing(false);
    command.confirmRecoveredReceipt();
  }
  const disabled = Boolean(
    readOnlyReason || command.pending || recovery.commandId,
  );
  async function save() {
    if (disabled || attachmentBusy) return;
    const source = { ...scope };
    delete source.stepOrdinal;
    const receipt = await command.run((commandId) => {
      const body = resultRetestInputSchema.parse({
        commandId,
        reportReview: {
          ...source,
          ...(draft.step ? { stepOrdinal: draft.step } : {}),
        },
        baseRetestId: base,
        outcome: draft.outcome,
        reproduction: draft.reproduction,
        note: draft.note,
        observedAt: new Date(draft.time).toISOString(),
        reviewAttachmentFileIds: draft.files,
      });
      return recovery.send(commandId, () =>
        api(resultPath, { method: 'POST', body }, resultRetestReceiptSchema),
      );
    });
    if (receipt) accept(receipt);
  }
  const evidenceNames = current.content.evidenceRefs.length;
  const issueDescription = [
    `环境与前提\n${environment}${'preconditions' in content ? '\n' + content.preconditions.join('\n') : ''}`,
    `复现过程\n${reproduced?.reproduction || reference || '请补充复现过程'}`,
    `预期结果\n${step?.expected || ('expected' in content ? content.expected : '') || '请补充预期结果'}`,
    `实际观察\n${
      reproduced?.note ||
      current.content.observations?.map((entry) => entry.actual).join('\n') ||
      current.content.stepObservations?.find(
        (entry) => entry.ordinal === scope.stepOrdinal,
      )?.actual ||
      current.content.actualObservations
    }`,
    `影响\n请补充受影响的业务对象或操作。\n\n来源\n执行 ${runId} · 关联报告证据 ${evidenceNames} 项`,
  ].join('\n\n');
  return (
    <div className="report-result-review">
      <div className="report-result-actions">
        <Button
          icon={<LinkOutlined />}
          disabled={!canFile || issues.length > 0}
          onClick={() => setIssueMode('existing')}
        >
          关联已有
        </Button>
        {issues.length ? (
          <Button
            type="primary"
            icon={<BugOutlined />}
            onClick={() => setDetail(true)}
          >
            查看缺陷
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<BugOutlined />}
            disabled={!canFile}
            onClick={() => setIssueMode('new')}
          >
            提缺陷并指派
          </Button>
        )}
      </div>
      {summary}
      {readOnlyReason && <p className="caption">{readOnlyReason}</p>}
      {!readOnlyReason && !canFile && !issues.length && (
        <p className="caption">登记已复现的观察后可提缺陷或关联已有缺陷。</p>
      )}
      {loadError && (
        <Alert
          type="warning"
          showIcon
          title={loadError}
          action={
            <Button size="small" onClick={() => setReload((n) => n + 1)}>
              重新读取
            </Button>
          }
        />
      )}
      <ReportReceiptControl
        recovery={recovery}
        onCheck={() => {
          if (recovery.commandId)
            void recovery.check(resultRetestReceiptSchema, accept, () =>
              command.closeRecoveredReceipt(recovery.commandId!),
            );
        }}
      />
      {notice && (
        <p className="caption" role="status">
          {notice}
        </p>
      )}
      {!readOnlyReason && !editing && !!retests && (
        <Button
          icon={<PictureOutlined />}
          disabled={Boolean(recovery.commandId)}
          onClick={() => {
            setBase(latest?.id ?? null);
            setEditing(true);
            setNotice('');
          }}
        >
          登记人工复测
        </Button>
      )}
      {!readOnlyReason && editing && (
        <section className="report-retest-editor" aria-label="人工复测画布">
          <h3>登记人工复测</h3>
          <ReviewImageAttachments
            projectId={projectId}
            runId={runId}
            disabled={disabled}
            value={draft.files}
            onChange={(files) => change({ files })}
            onBusyChange={setAttachmentBusy}
            {...(pendingFiles ? { pendingFiles } : {})}
            onPendingFilesChange={onPendingFiles}
          >
            <label>
              复测记录
              <Input.TextArea
                rows={3}
                maxLength={10000}
                value={draft.note}
                placeholder="描述真实环境中观察到的结果，可直接粘贴截图"
                disabled={disabled}
                onChange={(e) => change({ note: e.target.value })}
              />
            </label>
          </ReviewImageAttachments>
          <div className="report-retest-field-row">
            <label>
              关联步骤
              <InputNumber
                min={1}
                max={Math.max(steps.length, scope.stepOrdinal ?? 0, 0)}
                value={draft.step ?? null}
                disabled={disabled || (!steps.length && !scope.stepOrdinal)}
                placeholder="用例级"
                onChange={(value) => change({ step: value ?? undefined })}
              />
            </label>
            <label>
              复测结论
              <Select
                aria-label="复测结论"
                value={draft.outcome}
                options={Object.entries(retestOptions).map(
                  ([value, label]) => ({ value, label }),
                )}
                disabled={disabled}
                onChange={(outcome) => change({ outcome })}
                placeholder="选择实际复测结论"
              />
            </label>
          </div>
          <details className="report-retest-context" open={!reference}>
            <summary>环境、复现过程与复测时间</summary>
            <p className="report-retest-source">
              {environment} · {content.title}
            </p>
            <label>
              复现过程
              <Input.TextArea
                rows={2}
                maxLength={10000}
                value={draft.reproduction}
                disabled={disabled}
                onChange={(e) => change({ reproduction: e.target.value })}
              />
            </label>
            <label>
              复测时间
              <Input
                type="datetime-local"
                value={draft.time}
                disabled={disabled}
                onChange={(e) => change({ time: e.target.value })}
              />
            </label>
          </details>
          {command.error && (
            <Alert
              type="error"
              title={command.error}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(false);
                    setReload((n) => n + 1);
                  }}
                >
                  核对当前基准
                </Button>
              }
            />
          )}
          <Space wrap className="report-retest-submit">
            <Button
              disabled={disabled}
              onClick={() =>
                setNotice(
                  cache(draft)
                    ? '草稿已保存在此浏览器'
                    : '当前浏览器无法保存草稿，此页仍保留输入',
                )
              }
            >
              保存草稿
            </Button>
            <Button
              type="primary"
              disabled={
                disabled ||
                attachmentBusy ||
                !draft.outcome ||
                !draft.note.trim() ||
                !draft.reproduction.trim() ||
                !draft.time
              }
              loading={command.pending}
              onClick={() => void save()}
            >
              提交复核
            </Button>
          </Space>
        </section>
      )}
      {latest && (
        <details
          className="report-review-history"
          open={Boolean(readOnlyReason)}
        >
          <summary>
            人工复测记录 · {retests?.length}{' '}
            <Tag>{retestOptions[latest.outcome]}</Tag>
          </summary>
          {retests?.map((entry) => (
            <article key={entry.id}>
              <strong>{retestOptions[entry.outcome]}</strong>
              <p className="caption">
                <BeijingTime value={entry.observedAt} detail />
                {entry.reportReview.stepOrdinal
                  ? ` · 第 ${entry.reportReview.stepOrdinal} 步`
                  : ' · 用例级'}
              </p>
              <p className="preserve-lines">{entry.reproduction}</p>
              <p className="preserve-lines">{entry.note}</p>
              {entry.images.length > 0 && (
                <EvidenceGallery
                  items={entry.images.map((image) => ({
                    fileId: image.fileId,
                    fileAvailable: image.fileAvailable,
                    originalName: image.originalName,
                    manifest: {
                      localEvidenceId: image.fileId,
                      type: 'screenshot',
                      captureCompleteness: 'full',
                    },
                    source: 'manualAddition',
                  }))}
                  onOpen={onOpenFile}
                />
              )}
            </article>
          ))}
        </details>
      )}
      {detail && (
        <Modal
          open
          title="关联缺陷"
          footer={null}
          onCancel={() => setDetail(false)}
        >
          {issues.map((issue) => (
            <article key={issue.id} className="report-linked-issue">
              <a
                href={`#issues?${new URLSearchParams({ projectId, issueId: issue.id })}`}
              >
                {issue.number} · {issue.title}
              </a>
              <div>
                <IssueStateTag state={issue.state} /> 负责人{' '}
                {issue.assignee?.displayName ?? '未指派'}
              </div>
            </article>
          ))}
        </Modal>
      )}
      {issueMode && (
        <ReportIssueDialog
          projectId={projectId}
          mode={issueMode}
          scope={
            latest?.outcome === 'reproduced'
              ? {
                  ...scope,
                  ...(latest.reportReview.stepOrdinal
                    ? { stepOrdinal: latest.reportReview.stepOrdinal }
                    : {}),
                }
              : scope
          }
          description={issueDescription}
          retest={latest?.outcome === 'reproduced' ? latest : undefined}
          onClose={() => setIssueMode(undefined)}
          onSaved={(issue) => {
            setIssueMode(undefined);
            setNotice(`${issue.number} 已关联 · 可在缺陷管理中查看`);
            onIssueSaved(issue);
          }}
        />
      )}
    </div>
  );
}
