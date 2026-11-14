import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { idSchema } from '../../../packages/contracts/src/base';
import {
  issueStateSchema,
  issueSeveritySchema,
  problemStateSchema,
} from '../../../packages/contracts/src/domain';
import {
  issueListResponseSchema,
  problemListResponseSchema,
  issueListQuerySchema,
  problemListQuerySchema,
  reportProblemInputSchema,
  problemResponseSchema,
  issueCountsQuerySchema,
} from '../../../packages/contracts/src/issues';
import type { Issue, Problem } from '../../../packages/contracts/src/issues';
import type { Me, Project } from './types';
import { api, describeError } from './api';
import {
  useIssueContext,
  issueStateLabels,
  severityLabels,
  problemStateLabels,
  issueSourceLabels,
  problemExecutionProvenanceLabels,
} from './issue-context';
import type { IssueNavigation } from './issue-context';
import {
  IssueEditor,
  IssueActionEditor,
  RequirementFields,
} from './issue-forms';
import type { EditorTarget, ActionTarget } from './issue-forms';
import {
  IssueLifecycleBatch,
  IssueMergeDialog,
  ProblemConfirmationBatch,
} from './issue-batch';
import type {
  LifecycleTarget,
  MergeTarget,
  ProblemBatchTarget,
} from './issue-batch';
import { IssueDetailPanel } from './issue-detail';
import type { IssueSelection } from './issue-detail';
import { ResultDetailPanel } from './result-detail';
import { EvidenceViewer } from './evidence-viewer';
import { RetestPreparationDialog, RetestHistory } from './retests';
import type { RetestTarget } from './retests';
import { CommandDialog, useBusinessCommand } from './business-command';
import { PageHeading } from './page-heading';
import { AppIcon } from './app-icon';
import { ArchivedRequirementsToggle } from './archived-requirements-toggle';
import { useIssueCounts, useIssueReadScope } from './issues-counts';
import './issues-readability.css';

type Scope = 'participated' | 'mine' | 'all';
type Tab = 'formal' | 'unassigned' | 'problems';
function selectionFromUrl(): IssueSelection | null {
  const q = new URLSearchParams(window.location.hash.split('?')[1]);
  for (const [field, kind] of [
    ['issueId', 'issue'],
    ['problemId', 'problem'],
  ] as const) {
    const value = idSchema.safeParse(q.get(field));
    if (value.success) return { kind, id: value.data };
  }
  return null;
}
function retestCommandFromUrl() {
  const value = idSchema.safeParse(
    new URLSearchParams(window.location.hash.split('?')[1]).get(
      'retestCommandId',
    ),
  );
  return value.success ? value.data : undefined;
}
function ExtraFinding({
  projectId,
  session,
  requirements,
  onClose,
  onSaved,
}: {
  projectId: string;
  session: string | null;
  requirements: IssueNavigation;
  onClose: () => void;
  onSaved: (problem: Problem) => Promise<void>;
}) {
  const [form] = Form.useForm<{
    runId: string;
    requirementId: string;
    requirementVersionId: string | null;
    title: string;
    description: string;
    suggestedSeverity: Issue['severity'];
    resultIds: string[];
    localEvidenceIds: string;
  }>();
  const command = useBusinessCommand(session);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!session) return;
    form.resetFields();
    setDirty(false);
    const run = idSchema.safeParse(
      new URLSearchParams(window.location.hash.split('?')[1]).get('runId'),
    );
    form.setFieldsValue({
      ...(run.success ? { runId: run.data } : {}),
      suggestedSeverity: 'normal',
      resultIds: [],
      localEvidenceIds: '',
    });
  }, [session, form]);
  async function submit() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const result = await command.run((commandId) =>
      api(
        `/projects/${projectId}/problems`,
        {
          method: 'POST',
          body: reportProblemInputSchema.parse({
            commandId,
            ...values,
            requirementVersionId: values.requirementVersionId ?? null,
            resultIds: values.resultIds ?? [],
            localEvidenceIds: (values.localEvidenceIds ?? '')
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
          }),
        },
        problemResponseSchema,
      ),
    );
    if (result) {
      setDirty(false);
      await onSaved(result.problem);
      onClose();
    }
  }
  return (
    <CommandDialog
      open={session !== null}
      title="上报原执行中的其他发现 · 待测试确认"
      command={command}
      dirty={dirty}
      onClose={onClose}
      onSave={() => void submit()}
      saveLabel="保存为待确认问题"
    >
      <Alert
        type="info"
        title="不强迫绑定具体用例，不直接生成正式缺陷"
        showIcon
        description="必须明确原执行与正式需求；结果/原执行证据可选。提交保留合成/真实来源，不替代测试确认。"
        className="section-alert"
      />
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Form.Item name="runId" label="原执行UUID" rules={[{ required: true }]}>
          <Input disabled={command.pending} />
        </Form.Item>
        <RequirementFields
          requirements={requirements}
          disabled={command.pending}
        />
        <Form.Item
          name="title"
          label="发现标题"
          rules={[{ required: true, whitespace: true, max: 200 }]}
        >
          <Input disabled={command.pending} />
        </Form.Item>
        <Form.Item
          name="description"
          label="观察、预期与可用依据"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input.TextArea rows={5} disabled={command.pending} />
        </Form.Item>
        <Form.Item name="suggestedSeverity" label="建议严重程度">
          <Select
            disabled={command.pending}
            options={issueSeveritySchema.options.map((value) => ({
              value,
              label: severityLabels[value],
            }))}
          />
        </Form.Item>
        <Form.Item name="resultIds" label="可选关联原结果UUID">
          <Select
            mode="tags"
            disabled={command.pending}
            tokenSeparators={[',', ' ']}
          />
        </Form.Item>
        <Form.Item
          name="localEvidenceIds"
          label="原执行已登记的本地证据ID（可选，每行一项）"
        >
          <Input.TextArea rows={3} disabled={command.pending} />
        </Form.Item>
      </Form>
    </CommandDialog>
  );
}

