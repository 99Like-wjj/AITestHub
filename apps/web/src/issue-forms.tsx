import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Select,
  Space,
  Typography,
} from 'antd';
import { z } from 'zod';
import { issueSeveritySchema } from '../../../packages/contracts/src/domain';
import {
  createIssueInputSchema,
  issueEditInputSchema,
  confirmProblemInputSchema,
  issueResponseSchema,
  problemConfirmationReceiptSchema,
  issueListResponseSchema,
  dismissProblemInputSchema,
  problemDismissalReceiptSchema,
  issueHandlingInputSchema,
  issueSeverityInputSchema,
  manualVerificationInputSchema,
  manualVerificationReceiptSchema,
  singleIssueLifecycleInputSchema,
  issueDetailSchema,
} from '../../../packages/contracts/src/issues';
import type { Issue, Problem } from '../../../packages/contracts/src/issues';
import type { Project } from './types';
import type { IssueNavigation, IssueMember } from './issue-context';
import { issueStateLabels, severityLabels } from './issue-context';
import { api, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import { ProjectAttachments } from './project-attachments';

interface IssueFields {
  title: string;
  description: string;
  severity: Issue['severity'];
  requirementId: string;
  requirementVersionId: string | null;
  assigneeId: string | null;
  resultIds: string[];
  target: 'new' | 'existing';
  existingIssueId: string;
  note: string;
  scopeDescription: string;
  outcome: 'passed' | 'failed';
  attachmentFileIds: string[];
  returnToInProgress: boolean;
  resolution: 'fixed' | 'notDefect';
}
export function RequirementFields({
  requirements,
  disabled,
}: {
  requirements: IssueNavigation;
  disabled: boolean;
}) {
  const form = Form.useFormInstance<IssueFields>();
  const requirementId = Form.useWatch('requirementId', form) as
    string | undefined;
  const versionId = Form.useWatch('requirementVersionId', form) as
    string | undefined;
  const options = requirements.map((row) => ({
    value: row.id,
    label: `${row.title}${row.archived ? '（已归档）' : ''}`,
  }));
  if (requirementId && !options.some((row) => row.value === requirementId))
    options.push({
      value: requirementId,
      label: `原需求 ${requirementId}（目录未取得）`,
    });
  const versions =
    requirements
      .find((row) => row.id === requirementId)
      ?.versions.map((row) => ({
        value: row.id,
        label: `v${row.versionNo} · ${row.id}`,
      })) ?? [];
  if (versionId && !versions.some((row) => row.value === versionId))
    versions.push({
      value: versionId,
      label: `原版本 ${versionId}（目录未取得）`,
    });
  return (
    <>
      <Form.Item
        name="requirementId"
        label="正式需求归属"
        rules={[{ required: true, message: '请选择本项目正式需求' }]}
      >
        <Select
          disabled={disabled}
          showSearch
          optionFilterProp="label"
          options={options}
          onChange={() => form.setFieldValue('requirementVersionId', null)}
        />
      </Form.Item>
      <Form.Item name="requirementVersionId" label="需求版本（手工发现可留空）">
        <Select
          disabled={disabled || !requirementId}
          allowClear
          options={versions}
        />
      </Form.Item>
    </>
  );
}
function AssigneeField({
  members,
  disabled,
  required = false,
}: {
  members: IssueMember[];
  disabled: boolean;
  required?: boolean;
}) {
  const form = Form.useFormInstance<IssueFields>();
  const selected = Form.useWatch('assigneeId', form) as string | undefined;
  const options = members.map((row) => ({
    value: row.id,
    label: `${row.displayName}（${row.account}）`,
    disabled: false,
  }));
  if (selected && !options.some((row) => row.value === selected))
    options.push({
      value: selected,
      label: `原负责人 ${selected}（当前不在有效候选）`,
      disabled: true,
    });
  return (
    <Form.Item
      name="assigneeId"
      label={
        required ? '明确转交给本项目有效成员' : '负责人（可空，进入待认领池）'
      }
      rules={required ? [{ required: true }] : []}
    >
      <Select
        disabled={disabled}
        allowClear
        showSearch
        optionFilterProp="label"
        options={options}
      />
    </Form.Item>
  );
}
export type EditorTarget =
  | { session: string; kind: 'new' }
  | { session: string; kind: 'edit'; issue: Issue }
  | { session: string; kind: 'confirm'; problem: Problem };
export function IssueEditor({
  project,
  target,
  requirements,
  members,
  onClose,
  onSaved,
}: {
  project: Project;
  target: EditorTarget | null;
  requirements: IssueNavigation;
  members: IssueMember[];
  onClose: () => void;
  onSaved: (issue: Issue) => Promise<void>;
}) {
  const [form] = Form.useForm<IssueFields>();
  const command = useBusinessCommand(target?.session ?? null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [existing, setExisting] = useState<Issue[]>([]);
  const [chosen, setChosen] = useState<Issue | null>(null);
  const choice = Form.useWatch('target', form) as
    IssueFields['target'] | undefined;
  useEffect(() => {
    if (!target) return;
    form.resetFields();
    setDirty(false);
    setChosen(null);
    setQuery('');
    setExisting([]);
    const basis =
      target.kind === 'edit'
        ? target.issue
        : target.kind === 'confirm'
          ? target.problem
          : null;
    form.setFieldsValue({
      title: basis?.title ?? '',
      description: basis?.description ?? '',
      severity:
        basis && 'severity' in basis
          ? basis.severity
          : basis && 'suggestedSeverity' in basis
            ? basis.suggestedSeverity
            : 'normal',
      requirementId: basis?.requirementId ?? '',
      requirementVersionId: basis?.requirementVersionId ?? null,
      assigneeId: target.kind === 'edit' ? target.issue.assigneeId : null,
      resultIds: [],
      target: 'new',
    });
  }, [target, form]);
  useEffect(() => {
    if (target?.kind !== 'confirm' || choice !== 'existing') return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api(
        `/projects/${project.id}/issues?participationOnly=false&search=${encodeURIComponent(query)}`,
        { signal: controller.signal },
        issueListResponseSchema,
      )
        .then((result) => {
          if (!controller.signal.aborted) setExisting(result.issues);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            command.setError(
              failure instanceof Error
                ? failure.message
                : '正式缺陷搜索未完成。',
            );
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [target?.session, choice, query, project.id]);
  async function save(values: IssueFields) {
    if (!target) return;
    const response = await command.run(async (commandId) => {
      if (target.kind === 'confirm') {
        let body: unknown;
        if (values.target === 'existing') {
          if (!chosen || chosen.id !== values.existingIssueId)
            throw new Error('请搜索并明确选择现有正式缺陷；不会猜测目标版本。');
          body = confirmProblemInputSchema.parse({
            target: 'existing',
            commandId,
            rowVersion: target.problem.rowVersion,
            issueId: chosen.id,
            issueRowVersion: chosen.rowVersion,
          });
        } else
          body = confirmProblemInputSchema.parse({
            target: 'new',
            commandId,
            rowVersion: target.problem.rowVersion,
            requirementId: values.requirementId,
            requirementVersionId: values.requirementVersionId ?? null,
            title: values.title,
            description: values.description,
            severity: values.severity,
            assigneeId: values.assigneeId ?? null,
          });
        return (
          await api(
            `/projects/${project.id}/problems/${target.problem.id}/confirm`,
            { method: 'POST', body },
            problemConfirmationReceiptSchema,
          )
        ).issue;
      }
      if (target.kind === 'edit')
        return (
          await api(
            `/projects/${project.id}/issues/${target.issue.id}`,
            {
              method: 'PUT',
              body: issueEditInputSchema.parse({
                commandId,
                rowVersion: target.issue.rowVersion,
                title: values.title,
                description: values.description,
                severity: values.severity,
              }),
            },
            issueResponseSchema,
          )
        ).issue;
      return (
        await api(
          `/projects/${project.id}/issues`,
          {
            method: 'POST',
            body: createIssueInputSchema.parse({
              commandId,
              requirementId: values.requirementId,
              requirementVersionId: values.requirementVersionId ?? null,
              title: values.title,
              description: values.description,
              severity: values.severity,
              assigneeId: values.assigneeId ?? null,
              manualOrigin: project.roles.includes('tester')
                ? 'tester'
                : 'product',
              resultIds: values.resultIds ?? [],
            }),
          },
          issueResponseSchema,
        )
      ).issue;
    });
    if (response) {
      setDirty(false);
      await onSaved(response);
      onClose();
    }
  }
  const existingOptions = existing.map((row) => ({
    value: row.id,
    label: `${row.number} · ${row.title} · v${row.rowVersion}`,
  }));
  if (chosen && !existingOptions.some((row) => row.value === chosen.id))
    existingOptions.push({
      value: chosen.id,
      label: `${chosen.number} · ${chosen.title} · 已选基准v${chosen.rowVersion}`,
    });
  return (
    <CommandDialog
      open={target !== null}
      title={
        target?.kind === 'confirm'
          ? target.problem.state === 'dismissed'
            ? '明确改为正式缺陷'
            : '测试确认问题'
          : target?.kind === 'edit'
            ? '编辑正式缺陷'
            : '手工创建正式缺陷'
      }
      command={command}
      dirty={dirty}
      onClose={onClose}
      onSave={() => form.submit()}
      saveLabel={
        target?.kind === 'confirm' ? '明确确认此关联/正式缺陷' : '保存正式缺陷'
      }
    >
      <Alert
        type="info"
        showIcon
        title="正式缺陷、原始结果与人工最终结论独立"
        description="手工缺陷必须关联正式需求，可不指定需求版本或用例。创建/确认不重写测试事实，负责人可空；不自动加入需求、执行复测或关闭。"
        className="section-alert"
      />
      {target?.kind === 'confirm' && target.problem.state === 'dismissed' && (
        <Alert
          type="warning"
          showIcon
          title="此前已判定非缺陷；本次是主动纠正为正式缺陷"
          description={`此前说明：${target.problem.decisionNote || '未填写说明'}。原决定及操作者/时间保留在业务历史。`}
          className="section-alert"
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => void save(values)}
      >
        {target?.kind === 'confirm' && (
          <Form.Item name="target" label="本次明确决定">
            <Select
              disabled={command.pending}
              options={[
                { value: 'new', label: '新建正式缺陷' },
                {
                  value: 'existing',
                  label: '关联现有正式缺陷，不重开/复制目标',
                },
              ]}
            />
          </Form.Item>
        )}
        {target?.kind === 'confirm' && choice === 'existing' ? (
          <>
            <Form.Item
              name="existingIssueId"
              label="搜索现有正式缺陷"
              rules={[{ required: true }]}
            >
              <Select
                disabled={command.pending}
                showSearch
                filterOption={false}
                onSearch={setQuery}
                options={existingOptions}
                onSelect={(id: string) =>
                  setChosen(
                    existing.find((row) => row.id === id) ??
                      (chosen?.id === id ? chosen : null),
                  )
                }
              />
            </Form.Item>
            <Typography.Text type="secondary">
              按当前项目编号/标题/描述搜索，选择时固定目标并发版本；不按名称自动合并。
            </Typography.Text>
          </>
        ) : (
          <>
            {target?.kind !== 'edit' && (
              <RequirementFields
                requirements={requirements}
                disabled={command.pending}
              />
            )}
            <Form.Item
              name="title"
              label="标题"
              rules={[{ required: true, whitespace: true, max: 200 }]}
            >
              <Input maxLength={200} disabled={command.pending} />
            </Form.Item>
            <Form.Item
              name="description"
              label="实际现象、业务预期与说明"
              rules={[{ required: true, whitespace: true, max: 100000 }]}
            >
              <Input.TextArea rows={6} disabled={command.pending} />
            </Form.Item>
            <Form.Item
              name="severity"
              label="严重程度"
              rules={[{ required: true }]}
            >
              <Select
                disabled={command.pending}
                options={issueSeveritySchema.options.map((value) => ({
                  value,
                  label: severityLabels[value],
                }))}
              />
            </Form.Item>
            {target?.kind !== 'edit' && (
              <AssigneeField members={members} disabled={command.pending} />
            )}
            {target?.kind === 'new' && (
              <Form.Item
                name="resultIds"
                label="关联已有结果 UUID（可留空，不强制指定用例）"
              >
                <Select
                  mode="tags"
                  disabled={command.pending}
                  tokenSeparators={[',', ' ']}
                />
              </Form.Item>
            )}
          </>
        )}
      </Form>
    </CommandDialog>
  );
}

export type HandlingAction = z.infer<typeof issueHandlingInputSchema>['action'];
export type ActionTarget =
  | { session: string; issue: Issue; kind: 'handling'; action: HandlingAction }
  | {
      session: string;
      issue: Issue;
      kind: 'severity' | 'verification' | 'close' | 'reopen';
    }
  | { session: string; problem: Problem; kind: 'dismiss' };
const actionLabels: Record<HandlingAction, string> = {
  claim: '主动认领',
  assign: '组织指派',
  transfer: '转交',
  return: '退回待认领池',
  takeover: '接替他人负责',
  'start-processing': '开始处理',
  'ready-for-retest': '提交处理，等待复测',
};
export function IssueActionEditor({
  project,
  target,
  members,
  onClose,
  onSaved,
}: {
  project: Project;
  target: ActionTarget | null;
  members: IssueMember[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<IssueFields>();
  const command = useBusinessCommand(target?.session ?? null);
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [handlingBasis, setHandlingBasis] = useState<Issue | null>(null);
  const [comparison, setComparison] = useState<Issue | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const refreshController = useRef<AbortController | null>(null);
  const staleHandling =
    target?.kind === 'handling' && command.errorCode === 'STALE_BASE_REVISION';
  const outcome = Form.useWatch('outcome', form) as string | undefined;
  useEffect(() => {
    refreshController.current?.abort();
    setHandlingBasis(null);
    setComparison(null);
    setRefreshing(false);
    setRefreshError(undefined);
    if (!target) return;
    form.resetFields();
    setDirty(false);
    setUploading(false);
    form.setFieldsValue({
      note: '',
      assigneeId: target.kind === 'handling' ? target.issue.assigneeId : null,
      severity: 'issue' in target ? target.issue.severity : 'normal',
      attachmentFileIds: [],
      returnToInProgress: false,
      resolution: 'fixed',
    });
    return () => refreshController.current?.abort();
  }, [target, form]);
  async function refreshHandling() {
    if (target?.kind !== 'handling' || refreshing || command.pending) return;
    const captured = target;
    const controller = new AbortController();
    refreshController.current?.abort();
    refreshController.current = controller;
    setRefreshing(true);
    setRefreshError(undefined);
    setComparison(null);
    try {
      const result = await api(
        `/projects/${project.id}/issues/${target.issue.id}`,
        { signal: controller.signal },
        issueDetailSchema,
      );
      if (!controller.signal.aborted && currentTarget.current === captured)
        setComparison(result.issue);
    } catch (failure) {
      if (!controller.signal.aborted && currentTarget.current === captured)
        setRefreshError(describeError(failure));
    } finally {
      if (!controller.signal.aborted && currentTarget.current === captured)
        setRefreshing(false);
    }
  }
  function memberName(id: string | null) {
    if (id === null) return '待认领';
    const member = members.find((row) => row.id === id);
    return member ? `${member.displayName}（${member.account}）` : id;
  }
  async function save(values: IssueFields) {
    if (!target || uploading || refreshing || staleHandling) return;
    const response = await command.run(async (commandId) => {
      if (target.kind === 'dismiss')
        return api(
          `/projects/${project.id}/problems/${target.problem.id}/dismiss`,
          {
            method: 'POST',
            body: dismissProblemInputSchema.parse({
              commandId,
              rowVersion: target.problem.rowVersion,
              note: values.note ?? '',
            }),
          },
          problemDismissalReceiptSchema,
        );
      const base = {
        commandId,
        rowVersion:
          target.kind === 'handling'
            ? (handlingBasis ?? target.issue).rowVersion
            : target.issue.rowVersion,
      };
      if (target.kind === 'handling')
        return api(
          `/projects/${project.id}/issues/${target.issue.id}/handling`,
          {
            method: 'POST',
            body: issueHandlingInputSchema.parse({
              ...base,
              action: target.action,
              note: values.note ?? '',
              ...(['assign', 'transfer'].includes(target.action)
                ? { assigneeId: values.assigneeId ?? null }
                : {}),
            }),
          },
          issueResponseSchema,
        );
      if (target.kind === 'severity')
        return api(
          `/projects/${project.id}/issues/${target.issue.id}/severity`,
          {
            method: 'POST',
            body: issueSeverityInputSchema.parse({
              ...base,
              severity: values.severity,
            }),
          },
          issueResponseSchema,
        );
      if (target.kind === 'verification')
        return api(
          `/projects/${project.id}/issues/${target.issue.id}/manual-verification`,
          {
            method: 'POST',
            body: manualVerificationInputSchema.parse({
              ...base,
              outcome: values.outcome,
              note: values.note ?? '',
              attachmentFileIds: values.attachmentFileIds ?? [],
              scopeDescription: values.scopeDescription ?? '',
              returnToInProgress:
                values.outcome === 'failed' && values.returnToInProgress,
            }),
          },
          manualVerificationReceiptSchema,
        );
      return api(
        `/projects/${project.id}/issues/${target.issue.id}/lifecycle`,
        {
          method: 'POST',
          body: singleIssueLifecycleInputSchema.parse({
            ...base,
            action: target.kind,
            resolution: values.resolution ?? 'fixed',
            note: values.note ?? '',
          }),
        },
        issueResponseSchema,
      );
    });
    if (response) {
      setDirty(false);
      await onSaved();
      onClose();
    }
  }
  const title =
    target?.kind === 'handling'
      ? actionLabels[target.action]
      : target?.kind === 'dismiss'
        ? '测试判定非缺陷'
        : target?.kind === 'verification'
          ? '登记人工复测'
          : target?.kind === 'severity'
            ? '调整严重程度'
            : target?.kind === 'close'
              ? '明确关闭正式缺陷'
              : '明确重新打开正式缺陷';
  return (
    <CommandDialog
      open={target !== null}
      title={title}
      command={command}
      dirty={dirty}
      busy={uploading || refreshing}
      allowSave={!staleHandling}
      onClose={onClose}
      onSave={() => form.submit()}
      saveLabel={title}
    >
      {staleHandling && (
        <Alert
          type="warning"
          showIcon
          className="section-alert"
          title="指派基准已变化，当前负责人选择和说明草稿已保留"
          description={
            <Space direction="vertical">
              <span>
                请先只读刷新并比较最新状态，再明确采用新基准；不会自动覆盖或提交。
              </span>
              <Button
                loading={refreshing}
                disabled={command.pending || command.uncertain}
                onClick={() => void refreshHandling()}
              >
                保留草稿并刷新最新状态
              </Button>
              {refreshError && (
                <Typography.Text type="danger">{refreshError}</Typography.Text>
              )}
              {comparison && target?.kind === 'handling' && (
                <>
                  <span>
                    编辑基准 v{(handlingBasis ?? target.issue).rowVersion}：
                    {memberName((handlingBasis ?? target.issue).assigneeId)}
                    ；最新 v{comparison.rowVersion}：
                    {memberName(comparison.assigneeId)} ·{' '}
                    {issueStateLabels[comparison.state]}
                  </span>
                  <Button
                    onClick={() => {
                      setHandlingBasis(comparison);
                      setComparison(null);
                      command.setError(undefined);
                    }}
                  >
                    采用最新基准，保留草稿继续编辑
                  </Button>
                </>
              )}
            </Space>
          }
        />
      )}
      {!staleHandling && handlingBasis && (
        <Alert
          type="info"
          showIcon
          className="section-alert"
          title={`已采用最新基准 v${handlingBasis.rowVersion}，原负责人选择和说明草稿保留`}
          description="请核对草稿后再次明确保存；期间若又有修改，仍按并发版本校验。"
        />
      )}
      <Alert
        type="info"
        showIcon
        title={
          target?.kind === 'verification'
            ? '复测记录与缺陷状态独立；通过不会自动关闭'
            : target?.kind === 'close' || target?.kind === 'reopen'
              ? '本操作只改变缺陷状态，不构造复测结果'
              : '处理决定会保留历史记录'
        }
        description={
          target
            ? `对象 ${'issue' in target ? target.issue.number : target.problem.id}${target.kind === 'handling' ? '；负责人变化不会自动加入需求或授予业务角色。' : ''}`
            : ''
        }
        className="section-alert"
      />
      <Form
        form={form}
        layout="vertical"
        onValuesChange={() => setDirty(true)}
        onFinish={(values) => void save(values)}
      >
        {target?.kind === 'handling' &&
          ['assign', 'transfer'].includes(target.action) && (
            <AssigneeField
              members={members}
              disabled={command.pending}
              required={target.action === 'transfer'}
            />
          )}
        {target?.kind === 'severity' ? (
          <Form.Item name="severity" label="严重程度">
            <Select
              disabled={command.pending}
              options={issueSeveritySchema.options.map((value) => ({
                value,
                label: severityLabels[value],
              }))}
            />
          </Form.Item>
        ) : (
          <>
            {target?.kind === 'verification' && (
              <>
                <Alert
                  type="info"
                  showIcon
                  className="section-alert"
                  title={
                    target.issue.requirementVersionId
                      ? `本次沿用该缺陷的需求版本 ${target.issue.requirementVersionId}`
                      : '该缺陷未绑定具体需求版本，本次不会虚构版本。'
                  }
                  description="保存时冻结当前关联版本及下方本次复测范围；记录不会自动关闭缺陷。"
                />
                <Form.Item
                  name="scopeDescription"
                  label="本次实际复测范围（可补充具体场景、用例或被测构建）"
                  rules={[{ max: 10000 }]}
                >
                  <Input.TextArea
                    rows={2}
                    maxLength={10000}
                    disabled={command.pending}
                    placeholder="留空表示沿用缺陷关联需求版本，未额外声明用例范围"
                  />
                </Form.Item>
                <Form.Item
                  name="outcome"
                  label="人工复测结论"
                  rules={[{ required: true }]}
                >
                  <Select
                    disabled={command.pending}
                    options={[
                      { value: 'passed', label: '通过' },
                      { value: 'failed', label: '未通过' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="attachmentFileIds" label="可选人工复测附件">
                  <ProjectAttachments
                    projectId={project.id}
                    disabled={command.pending}
                    onBusy={setUploading}
                  />
                </Form.Item>
                {outcome === 'failed' && target.issue.state !== 'closed' && (
                  <Form.Item name="returnToInProgress" valuePropName="checked">
                    <Checkbox disabled={command.pending}>
                      本次未通过，同时明确退回处理中/待认领
                    </Checkbox>
                  </Form.Item>
                )}
              </>
            )}
            {target?.kind === 'close' && (
              <Form.Item name="resolution" label="关闭性质">
                <Select
                  disabled={command.pending}
                  options={[
                    { value: 'fixed', label: '按已确认处理关闭' },
                    { value: 'notDefect', label: '明确为非缺陷并关闭' },
                  ]}
                />
              </Form.Item>
            )}
            <Form.Item name="note" label="说明（可留空）">
              <Input.TextArea
                rows={4}
                maxLength={10000}
                disabled={command.pending}
              />
            </Form.Item>
          </>
        )}
      </Form>
    </CommandDialog>
  );
}
