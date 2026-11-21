import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { z } from 'zod';
import { issueSeveritySchema } from '../../../packages/contracts/src/domain';
import {
  lifecyclePreviewInputSchema,
  lifecycleCommitInputSchema,
  issueLifecyclePreviewSchema,
  issueLifecycleCommitReceiptSchema,
  mergeIssuesInputSchema,
  mergeIssuesReceiptSchema,
  unmergeIssueInputSchema,
  unmergeIssueReceiptSchema,
  previewProblemBatchInputSchema,
  webPreviewProblemBatchInputSchema,
  commitProblemBatchInputSchema,
  problemBatchPreviewSchema,
  webProblemBatchPreviewSchema,
  problemBatchReceiptSchema,
  issueListResponseSchema,
} from '../../../packages/contracts/src/issues';
import type {
  Issue,
  Problem,
  ReportProblemReviewScope,
} from '../../../packages/contracts/src/issues';
import { api, ApiError, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import type { IssueNavigation, IssueMember } from './issue-context';
import { severityLabels, problemStateLabels } from './issue-context';
import {
  ReportReceiptControl,
  useReportCommandRecovery,
} from './report-command-recovery';

export interface LifecycleTarget {
  session: string;
  action: 'close' | 'reopen';
  issues: Issue[];
}
export function IssueLifecycleBatch({
  projectId,
  target,
  onClose,
  onSaved,
}: {
  projectId: string;
  target: LifecycleTarget | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const previewCommand = useBusinessCommand(
    target ? target.session + ':preview' : null,
  );
  const commitCommand = useBusinessCommand(
    target ? target.session + ':commit' : null,
  );
  const [preview, setPreview] = useState<z.infer<
    typeof issueLifecyclePreviewSchema
  > | null>(null);
  const [receipt, setReceipt] = useState<z.infer<
    typeof issueLifecycleCommitReceiptSchema
  > | null>(null);
  useEffect(() => {
    setPreview(null);
    setReceipt(null);
  }, [target]);
  async function submit() {
    if (!target || receipt) return;
    if (!preview) {
      const response = await previewCommand.run(async (commandId) => {
        const value = await api(
          `/projects/${projectId}/issues/lifecycle-previews`,
          {
            method: 'POST',
            body: lifecyclePreviewInputSchema.parse({
              commandId,
              action: target.action,
              objectIds: target.issues.map((row) => row.id),
            }),
          },
          issueLifecyclePreviewSchema,
        );
        if (
          JSON.stringify(value.items.map((row) => row.id).sort()) !==
          JSON.stringify(target.issues.map((row) => row.id).sort())
        )
          throw new ApiError(
            '预览范围与明确选择不一致，未提交状态改变。',
            502,
            'PREVIEW_SCOPE_MISMATCH',
          );
        return value;
      });
      if (response) setPreview(response);
      return;
    }
    const response = await commitCommand.run((commandId) =>
      api(
        `/projects/${projectId}/issues/lifecycle-commit`,
        {
          method: 'POST',
          body: lifecycleCommitInputSchema.parse({
            commandId,
            previewId: preview.previewId,
            scopeDigest: preview.scopeDigest,
            objectIds: preview.items.map((row) => row.id),
          }),
        },
        issueLifecycleCommitReceiptSchema,
      ),
    );
    if (response) {
      setReceipt(response);
      await onSaved();
    }
  }
  const command = preview ? commitCommand : previewCommand;
  return (
    <CommandDialog
      open={target !== null}
      title={`批量${target?.action === 'reopen' ? '重新打开' : '关闭'} · 精确范围`}
      command={command}
      dirty={false}
      onClose={onClose}
      onSave={() => void submit()}
      saveLabel={
        receipt
          ? '已取得逐项回执'
          : preview
            ? '明确执行此预览范围'
            : '生成服务端精确预览'
      }
      allowSave={
        !receipt && (!preview || preview.items.some((row) => row.eligible))
      }
      width={1000}
    >
      <Alert
        type="info"
        title="状态操作不构造复测结果、不覆盖原始/人工结论"
        showIcon
        description="先预览确切ID与基准，再显式提交原预览全部对象；并发冲突/不适用逐项返回，不根据新筛选扩大范围。"
        className="section-alert"
      />
      {preview ? (
        <>
          <Typography.Paragraph>
            预览 {preview.previewId} · 摘要 {preview.scopeDigest}
          </Typography.Paragraph>
          <Table
            rowKey="id"
            dataSource={preview.items}
            pagination={false}
            scroll={{ x: 850 }}
            columns={[
              {
                title: '对象',
                render: (_, row) => `${row.number} ${row.title} / ${row.id}`,
              },
              { title: '固定基准', dataIndex: 'rowVersion' },
              {
                title: '资格',
                render: (_, row) => (row.eligible ? '可处理' : row.reason),
              },
              {
                title: '实际回执',
                render: (_, row) => {
                  const actual = receipt?.results.find(
                    (item) => item.objectId === row.id,
                  );
                  return actual
                    ? `${actual.status}${'code' in actual ? ` / ${actual.code}` : ''}`
                    : '尚未提交';
                },
              },
            ]}
          />
        </>
      ) : (
        <Table
          rowKey="id"
          pagination={false}
          dataSource={target?.issues ?? []}
          columns={[
            {
              title: '本次明确选择',
              render: (_, row) => `${row.number} ${row.title}`,
            },
            { title: 'ID', dataIndex: 'id' },
            { title: '读取基准', dataIndex: 'rowVersion' },
          ]}
        />
      )}
    </CommandDialog>
  );
}

export type MergeTarget =
  | { session: string; kind: 'merge'; issues: Issue[] }
  | {
      session: string;
      kind: 'unmerge';
      merge: {
        id: string;
        masterId: string;
        sourceId: string;
        rowVersion: number;
      };
    };
export function IssueMergeDialog({
  projectId,
  target,
  onClose,
  onSaved,
}: {
  projectId: string;
  target: MergeTarget | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const command = useBusinessCommand(target?.session ?? null);
  const [master, setMaster] = useState<string | null>(null);
  useEffect(() => setMaster(null), [target]);
  async function submit() {
    if (!target) return;
    const response = await command.run(async (commandId) => {
      if (target.kind === 'unmerge')
        return api(
          `/projects/${projectId}/issues/unmerge`,
          {
            method: 'POST',
            body: unmergeIssueInputSchema.parse({
              commandId,
              mergeId: target.merge.id,
              rowVersion: target.merge.rowVersion,
            }),
          },
          unmergeIssueReceiptSchema,
        );
      const main = target.issues.find((row) => row.id === master);
      if (!main) throw new Error('请明确选择主项。');
      const sources = target.issues.filter((row) => row.id !== main.id);
      return api(
        `/projects/${projectId}/issues/merge`,
        {
          method: 'POST',
          body: mergeIssuesInputSchema.parse({
            commandId,
            masterId: main.id,
            masterRowVersion: main.rowVersion,
            sourceIds: sources.map((row) => row.id),
            sourceRowVersions: Object.fromEntries(
              sources.map((row) => [row.id, row.rowVersion]),
            ),
          }),
        },
        mergeIssuesReceiptSchema,
      );
    });
    if (response) {
      await onSaved();
      onClose();
    }
  }
  return (
    <CommandDialog
      open={target !== null}
      title={
        target?.kind === 'unmerge'
          ? '明确撤销此合并关系'
          : '人工合并 · 明确主从范围'
      }
      command={command}
      dirty={Boolean(master)}
      onClose={onClose}
      onSave={() => void submit()}
      saveLabel={
        target?.kind === 'unmerge' ? '明确解除此关系' : '明确合并选定主从项'
      }
      allowSave={target?.kind === 'unmerge' || Boolean(master)}
      width={900}
    >
      <Alert
        type="warning"
        showIcon
        title="仅维护人工主从关系，不推断根因、删除记录或构造复测"
        description="撤销保留主项后来新增的内容和各条原记录；不会回滚主项为合并前副本。"
        className="section-alert"
      />
      {target?.kind === 'merge' ? (
        <>
          <Typography.Paragraph>
            本次固定 {target.issues.length}{' '}
            项，各ID/基准如下；未选中的对象不受影响。
          </Typography.Paragraph>
          <Select
            aria-label="明确主缺陷"
            value={master}
            style={{ width: '100%' }}
            onChange={setMaster}
            options={target.issues
              .filter((row) => !row.mergedIntoId)
              .map((row) => ({
                value: row.id,
                label: `主项候选 ${row.number} · ${row.title}`,
              }))}
          />
          <Table
            rowKey="id"
            pagination={false}
            dataSource={target.issues}
            columns={[
              {
                title: '主从',
                render: (_, row) => (row.id === master ? '主项' : '从项'),
              },
              {
                title: '正式缺陷',
                render: (_, row) => `${row.number} ${row.title}`,
              },
              {
                title: 'ID / 基准',
                render: (_, row) => `${row.id} / ${row.rowVersion}`,
              },
            ]}
          />
        </>
      ) : (
        target && (
          <Typography.Paragraph>
            关系 {target.merge.id} · 主项 {target.merge.masterId} · 从项{' '}
            {target.merge.sourceId} · 关系版本 {target.merge.rowVersion}
          </Typography.Paragraph>
        )
      )}
    </CommandDialog>
  );
}

interface DecisionDraft {
  target: 'new' | 'existing';
  title: string;
  description: string;
  severity: Issue['severity'];
  requirementId: string;
  requirementVersionId: string | null;
  assigneeId: string | null;
  issueId: string | null;
  issueRowVersion: number | null;
}
export interface ProblemBatchTarget {
  session: string;
  problems: Problem[];
}
export function ProblemConfirmationBatch({
  projectId,
  target,
  requirements,
  members,
  reportBasis,
  onClose,
  onSaved,
}: {
  projectId: string;
  target: ProblemBatchTarget | null;
  requirements: IssueNavigation;
  members: IssueMember[];
  reportBasis?: ReadonlyMap<
    string,
    {
      scope: ReportProblemReviewScope;
      title: string;
      evidence: string;
    }
  >;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});
  const [preview, setPreview] = useState<z.infer<
    typeof webProblemBatchPreviewSchema
  > | null>(null);
  const [receipt, setReceipt] = useState<z.infer<
    typeof problemBatchReceiptSchema
  > | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Issue[]>([]);
  const [candidateError, setCandidateError] = useState<string>();
  const previewCommand = useBusinessCommand(
    target ? `${target.session}:preview:${previewVersion}` : null,
  );
  const commitCommand = useBusinessCommand(
    target ? `${target.session}:commit:${preview?.previewId ?? 'none'}` : null,
  );
  const reviewScope =
    reportBasis?.values().next().value?.scope.reportId ?? null;
  const previewRecovery = useReportCommandRecovery(
    projectId,
    'problems.preview-confirm',
    reviewScope,
  );
  const commitRecovery = useReportCommandRecovery(
    projectId,
    'problems.confirm-batch',
    reviewScope,
  );
  useEffect(() => {
    if (!target) return;
    setPreview(null);
    setReceipt(null);
    setPreviewVersion(0);
    setQuery('');
    setCandidates([]);
    setDrafts(
      Object.fromEntries(
        target.problems.map((problem) => [
          problem.id,
          {
            target: 'new',
            title: problem.title,
            description: problem.description,
            severity: problem.suggestedSeverity,
            requirementId: problem.requirementId,
            requirementVersionId: problem.requirementVersionId,
            assigneeId: null,
            issueId: null,
            issueRowVersion: null,
          },
        ]),
      ),
    );
  }, [target]);
  useEffect(() => {
    if (!target || preview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api(
        `/projects/${projectId}/issues?participationOnly=false&search=${encodeURIComponent(query)}`,
        { signal: controller.signal },
        issueListResponseSchema,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setCandidates((previous) => [
              ...previous.filter(
                (row) => !result.issues.some((item) => item.id === row.id),
              ),
              ...result.issues,
            ]);
            setCandidateError(undefined);
          }
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            setCandidateError(describeError(failure));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [target?.session, projectId, query, preview]);
  function change(id: string, values: Partial<DecisionDraft>) {
    setDrafts((previous) => {
      const row = previous[id];
      return row ? { ...previous, [id]: { ...row, ...values } } : previous;
    });
  }
  async function submit() {
    if (
      !target ||
      receipt ||
      (reportBasis && (previewRecovery.commandId || commitRecovery.commandId))
    )
      return;
    if (!preview) {
      const response = await previewCommand.run(async (commandId) => {
        const decisions = target.problems.map((problem) => {
          const row = drafts[problem.id];
          if (!row) throw new Error('问题确认草稿尚未就绪。');
          const reportReview = reportBasis?.get(problem.id)?.scope;
          if (reportBasis && !reportReview)
            throw new Error('缺少此候选固定的报告依据。');
          return {
            problemId: problem.id,
            decision:
              row.target === 'existing'
                ? {
                    target: 'existing',
                    rowVersion: problem.rowVersion,
                    issueId: row.issueId,
                    issueRowVersion: row.issueRowVersion,
                    ...(reportReview ? { reportReview } : {}),
                  }
                : {
                    target: 'new',
                    rowVersion: problem.rowVersion,
                    requirementId: row.requirementId,
                    requirementVersionId: row.requirementVersionId,
                    title: row.title,
                    description: row.description,
                    severity: row.severity,
                    assigneeId: row.assigneeId,
                    ...(reportReview ? { reportReview } : {}),
                  },
          };
        });
        const input = (
          reportBasis
            ? webPreviewProblemBatchInputSchema
            : previewProblemBatchInputSchema
        ).parse({
          commandId,
          decisions,
        });
        const request = async () => {
          const result = await api(
            `/projects/${projectId}/problems/confirmation-previews`,
            {
              method: 'POST',
              body: input,
            },
            reportBasis
              ? webProblemBatchPreviewSchema
              : problemBatchPreviewSchema,
          );
          if (
            result.previewId !== commandId ||
            JSON.stringify(result.items.map((row) => row.problem.id).sort()) !==
              JSON.stringify(target.problems.map((row) => row.id).sort())
          )
            throw new ApiError(
              '预览问题集合与明确选择不一致。',
              502,
              'PREVIEW_SCOPE_MISMATCH',
            );
          return result;
        };
        return reportBasis
          ? previewRecovery.send(commandId, request)
          : request();
      });
      if (response) setPreview(response);
      return;
    }
    const response = await commitCommand.run((commandId) => {
      const request = async () => {
        const receipt = await api(
          `/projects/${projectId}/problems/confirm-batch`,
          {
            method: 'POST',
            body: commitProblemBatchInputSchema.parse({
              commandId,
              previewId: preview.previewId,
              scopeDigest: preview.scopeDigest,
              problemIds: preview.items.map((row) => row.problem.id),
            }),
          },
          problemBatchReceiptSchema,
        );
        if (
          receipt.previewId !== preview.previewId ||
          receipt.scopeDigest !== preview.scopeDigest ||
          JSON.stringify(receipt.results.map((row) => row.problemId).sort()) !==
            JSON.stringify(preview.items.map((row) => row.problem.id).sort())
        )
          throw new ApiError(
            '批量回执未绑定本次预览。',
            502,
            'RECEIPT_SCOPE_MISMATCH',
          );
        return receipt;
      };
      return reportBasis ? commitRecovery.send(commandId, request) : request();
    });
    if (response) {
      setReceipt(response);
      await onSaved();
    }
  }
  function checkPreview() {
    const id = previewRecovery.commandId;
    if (!id || !target) return;
    void previewRecovery.check(
      webProblemBatchPreviewSchema,
      (value) => {
        if (value.previewId !== id) throw new Error('原预览标识不一致。');
        if (
          JSON.stringify(value.items.map((row) => row.problem.id).sort()) !==
          JSON.stringify(target.problems.map((row) => row.id).sort())
        )
          throw new Error('原预览范围与当前选择不同，请按原选择重新打开核对。');
        previewCommand.confirmRecoveredReceipt();
        setPreview(value);
      },
      () => previewCommand.closeRecoveredReceipt(id),
    );
  }
  function checkCommit() {
    const id = commitRecovery.commandId;
    if (!id || !target) return;
    void commitRecovery.check(
      problemBatchReceiptSchema,
      async (value) => {
        if (
          preview &&
          (value.previewId !== preview.previewId ||
            value.scopeDigest !== preview.scopeDigest)
        )
          throw new Error('原提交未绑定当前预览。');
        setReceipt(value);
        commitCommand.confirmRecoveredReceipt();
        await onSaved();
      },
      () => commitCommand.closeRecoveredReceipt(id),
    );
  }
  const command = preview ? commitCommand : previewCommand;
  const recovering = Boolean(
    reportBasis && (commitRecovery.commandId || previewRecovery.commandId),
  );
  return (
    <CommandDialog
      open={target !== null}
      inline={!!reportBasis}
      title="问题批量确认 · 精确新建/关联"
      command={command}
      dirty={!preview}
      onClose={onClose}
      onSave={() => void submit()}
      allowSave={
        !receipt &&
        !recovering &&
        (!preview || preview.items.some((row) => row.eligible))
      }
      saveLabel={
        receipt
          ? '已取得逐项回执'
          : preview
            ? reportBasis
              ? '确认转换 ' +
                preview.items.filter((row) => row.eligible).length +
                ' 项'
              : '明确确认预览全部问题'
            : '生成服务端精确预览'
      }
      width={1100}
    >
      {reportBasis && (
        <>
          <ReportReceiptControl
            recovery={previewRecovery}
            onCheck={checkPreview}
          />
          <ReportReceiptControl
            recovery={commitRecovery}
            onCheck={checkCommit}
          />
        </>
      )}
      <Alert
        type="info"
        showIcon
        title="逐项选择新建或关联，预览后才明确提交"
        description={
          reportBasis
            ? '本次固定已选候选及其报告依据。逐项核对新建或关联的目标。'
            : '此前非缺陷的纠正会保留原决定历史。原始/最终结果不被确认覆盖；不自动合并根因，不以人工复现或补证为强制前提。'
        }
        className="section-alert"
      />
      {candidateError && (
        <Alert type="warning" showIcon title={candidateError} />
      )}
      {preview ? (
        <>
          <Typography.Paragraph>
            预览 {preview.previewId} · 摘要 {preview.scopeDigest}
          </Typography.Paragraph>
          <Table
            rowKey={(row) => row.problem.id}
            pagination={false}
            dataSource={preview.items}
            scroll={{ x: 950 }}
            columns={[
              {
                title: '原问题/决定',
                render: (_, row) => (
                  <Space direction="vertical">
                    <Typography.Text>
                      {row.problem.title} / {row.problem.id}
                    </Typography.Text>
                    <Tag>{problemStateLabels[row.problem.state]}</Tag>
                    <Typography.Text>
                      {row.problem.decisionNote}
                    </Typography.Text>
                    {reportBasis?.get(row.problem.id) && (
                      <Typography.Text type="secondary">
                        {reportBasis.get(row.problem.id)?.evidence}
                      </Typography.Text>
                    )}
                  </Space>
                ),
              },
              {
                title: '固定目标',
                render: (_, row) =>
                  row.decision.target === 'existing'
                    ? `关联 ${row.decision.issueId} / v${row.decision.issueRowVersion}`
                    : `新建 ${row.decision.title} / 需求${row.decision.requirementId}`,
              },
              {
                title: '资格',
                render: (_, row) => (row.eligible ? '可确认' : row.reason),
              },
              {
                title: '实际回执',
                render: (_, row) => {
                  const result = receipt?.results.find(
                    (item) => item.problemId === row.problem.id,
                  );
                  if (!result) return '尚未提交';
                  const label = {
                    confirmed:
                      row.decision.target === 'existing' ? '已关联' : '已新建',
                    alreadyConfirmed: '此前已确认',
                    conflict: '并发冲突',
                    skipped: '已跳过',
                  }[result.status];
                  return (
                    <Space wrap>
                      {label}
                      {result.code ? ` / ${result.code}` : ''}
                      {result.issue && (
                        <a
                          href={`#issues?${new URLSearchParams({ projectId, issueId: result.issue.id })}`}
                        >
                          {result.issue.number}
                        </a>
                      )}
                    </Space>
                  );
                },
              },
            ]}
          />
          {!receipt && (
            <Button
              disabled={
                commitCommand.pending || commitCommand.uncertain || recovering
              }
              onClick={() => {
                setPreview(null);
                setPreviewVersion((value) => value + 1);
              }}
            >
              放弃此预览，重新准备
            </Button>
          )}
        </>
      ) : receipt ? (
        <Table
          rowKey="problemId"
          size="small"
          pagination={false}
          dataSource={receipt.results}
          columns={[
            { title: '原候选', dataIndex: 'problemId' },
            { title: '回执', dataIndex: 'status' },
            {
              title: '正式缺陷',
              render: (_, result) =>
                result.issue && (
                  <a
                    href={`#issues?${new URLSearchParams({ projectId, issueId: result.issue.id })}`}
                  >
                    {result.issue.number}
                  </a>
                ),
            },
          ]}
        />
      ) : (
        <Collapse
          items={(target?.problems ?? []).map((problem) => {
            const row = drafts[problem.id];
            return {
              key: problem.id,
              label: `${problem.title} · ${problemStateLabels[problem.state]}`,
              children: row ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {reportBasis?.get(problem.id) && (
                    <Typography.Text type="secondary">
                      {reportBasis.get(problem.id)?.title} ·{' '}
                      {reportBasis.get(problem.id)?.evidence}
                    </Typography.Text>
                  )}
                  {problem.state === 'dismissed' && (
                    <Alert
                      type="warning"
                      showIcon
                      title="本项将明确纠正此前非缺陷决定"
                      description={`原说明：${problem.decisionNote || '未填写'}；原决定人/时间保留。`}
                    />
                  )}
                  <Select
                    aria-label={`问题 ${problem.id} 确认目标`}
                    style={{ width: '100%' }}
                    value={row.target}
                    disabled={command.pending}
                    options={[
                      { value: 'new', label: '新建正式缺陷' },
                      { value: 'existing', label: '关联现有正式缺陷' },
                    ]}
                    onChange={(value: DecisionDraft['target']) =>
                      change(problem.id, { target: value })
                    }
                  />
                  {row.target === 'existing' ? (
                    <Select
                      aria-label={`问题 ${problem.id} 现有正式缺陷`}
                      style={{ width: '100%' }}
                      showSearch
                      filterOption={false}
                      disabled={command.pending}
                      value={row.issueId}
                      onSearch={setQuery}
                      options={candidates.map((issue) => ({
                        value: issue.id,
                        label: `${issue.number} ${issue.title} / v${issue.rowVersion}`,
                      }))}
                      onSelect={(id: string) => {
                        const issue = candidates.find(
                          (candidate) => candidate.id === id,
                        );
                        if (issue)
                          change(problem.id, {
                            issueId: issue.id,
                            issueRowVersion: issue.rowVersion,
                          });
                      }}
                    />
                  ) : (
                    <>
                      <Typography.Text>正式需求 / 可选版本</Typography.Text>
                      <Select
                        style={{ width: '100%' }}
                        value={row.requirementId}
                        disabled={command.pending}
                        options={requirements.map((requirement) => ({
                          value: requirement.id,
                          label: requirement.title,
                        }))}
                        onChange={(id: string) =>
                          change(problem.id, {
                            requirementId: id,
                            requirementVersionId: null,
                          })
                        }
                      />
                      <Select
                        allowClear
                        style={{ width: '100%' }}
                        value={row.requirementVersionId}
                        disabled={command.pending}
                        options={(
                          requirements.find(
                            (requirement) =>
                              requirement.id === row.requirementId,
                          )?.versions ?? []
                        ).map((version) => ({
                          value: version.id,
                          label: `v${version.versionNo}`,
                        }))}
                        onChange={(id: string | undefined) =>
                          change(problem.id, {
                            requirementVersionId: id ?? null,
                          })
                        }
                      />
                      <Input
                        aria-label={`问题 ${problem.id} 缺陷标题`}
                        value={row.title}
                        maxLength={200}
                        disabled={command.pending}
                        onChange={(event) =>
                          change(problem.id, { title: event.target.value })
                        }
                      />
                      <Input.TextArea
                        aria-label={`问题 ${problem.id} 缺陷说明`}
                        value={row.description}
                        rows={4}
                        disabled={command.pending}
                        onChange={(event) =>
                          change(problem.id, {
                            description: event.target.value,
                          })
                        }
                      />
                      <Select
                        aria-label={`问题 ${problem.id} 严重程度`}
                        value={row.severity}
                        disabled={command.pending}
                        options={issueSeveritySchema.options.map((value) => ({
                          value,
                          label: severityLabels[value],
                        }))}
                        onChange={(value: Issue['severity']) =>
                          change(problem.id, { severity: value })
                        }
                      />
                      <Select
                        aria-label={`问题 ${problem.id} 负责人`}
                        value={row.assigneeId}
                        allowClear
                        disabled={command.pending}
                        style={{ width: '100%' }}
                        placeholder="可留待认领"
                        options={members.map((member) => ({
                          value: member.id,
                          label: `${member.displayName}（${member.account}）`,
                        }))}
                        onChange={(id: string | undefined) =>
                          change(problem.id, { assigneeId: id ?? null })
                        }
                      />
                    </>
                  )}
                  <Typography.Text type="secondary">
                    原问题ID {problem.id} / 基准v{problem.rowVersion}
                  </Typography.Text>
                </Space>
              ) : null,
            };
          })}
        />
      )}
    </CommandDialog>
  );
}