export function IssuesPage({
  me,
  project,
}: {
  me: Me;
  project: Project | null;
}) {
  const [includeArchivedRequirements, setIncludeArchivedRequirements] =
    useState(false);
  const context = useIssueContext(
    project?.id ?? null,
    includeArchivedRequirements,
    me.user.id,
  );
  const [scope, setScope] = useState<Scope>(() => {
    const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
      'scope',
    );
    return value === 'mine' || value === 'all' ? value : 'participated';
  });
  const [tab, setTab] = useState<Tab>(() => {
    const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
      'tab',
    );
    return value === 'problems' || value === 'unassigned' ? value : 'formal';
  });
  const requirementScope = JSON.stringify([me.user.id, project?.id ?? null]);
  const [requirementSelection, setRequirementSelection] = useState<{
    scope: string;
    id: string | null;
  }>({ scope: requirementScope, id: null });
  const requirementId =
    requirementSelection.scope === requirementScope
      ? requirementSelection.id
      : null;
  const setRequirementId = (id: string | null) =>
    setRequirementSelection({ scope: requirementScope, id });
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const [state, setState] = useState<Issue['state'] | null>(null);
  const [severity, setSeverity] = useState<Issue['severity'] | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [submitter, setSubmitter] = useState<string | null>(null);
  const [includeMerged, setIncludeMerged] = useState(true);
  const [problemState, setProblemState] = useState<Problem['state'] | null>(
    'pendingConfirmation',
  );
  const listScope = useIssueReadScope(
    JSON.stringify([
      project?.id,
      scope,
      tab,
      requirementId,
      search,
      state,
      severity,
      assignee,
      submitter,
      includeMerged,
      includeArchivedRequirements,
      problemState,
    ]),
    me.user.id,
  );
  const [listRecord, setListRecord] = useState<{
    key: object | null;
    issues: Issue[];
    problems: Problem[];
    loading: boolean;
    issueError: string | undefined;
    problemError: string | undefined;
  }>({
    key: null,
    issues: [],
    problems: [],
    loading: false,
    issueError: undefined,
    problemError: undefined,
  });
  const listCurrent = listRecord.key === listScope.key && listScope.isCurrent();
  const issues = listCurrent ? listRecord.issues : [],
    problems = listCurrent ? listRecord.problems : [],
    loading = !listCurrent || listRecord.loading,
    issueError = listCurrent ? listRecord.issueError : undefined,
    problemError = listCurrent ? listRecord.problemError : undefined;
  const aggregate = useIssueCounts(
    project?.id ?? null,
    issueCountsQuerySchema.parse({
      scope:
        scope === 'mine' ? 'mine' : tab === 'unassigned' ? 'unassigned' : 'all',
      participationOnly: scope === 'participated',
      search,
      ...(state ? { state } : {}),
      ...(severity ? { severity } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
      ...(submitter ? { submittedBy: submitter } : {}),
      includeMerged,
      includeArchivedRequirements,
      unassignedOnly: tab === 'unassigned',
      ...(problemState ? { problemState } : {}),
    }),
    me.user.id,
    !composing,
  );
  const [selectedIssues, setSelectedIssues] = useState<string[]>([]);
  const [selectedProblems, setSelectedProblems] = useState<string[]>([]);
  const [selection, setSelection] = useState<IssueSelection | null>(
    selectionFromUrl,
  );
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [action, setAction] = useState<ActionTarget | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [merge, setMerge] = useState<MergeTarget | null>(null);
  const [problemBatch, setProblemBatch] = useState<ProblemBatchTarget | null>(
    null,
  );
  const [retest, setRetest] = useState<RetestTarget | null>(null);
  const [historyOpen, setHistoryOpen] = useState(
    Boolean(retestCommandFromUrl()),
  );
  const [extraFinding, setExtraFinding] = useState<string | null>(null);
  const [resultSelection, setResultSelection] = useState<{
    id: string;
    revisionId: string;
  } | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const epoch = useRef(0);
  const refreshDetail = useRef<() => Promise<void>>(async () => {});
  const registerRefresh = useCallback((refresh: () => Promise<void>) => {
    refreshDetail.current = refresh;
  }, []);
  const tester = project?.roles.includes('tester') ?? false;
  const canCreate = tester || Boolean(project?.roles.includes('product'));
  async function load(signal?: AbortSignal) {
    if (!project || !listScope.isCurrent()) return;
    const current = ++epoch.current;
    const live = () =>
      !signal?.aborted && current === epoch.current && listScope.isCurrent();
    setListRecord((previous) =>
      live()
        ? {
            key: listScope.key,
            issues: previous.key === listScope.key ? previous.issues : [],
            problems: previous.key === listScope.key ? previous.problems : [],
            loading: true,
            issueError: undefined,
            problemError: undefined,
          }
        : previous,
    );
    setSelectedIssues([]);
    setSelectedProblems([]);
    const issueQuery = issueListQuerySchema.parse({
      scope:
        scope === 'mine' ? 'mine' : tab === 'unassigned' ? 'unassigned' : 'all',
      participationOnly: scope === 'participated',
      search,
      ...(requirementId ? { requirementId } : {}),
      ...(state ? { state } : {}),
      ...(severity ? { severity } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
      ...(submitter ? { submittedBy: submitter } : {}),
      includeMerged,
      includeArchivedRequirements,
    });
    const problemQuery = problemListQuerySchema.parse({
      participationOnly: scope === 'participated',
      search,
      includeArchivedRequirements,
      ...(requirementId ? { requirementId } : {}),
      ...(problemState ? { state: problemState } : {}),
    });
    const results = await Promise.allSettled([
      api(
        `/projects/${project.id}/issues?${new URLSearchParams(Object.entries(issueQuery).map(([key, value]) => [key, String(value)]))}`,
        signal ? { signal } : {},
        issueListResponseSchema,
      ),
      scope === 'mine'
        ? Promise.resolve({ problems: [] })
        : api(
            `/projects/${project.id}/problems?${new URLSearchParams(Object.entries(problemQuery).map(([key, value]) => [key, String(value)]))}`,
            signal ? { signal } : {},
            problemListResponseSchema,
          ),
    ]);
    if (!live()) return;
    const [formal, pending] = results;
    setListRecord((previous) =>
      live()
        ? {
            key: listScope.key,
            issues:
              formal.status === 'fulfilled'
                ? scope === 'mine' && tab === 'unassigned'
                  ? []
                  : formal.value.issues
                : [],
            problems:
              pending.status === 'fulfilled' ? pending.value.problems : [],
            issueError:
              formal.status === 'rejected'
                ? describeError(formal.reason)
                : undefined,
            problemError:
              pending.status === 'rejected'
                ? describeError(pending.reason)
                : undefined,
            loading: false,
          }
        : previous,
    );
  }
  useEffect(() => {
    if (composing) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    project?.id,
    scope,
    tab,
    requirementId,
    search,
    state,
    severity,
    assignee,
    submitter,
    includeMerged,
    includeArchivedRequirements,
    problemState,
    composing,
    listScope.key,
  ]);
  useEffect(() => {
    function follow() {
      setSelection(selectionFromUrl());
      if (retestCommandFromUrl()) setHistoryOpen(true);
    }
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  async function refresh() {
    if (!listScope.isCurrent()) return;
    aggregate.refresh();
    await Promise.allSettled([load(), refreshDetail.current()]);
  }
  function openSelection(selected: IssueSelection) {
    setSelection(selected);
    if (project)
      window.location.hash = `issues?projectId=${project.id}&${selected.kind === 'issue' ? 'issueId' : 'problemId'}=${selected.id}`;
  }
  function closeSelection() {
    setSelection(null);
    if (project) window.location.hash = `issues?projectId=${project.id}`;
  }
  const chosenIssues = issues.filter((issue) =>
    selectedIssues.includes(issue.id),
  );
  const chosenProblems = problems.filter((problem) =>
    selectedProblems.includes(problem.id),
  );
  const name = (id: string | null) =>
    id
      ? (context.members.find((member) => member.id === id)?.displayName ?? id)
      : '待认领';
  const memberOptions = context.members.map((member) => ({
    value: member.id,
    label: `${member.displayName}（${member.account}）`,
  }));
  const actorOptions = [
    ...memberOptions,
    ...[
      ...new Set(
        issues
          .flatMap((issue) => [issue.assigneeId, issue.submittedBy])
          .filter((id): id is string => Boolean(id)),
      ),
    ]
      .filter((id) => !memberOptions.some((member) => member.value === id))
      .map((id) => ({ value: id, label: `历史账号 ${id}` })),
  ];
  const counts = new Map(
    aggregate.data?.requirements.map((row) => [row.requirementId, row]) ?? [],
  );
  const selectedCounts = requirementId
    ? counts.get(requirementId)
    : aggregate.data?.totals;
  const displayCount = (value: string | undefined) =>
    aggregate.status === 'loading'
      ? '…'
      : aggregate.status === 'error'
        ? '—'
        : (value ?? '—');
  if (!project)
    return <Empty description="请先选择当前有效项目后查看问题/缺陷。" />;
  return (
    <div className="issues-page">
      <PageHeading
        eyebrow="ISSUE WORKSPACE"
        title="缺陷管理"
        description="按需求聚焦责任和处理状态，原始事实与最终结论分别保留。"
        actions={
          <Button
            type="primary"
            icon={<AppIcon name="plus" />}
            disabled={!canCreate}
            onClick={() =>
              setEditor({ session: crypto.randomUUID(), kind: 'new' })
            }
          >
            新建缺陷
          </Button>
        }
      />
      <div className="between mb wrap">
        <div className="segmented">
          {(
            [
              ['participated', '参与需求'],
              ['mine', '我负责的'],
              ['all', '全部缺陷'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              className={`tab ${scope === value ? 'active' : ''}`}
              key={value}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <ArchivedRequirementsToggle
            checked={includeArchivedRequirements}
            onChange={(value) => {
              epoch.current += 1;
              setRequirementId(null);
              setSelectedIssues([]);
              setSelectedProblems([]);
              setIncludeArchivedRequirements(value);
            }}
          />
          <Dropdown
            menu={{
              items: [
                { key: 'refresh', label: '刷新列表' },
                {
                  key: 'finding',
                  label: '上报其他待确认发现',
                  disabled: !tester,
                },
                { key: 'retests', label: '固定复测范围与原回执' },
              ],
              onClick: ({ key }) => {
                if (key === 'refresh') {
                  aggregate.refresh();
                  void load();
                } else if (key === 'finding')
                  setExtraFinding(crypto.randomUUID());
                else setHistoryOpen(true);
              },
            }}
            trigger={['click']}
          >
            <Button
              type="text"
              aria-label="问题与复测更多操作"
              icon={<AppIcon name="more" />}
            />
          </Dropdown>
        </div>
      </div>
      {context.error && (
        <Alert
          type="warning"
          title={`需求/有效成员目录未完整取得：${context.error}`}
          showIcon
        />
      )}
      <div className="issue-layout live-issue-layout">
        <aside className="asset-tree">
          <div className="tree-head">需求范围 · {project.name}</div>
          <button
            type="button"
            className={`tree-node ${!requirementId ? 'active' : ''}`}
            onClick={() => setRequirementId(null)}
          >
            <AppIcon name="folder-closed" />
            <span className="grow">全部需求</span>
            <span className="count">
              {displayCount(aggregate.data?.totals.formal)}
            </span>
          </button>
          {context.requirements.map((requirement) => (
            <button
              type="button"
              key={requirement.id}
              className={`tree-node ${requirementId === requirement.id ? 'active' : ''}`}
              onClick={() => setRequirementId(requirement.id)}
            >
              <span className="grow">
                {requirement.title}
                {requirement.archived ? '（已归档）' : ''}
                <br />
                <span className="caption">{requirement.id}</span>
              </span>
              <span className="count">
                {displayCount(counts.get(requirement.id)?.formal)}
              </span>
            </button>
          ))}
          <div className="divider" />
          <p className="caption" style={{ padding: '0 10px' }}>
            导航数字为当前职责和筛选的完整正式缺陷条目数，不受当前列表200条限制；待确认问题独立统计。参与需求是关注筛选，不是权限墙。
          </p>
        </aside>
        <section className="issue-pane">
          <div className="card">
            <div className="issue-summary">
              <h2>
                {requirementId
                  ? (context.requirements.find(
                      (requirement) => requirement.id === requirementId,
                    )?.title ?? requirementId)
                  : '全部需求'}
              </h2>
              <p className="caption">
                {scope === 'participated'
                  ? '本人参与的需求'
                  : scope === 'mine'
                    ? '当前负责人为本人'
                    : '当前项目全部需求'}{' '}
                · 当前筛选完整统计；列表最多加载200条
              </p>
              <div className="stats three">
                {[
                  ['正式缺陷', displayCount(selectedCounts?.formal)],
                  ['待认领', displayCount(selectedCounts?.unassigned)],
                  [
                    scope === 'mine' ? '项目待测试确认' : '待测试确认',
                    displayCount(selectedCounts?.pendingTestConfirmation),
                  ],
                ].map(([label, count]) => (
                  <div className="mini-stat" key={label}>
                    <strong>{count}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              {scope === 'mine' && (
                <p className="caption">
                  待确认问题没有负责人；该数字按项目、所选需求、搜索和归档及问题决定筛选独立统计，不计入本人负责的正式缺陷。
                </p>
              )}
              {aggregate.status === 'error' && (
                <Alert
                  type="error"
                  showIcon
                  title={`完整统计未取得：${aggregate.error ?? '读取失败'}`}
                  action={
                    <Button size="small" onClick={aggregate.refresh}>
                      重读统计
                    </Button>
                  }
                />
              )}
            </div>
            <Space
              direction="vertical"
              className="issue-records"
              style={{ width: '100%' }}
            >
              <Tabs
                activeKey={tab}
                onChange={(value) => {
                  if (
                    value === 'formal' ||
                    value === 'unassigned' ||
                    value === 'problems'
                  )
                    setTab(value);
                }}
                items={[
                  { key: 'formal', label: '正式缺陷' },
                  { key: 'unassigned', label: '待认领池' },
                  { key: 'problems', label: 'AI/接口待确认问题' },
                ]}
              />
              <div className="issue-query-row row">
                <label className="issue-search-field">
                  <span>搜索问题或缺陷</span>
                  <Input
                    aria-label="搜索问题或缺陷"
                    value={search}
                    maxLength={200}
                    placeholder="输入编号、标题或描述"
                    onChange={(event) => setSearch(event.target.value)}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                  />
                </label>
                <Button
                  onClick={() => {
                    setSearch('');
                    setState(null);
                    setSeverity(null);
                    setAssignee(null);
                    setSubmitter(null);
                    setRequirementId(null);
                    setIncludeMerged(true);
                    setProblemState('pendingConfirmation');
                  }}
                >
                  清空条件
                </Button>
              </div>
              <Space wrap className="issue-filter-controls">
                <Select
                  aria-label="正式状态筛选"
                  style={{ minWidth: 140 }}
                  value={state}
                  allowClear
                  disabled={tab === 'problems'}
                  placeholder="全部正式状态"
                  options={issueStateSchema.options.map((value) => ({
                    value,
                    label: issueStateLabels[value],
                  }))}
                  onChange={(value: Issue['state'] | undefined) =>
                    setState(value ?? null)
                  }
                />
                <Select
                  aria-label="负责人筛选"
                  style={{ minWidth: 180 }}
                  value={assignee}
                  allowClear
                  disabled={tab === 'problems'}
                  showSearch
                  optionFilterProp="label"
                  placeholder="全部负责人"
                  options={actorOptions}
                  onChange={(value: string | undefined) =>
                    setAssignee(value ?? null)
                  }
                />
                <Select
                  aria-label="严重程度筛选"
                  style={{ minWidth: 120 }}
                  value={severity}
                  allowClear
                  disabled={tab === 'problems'}
                  placeholder="全部严重程度"
                  options={issueSeveritySchema.options.map((value) => ({
                    value,
                    label: severityLabels[value],
                  }))}
                  onChange={(value: Issue['severity'] | undefined) =>
                    setSeverity(value ?? null)
                  }
                />
                <Select
                  aria-label="提交人筛选"
                  style={{ minWidth: 180 }}
                  value={submitter}
                  allowClear
                  disabled={tab === 'problems'}
                  showSearch
                  optionFilterProp="label"
                  placeholder="全部提交人"
                  options={actorOptions}
                  onChange={(value: string | undefined) =>
                    setSubmitter(value ?? null)
                  }
                />
              </Space>
              {tab === 'problems' ? (
                <>
                  <Select
                    aria-label="问题决定筛选"
                    value={problemState}
                    allowClear
                    style={{ width: 260 }}
                    options={problemStateSchema.options.map((value) => ({
                      value,
                      label: problemStateLabels[value],
                    }))}
                    onChange={(value: Problem['state'] | undefined) =>
                      setProblemState(value ?? null)
                    }
                  />
                  {scope === 'mine' && (
                    <Alert
                      type="info"
                      title="待确认问题没有正式负责人；切到参与需求或全部范围查看问题。"
                      showIcon
                    />
                  )}
                  {problemError && (
                    <Alert type="error" title={problemError} showIcon />
                  )}
                  <Space wrap>
                    <Typography.Text>
                      当前已加载问题记录 {problems.length}{' '}
                      条，独立于正式缺陷数。
                    </Typography.Text>
                    <Button
                      disabled={!tester || !chosenProblems.length}
                      onClick={() =>
                        setProblemBatch({
                          session: crypto.randomUUID(),
                          problems: chosenProblems,
                        })
                      }
                    >
                      批量精确确认所选 {chosenProblems.length} 项
                    </Button>
                  </Space>
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={problems}
                    pagination={{ pageSize: 15 }}
                    scroll={{ x: 740 }}
                    rowSelection={{
                      selectedRowKeys: selectedProblems,
                      onChange: (keys) => setSelectedProblems(keys.map(String)),
                      getCheckboxProps: (row) => ({
                        disabled: row.state === 'confirmed',
                      }),
                    }}
                    locale={{
                      emptyText: problemError
                        ? '问题列表尚未取得。'
                        : '当前职责/条件无可读问题记录。',
                    }}
                    columns={[
                      {
                        title: '问题',
                        render: (_, row) => (
                          <Button
                            type="link"
                            onClick={() =>
                              openSelection({ kind: 'problem', id: row.id })
                            }
                          >
                            {row.title}
                          </Button>
                        ),
                      },
                      {
                        title: '决定',
                        render: (_, row) => problemStateLabels[row.state],
                      },
                      {
                        title: '建议严重程度',
                        render: (_, row) =>
                          severityLabels[row.suggestedSeverity],
                      },
                      {
                        title: '真实来源',
                        render: (_, row) => (
                          <Space direction="vertical">
                            <Tag>{issueSourceLabels[row.source]}</Tag>
                            <Typography.Text
                              type={
                                row.sourceExecutionProvenance ===
                                'protocol-synthetic'
                                  ? 'warning'
                                  : 'secondary'
                              }
                            >
                              {
                                problemExecutionProvenanceLabels[
                                  row.sourceExecutionProvenance
                                ]
                              }
                            </Typography.Text>
                          </Space>
                        ),
                      },
                      { title: '原决定说明', dataIndex: 'decisionNote' },
                    ]}
                  />
                </>
              ) : (
                <>
                  {issueError && (
                    <Alert type="error" title={issueError} showIcon />
                  )}
                  {scope === 'mine' && tab === 'unassigned' && (
                    <Alert
                      type="info"
                      title="待认领条目没有当前负责人，因此不属于我负责的范围。"
                      showIcon
                    />
                  )}
                  <Space wrap>
                    <Checkbox
                      checked={includeMerged}
                      onChange={(event) =>
                        setIncludeMerged(event.target.checked)
                      }
                    >
                      包含合并关系中的保留原记录
                    </Checkbox>
                    <Typography.Text>
                      已明确选择 {chosenIssues.length} 条当前正式记录。
                    </Typography.Text>
                    {!!chosenIssues.length && (
                      <>
                        <Button
                          disabled={!tester || !chosenIssues.length}
                          onClick={() =>
                            setLifecycle({
                              session: crypto.randomUUID(),
                              action: 'close',
                              issues: chosenIssues,
                            })
                          }
                        >
                          批量关闭精确预览
                        </Button>
                        <Button
                          disabled={!tester || !chosenIssues.length}
                          onClick={() =>
                            setLifecycle({
                              session: crypto.randomUUID(),
                              action: 'reopen',
                              issues: chosenIssues,
                            })
                          }
                        >
                          批量重开精确预览
                        </Button>
                        <Button
                          disabled={!tester || !chosenIssues.length}
                          onClick={() =>
                            setRetest({
                              session: crypto.randomUUID(),
                              issues: chosenIssues,
                            })
                          }
                        >
                          直接准备所选复测
                        </Button>
                        <Button
                          disabled={
                            !tester ||
                            chosenIssues.length < 2 ||
                            chosenIssues.some((issue) => issue.mergedIntoId)
                          }
                          onClick={() =>
                            setMerge({
                              session: crypto.randomUUID(),
                              kind: 'merge',
                              issues: chosenIssues,
                            })
                          }
                        >
                          人工合并主从范围
                        </Button>
                      </>
                    )}
                  </Space>
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={issues}
                    pagination={{ pageSize: 15 }}
                    scroll={{ x: 760 }}
                    rowSelection={{
                      selectedRowKeys: selectedIssues,
                      onChange: (keys) => setSelectedIssues(keys.map(String)),
                    }}
                    locale={{
                      emptyText: issueError
                        ? '正式缺陷列表尚未取得。'
                        : '当前职责/条件没有正式缺陷记录。',
                    }}
                    columns={[
                      {
                        title: '缺陷 / 需求',
                        width: 230,
                        render: (_, row) => (
                          <div className="table-title">
                            <Button
                              type="link"
                              className="text-link-button"
                              onClick={() =>
                                openSelection({ kind: 'issue', id: row.id })
                              }
                            >
                              {row.title}
                            </Button>
                            <div className="sub">
                              {row.number} ·{' '}
                              {context.requirements.find(
                                (requirement) =>
                                  requirement.id === row.requirementId,
                              )?.title ?? row.requirementId}
                            </div>
                            <span className="badge">
                              {severityLabels[row.severity]}
                            </span>
                            {row.mergedIntoId && (
                              <span className="badge">保留合并从项</span>
                            )}
                          </div>
                        ),
                      },
                      {
                        title: '状态',
                        width: 110,
                        render: (_, row) => (
                          <span
                            className={`badge ${row.state === 'pending' ? 'amber' : row.state === 'inProgress' || row.state === 'awaitingRetest' ? 'blue' : ''}`}
                          >
                            {issueStateLabels[row.state]}
                          </span>
                        ),
                      },
                      {
                        title: '负责人 / 最近来源',
                        width: 240,
                        render: (_, row) => (
                          <div>
                            <span>负责人：{name(row.assigneeId)}</span>
                            {row.assigneeId && !row.assigneeActive && (
                              <span className="badge amber">权限失效</span>
                            )}
                            <details className="issue-handling-summary">
                              <summary>来源及最近处理</summary>
                              <div className="sub">
                                发现来源：{issueSourceLabels[row.source]}
                              </div>
                              <div className="sub">
                                {row.latestHandling
                                  ? `最近处理人：${name(row.latestHandling.actorId)} · ${new Date(row.latestHandling.createdAt).toLocaleString('zh-CN')}`
                                  : '尚无责任变更'}
                              </div>
                            </details>
                          </div>
                        ),
                      },
                      {
                        title: '操作',
                        width: 144,
                        fixed: 'right',
                        render: (_, row) => (
                          <Space>
                            <Button
                              size="small"
                              onClick={() =>
                                openSelection({ kind: 'issue', id: row.id })
                              }
                            >
                              查看
                            </Button>
                            {project.roles.includes('developer') &&
                              !row.assigneeId &&
                              row.state !== 'closed' && (
                                <Button
                                  size="small"
                                  type="primary"
                                  onClick={() =>
                                    setAction({
                                      session: crypto.randomUUID(),
                                      kind: 'handling',
                                      action: 'claim',
                                      issue: row,
                                    })
                                  }
                                >
                                  认领
                                </Button>
                              )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </>
              )}
            </Space>
          </div>
        </section>
      </div>
      <IssueDetailPanel
        project={project}
        userId={me.user.id}
        selection={selection}
        requirements={context.requirements}
        members={context.members}
        onClose={closeSelection}
        onSelect={openSelection}
        onEdit={setEditor}
        onAction={setAction}
        onUnmerge={setMerge}
        onRetest={(issues) =>
          setRetest({ session: crypto.randomUUID(), issues })
        }
        onResult={(id, revisionId) => setResultSelection({ id, revisionId })}
        onEvidence={setFileId}
        onRegisterRefresh={registerRefresh}
      />
      <IssueEditor
        project={project}
        target={editor}
        requirements={context.requirements}
        members={context.members}
        onClose={() => setEditor(null)}
        onSaved={async (issue) => {
          await refresh();
          openSelection({ kind: 'issue', id: issue.id });
        }}
      />
      <IssueActionEditor
        project={project}
        target={action}
        members={context.members}
        onClose={() => setAction(null)}
        onSaved={refresh}
      />
      <IssueLifecycleBatch
        projectId={project.id}
        target={lifecycle}
        onClose={() => setLifecycle(null)}
        onSaved={refresh}
      />
      <IssueMergeDialog
        projectId={project.id}
        target={merge}
        onClose={() => setMerge(null)}
        onSaved={refresh}
      />
      <ProblemConfirmationBatch
        projectId={project.id}
        target={problemBatch}
        requirements={context.requirements}
        members={context.members}
        onClose={() => setProblemBatch(null)}
        onSaved={refresh}
      />
      <RetestPreparationDialog
        project={project}
        target={retest}
        requirements={context.requirements}
        onClose={() => setRetest(null)}
        onPrepared={refresh}
      />
      <RetestHistory
        project={project}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        {...(retestCommandFromUrl()
          ? { initialCommandId: retestCommandFromUrl()! }
          : {})}
      />
      <ExtraFinding
        projectId={project.id}
        session={extraFinding}
        requirements={context.requirements}
        onClose={() => setExtraFinding(null)}
        onSaved={async (problem) => {
          await refresh();
          openSelection({ kind: 'problem', id: problem.id });
        }}
      />
      <ResultDetailPanel
        project={project}
        resultId={resultSelection?.id ?? null}
        {...(resultSelection
          ? { reportBasisRevisionId: resultSelection.revisionId }
          : {})}
        onClose={() => setResultSelection(null)}
        onChanged={refresh}
      />
      <EvidenceViewer fileId={fileId} onClose={() => setFileId(null)} />
    </div>
  );
}
