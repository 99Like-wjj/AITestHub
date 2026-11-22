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
import type { EvidenceType } from './evidence-gallery';
import { RetestPreparationDialog, RetestHistory } from './retests';
import type { RetestTarget } from './retests';
import { CommandDialog, useBusinessCommand } from './business-command';
import { PageHeading } from './page-heading';
import { AppIcon } from './app-icon';
import {
  IssueStateTag,
  IssueSeverityTag,
  ProblemStateTag,
} from './semantic-status';
import { BeijingTime } from './beijing-time';
import {
  RequirementDirectory,
  RequirementDirectoryLabel,
} from './requirement-directory';
import { useIssueCounts, useIssueReadScope } from './issues-counts';
import { BulkActionBar } from './bulk-action-bar';
import { ResultFilters, ResultListState } from './result-list';
import './issues-readability.css';

type Scope = 'participated' | 'mine' | 'all';
type Tab = 'formal' | 'unassigned' | 'problems' | 'retest' | 'triage';
const problemTab = (tab: Tab) => tab === 'problems' || tab === 'triage';
const issueUrlQuery = () =>
  new URLSearchParams(window.location.hash.split('?')[1]);
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
    return value === 'mine' || value === 'participated' ? value : 'all';
  });
  const [tab, setTab] = useState<Tab>(() => {
    const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
      'tab',
    );
    return value === 'problems' ||
      value === 'unassigned' ||
      value === 'retest' ||
      value === 'triage'
      ? value
      : 'formal';
  });
  const requirementScope = JSON.stringify([me.user.id, project?.id ?? null]);
  const [requirementSelection, setRequirementSelection] = useState<{
    scope: string;
    id: string | null;
  }>(() => ({
    scope: requirementScope,
    id: idSchema.safeParse(issueUrlQuery().get('requirementId')).data ?? null,
  }));
  const [requirementVersion, setRequirementVersion] = useState(
    () => issueUrlQuery().get('requirementVersion') ?? '',
  );
  const [requirementSearch, setRequirementSearch] = useState('');
  const requirementId =
    requirementSelection.scope === requirementScope
      ? requirementSelection.id
      : null;
  const setRequirementId = (id: string | null) => {
    setRequirementSelection({ scope: requirementScope, id });
    setRequirementVersion('');
  };
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
      requirementVersion,
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
      ...(tab === 'retest'
        ? { state: 'awaitingRetest' }
        : state
          ? { state }
          : {}),
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
  const [evidenceSelection, setEvidenceSelection] = useState<{
    fileId: string;
    evidenceType?: EvidenceType;
  } | null>(null);
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
      ...(requirementId && requirementVersion ? { requirementVersion } : {}),
      ...(tab === 'retest'
        ? { state: 'awaitingRetest' }
        : state
          ? { state }
          : {}),
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
      ...(requirementId && requirementVersion ? { requirementVersion } : {}),
      ...(tab === 'triage'
        ? {
            decidedOnly: true,
            ...(problemState && problemState !== 'pendingConfirmation'
              ? { state: problemState }
              : {}),
          }
        : { state: 'pendingConfirmation' }),
    });
    const results = await Promise.allSettled([
      api(
        `/projects/${project.id}/issues?${new URLSearchParams(Object.entries(issueQuery).map(([key, value]) => [key, String(value)]))}`,
        signal ? { signal } : {},
        issueListResponseSchema,
      ),
      scope === 'mine' && !problemTab(tab)
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
    requirementVersion,
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

  function clearResultFilters() {
    setSearch('');
    setState(null);
    setSeverity(null);
    setAssignee(null);
    setSubmitter(null);
    setIncludeMerged(true);
    setProblemState('pendingConfirmation');
  }
  function emptyFeedback(
    record: '问题' | '正式缺陷',
    failure: string | undefined,
  ) {
    if (loading)
      return (
        <ResultListState state="loading" title={`正在读取${record}列表`} />
      );
    if (failure)
      return (
        <ResultListState
          state="error"
          title={`${record}列表读取失败`}
          description={failure}
          action={<Button onClick={() => void refresh()}>重新读取</Button>}
        />
      );
    const filtered =
      search.trim() ||
      (problemTab(tab)
        ? tab === 'triage' &&
          problemState &&
          problemState !== 'pendingConfirmation'
        : state || severity || assignee || submitter || !includeMerged);
    return filtered ? (
      <ResultListState
        state="no-match"
        title={`没有符合条件的${record}`}
        description="可调整条件，或清空结果筛选。"
        action={<Button onClick={clearResultFilters}>清空结果筛选</Button>}
      />
    ) : (
      <ResultListState state="empty" title={`当前范围暂无${record}`} />
    );
  }
  function updateUrl(selected: IssueSelection | null) {
    if (!project) return;
    const query = new URLSearchParams({ projectId: project.id, scope, tab });
    if (requirementId) query.set('requirementId', requirementId);
    if (requirementId && requirementVersion)
      query.set('requirementVersion', requirementVersion);
    if (selected)
      query.set(
        selected.kind === 'issue' ? 'issueId' : 'problemId',
        selected.id,
      );
    window.location.hash = 'issues?' + query.toString();
  }
  function openSelection(selected: IssueSelection) {
    setSelection(selected);
    updateUrl(selected);
  }
  function closeSelection() {
    setSelection(null);
    updateUrl(null);
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
  const requirementOf = (id: string) =>
    context.requirements.find((r) => r.id === id);
  const versionLabel = (row: {
    requirementId: string;
    requirementVersionId: string | null;
  }) => {
    if (!row.requirementVersionId) return '未指定版本';
    const version = requirementOf(row.requirementId)?.versions.find(
      (v) => v.id === row.requirementVersionId,
    );
    return version ? 'v' + version.versionNo : row.requirementVersionId;
  };
  const grouped = (rows: { requirementId: string }[]) => {
    const groups = new Map<string, { first: object; count: number }>();
    for (const row of rows) {
      const group = groups.get(row.requirementId);
      if (group) group.count++;
      else groups.set(row.requirementId, { first: row, count: 1 });
    }
    return groups;
  };
  const sortByRequirement = <T extends { requirementId: string }>(rows: T[]) =>
    !requirementId
      ? [...rows].sort(
          (left, right) =>
            (
              requirementOf(left.requirementId)?.title ?? left.requirementId
            ).localeCompare(
              requirementOf(right.requirementId)?.title ?? right.requirementId,
              'zh-CN',
            ) || left.requirementId.localeCompare(right.requirementId),
        )
      : rows;
  const groupedIssues = sortByRequirement(issues);
  const groupedProblems = sortByRequirement(problems);
  const issueGroups = grouped(groupedIssues),
    problemGroups = grouped(groupedProblems);
  const groupHeading = (
    groups: ReturnType<typeof grouped>,
    row: { requirementId: string },
  ) => {
    const group = groups.get(row.requirementId);
    return !requirementId && group?.first === row ? (
      <div className="issue-requirement-group">
        {requirementOf(row.requirementId)?.title ?? row.requirementId}{' '}
        <span>{group.count} 条当前记录</span>
      </div>
    ) : null;
  };
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
          <>
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
                aria-label="问题与复测更多操作"
                icon={<AppIcon name="more" />}
              />
            </Dropdown>
            <Button
              type="primary"
              icon={<AppIcon name="plus" />}
              disabled={!canCreate}
              onClick={() =>
                setEditor({
                  session: crypto.randomUUID(),
                  kind: 'new',
                  ...(requirementId
                    ? {
                        requirementId,
                        requirementVersionId:
                          idSchema.safeParse(requirementVersion).data ?? null,
                      }
                    : {}),
                })
              }
            >
              新建缺陷
            </Button>
          </>
        }
      />
      {context.error && (
        <Alert
          type="warning"
          title={`需求/有效成员目录未完整取得：${context.error}`}
          showIcon
        />
      )}
      <div className="issue-layout live-issue-layout requirement-directory-layout">
        <RequirementDirectory
          includeArchived={includeArchivedRequirements}
          onIncludeArchivedChange={(value) => {
            epoch.current += 1;
            if (
              !value &&
              requirementId &&
              requirementOf(requirementId)?.archived
            ) {
              setRequirementId(null);
            }
            setSelectedIssues([]);
            setSelectedProblems([]);
            setIncludeArchivedRequirements(value);
          }}
          search={requirementSearch}
          onSearchChange={setRequirementSearch}
          searchPlaceholder="搜索需求名称或 ID"
        >
          <button
            type="button"
            className={`tree-node requirement-directory-button ${!requirementId ? 'active' : ''}`}
            aria-pressed={!requirementId}
            onClick={() => setRequirementId(null)}
          >
            <RequirementDirectoryLabel
              title="全部需求"
              count={`${displayCount(aggregate.data?.totals.formal)} 项缺陷`}
            />
          </button>
          {context.requirements
            .filter((r) =>
              [r.id, r.title].some((text) =>
                text
                  .toLowerCase()
                  .includes(requirementSearch.trim().toLowerCase()),
              ),
            )
            .map((requirement) => (
              <button
                type="button"
                key={requirement.id}
                className={`tree-node requirement-directory-button ${requirementId === requirement.id ? 'active' : ''}`}
                aria-pressed={requirementId === requirement.id}
                onClick={() => setRequirementId(requirement.id)}
              >
                <RequirementDirectoryLabel
                  title={requirement.title}
                  archived={requirement.archived}
                  count={`${displayCount(counts.get(requirement.id)?.formal)} 项缺陷`}
                />
              </button>
            ))}
          <div className="divider" />
          <p className="caption" style={{ padding: '0 10px' }}>
            导航数字按当前筛选汇总各需求的全部版本。
          </p>
        </RequirementDirectory>
        <section className="issue-pane">
          <div className="card">
            <div className="issue-summary">
              <div className="issue-directory-results-header">
                <div>
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
                    · 需求目录汇总各版本，列表按选定版本展示
                  </p>
                </div>
                <div className="row wrap issue-directory-results-controls">
                  <div className="segmented" aria-label="责任范围">
                    {(
                      [
                        ['participated', '参与需求'],
                        ['mine', '我负责的'],
                        ['all', '项目全部'],
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
                  {requirementId && (
                    <Select
                      aria-label="需求版本"
                      placeholder="全部版本"
                      allowClear
                      value={requirementVersion || undefined}
                      options={[
                        ...(requirementOf(requirementId)?.versions ?? []).map(
                          (v) => ({ value: v.id, label: 'v' + v.versionNo }),
                        ),
                        { value: 'unspecified', label: '未指定版本' },
                      ]}
                      onChange={(value: string | undefined) =>
                        setRequirementVersion(value ?? '')
                      }
                      style={{ minWidth: 160 }}
                    />
                  )}
                </div>
              </div>
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
                    value === 'retest' ||
                    value === 'triage' ||
                    value === 'problems'
                  ) {
                    setTab(value);
                    if (problemTab(value) && scope === 'mine') setScope('all');
                    setState(null);
                    setProblemState(
                      value === 'triage' ? null : 'pendingConfirmation',
                    );
                  }
                }}
                items={[
                  { key: 'problems', label: '待确认问题' },
                  { key: 'unassigned', label: '待认领' },
                  { key: 'retest', label: '待复测' },
                  { key: 'formal', label: '全部缺陷' },
                  { key: 'triage', label: '分诊记录' },
                ]}
              />

              <ResultFilters
                search={{
                  label: '搜索问题或缺陷',
                  placeholder: '输入编号、标题或描述',
                  value: search,
                  onChange: setSearch,
                  onCompositionChange: setComposing,
                }}
                onReset={clearResultFilters}
                summary={
                  loading
                    ? '正在读取'
                    : `已读入 ${problemTab(tab) ? problems.length : issues.length} 条`
                }
              >
                <Select
                  aria-label="正式状态筛选"
                  value={state}
                  allowClear
                  disabled={problemTab(tab) || tab === 'retest'}
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
                  value={assignee}
                  allowClear
                  disabled={problemTab(tab)}
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
                  value={severity}
                  allowClear
                  disabled={problemTab(tab)}
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
                  value={submitter}
                  allowClear
                  disabled={problemTab(tab)}
                  showSearch
                  optionFilterProp="label"
                  placeholder="全部提交人"
                  options={actorOptions}
                  onChange={(value: string | undefined) =>
                    setSubmitter(value ?? null)
                  }
                />
                {tab === 'triage' && (
                  <Select
                    aria-label="问题决定筛选"
                    value={problemState}
                    allowClear
                    style={{ width: 260 }}
                    options={problemStateSchema.options
                      .filter((value) => value !== 'pendingConfirmation')
                      .map((value) => ({
                        value,
                        label: problemStateLabels[value],
                      }))}
                    onChange={(value: Problem['state'] | undefined) =>
                      setProblemState(value ?? null)
                    }
                  />
                )}
              </ResultFilters>
              {problemTab(tab) ? (
                <>
                  {scope === 'mine' && (
                    <Alert
                      type="info"
                      title="待确认问题没有正式负责人；切到参与需求或全部范围查看问题。"
                      showIcon
                    />
                  )}

                  <BulkActionBar
                    selected={chosenProblems.length}
                    onClear={() => setSelectedProblems([])}
                    scope="只处理本次明确选择的问题"
                  >
                    <Button
                      disabled={!tester || !chosenProblems.length}
                      onClick={() =>
                        setProblemBatch({
                          session: crypto.randomUUID(),
                          problems: chosenProblems,
                        })
                      }
                    >
                      批量确认精确预览
                    </Button>
                  </BulkActionBar>
                  <Table
                    rowKey="id"

                    loading={loading && problems.length > 0}
                    dataSource={groupedProblems}
                    pagination={{
                      className: 'result-table-pagination',
                      pageSize: 15,
                      size: 'small',
                      showTotal: (total, range) =>
                        `第 ${range[0]}–${range[1]} 条 · 共 ${total} 条`,
                    }}
                    scroll={{ x: 740 }}
                    rowSelection={{
                      selectedRowKeys: selectedProblems,
                      onChange: (keys) => setSelectedProblems(keys.map(String)),
                      getCheckboxProps: (row) => ({
                        disabled: row.state === 'confirmed',
                      }),
                    }}
                    locale={{ emptyText: emptyFeedback('问题', problemError) }}
                    columns={[
                      {
                        title: '问题',
                        render: (_, row) => (
                          <div>
                            {groupHeading(problemGroups, row)}
                            <Button
                              type="link"
                              onClick={() =>
                                openSelection({ kind: 'problem', id: row.id })
                              }
                            >
                              {row.title}
                            </Button>
                            <div className="caption">{versionLabel(row)}</div>
                          </div>
                        ),
                      },
                      {
                        title: '决定',
                        render: (_, row) => (
                          <ProblemStateTag state={row.state} />
                        ),
                      },
                      {
                        title: '建议严重程度',
                        render: (_, row) => (
                          <IssueSeverityTag severity={row.suggestedSeverity} />
                        ),
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
                  {scope === 'mine' && tab === 'unassigned' && (
                    <Alert
                      type="info"
                      title="待认领条目没有当前负责人，因此不属于我负责的范围。"
                      showIcon
                    />
                  )}

                  <BulkActionBar
                    selected={chosenIssues.length}
                    onClear={() => setSelectedIssues([])}
                    scope="只处理本次明确选择的正式缺陷"
                    selectionActions={
                      <Checkbox
                        checked={includeMerged}
                        onChange={(event) =>
                          setIncludeMerged(event.target.checked)
                        }
                      >
                        包含合并关系中的保留原记录
                      </Checkbox>
                    }
                  >
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
                  </BulkActionBar>
                  <Table
                    rowKey="id"

                    loading={loading && issues.length > 0}
                    dataSource={groupedIssues}
                    pagination={{
                      className: 'result-table-pagination',
                      pageSize: 15,
                      size: 'small',
                      showTotal: (total, range) =>
                        `第 ${range[0]}–${range[1]} 条 · 共 ${total} 条`,
                    }}
                    scroll={{ x: 760 }}
                    rowSelection={{
                      selectedRowKeys: selectedIssues,
                      onChange: (keys) => setSelectedIssues(keys.map(String)),
                    }}
                    locale={{
                      emptyText: emptyFeedback('正式缺陷', issueError),
                    }}
                    columns={[
                      {
                        title: '缺陷 / 需求',
                        width: 230,
                        render: (_, row) => (
                          <div className="table-title">
                            {groupHeading(issueGroups, row)}
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
                              {' · '}
                              {versionLabel(row)}
                            </div>
                            <IssueSeverityTag severity={row.severity} />
                            {row.mergedIntoId && (
                              <span className="badge">保留合并从项</span>
                            )}
                          </div>
                        ),
                      },
                      {
                        title: '状态',
                        width: 110,
                        render: (_, row) => <IssueStateTag state={row.state} />,
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
                                {row.latestHandling ? (
                                  <>
                                    最近处理人：
                                    {name(row.latestHandling.actorId)} ·{' '}
                                    <BeijingTime
                                      value={row.latestHandling.createdAt}
                                    />
                                  </>
                                ) : (
                                  '尚无责任变更'
                                )}
                              </div>
                            </details>
                          </div>
                        ),
                      },
                      {
                        title: '更新时间',
                        width: 112,
                        render: (_, row) => (
                          <BeijingTime value={row.updatedAt} />
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
        onEvidence={(fileId, evidenceType) =>
          setEvidenceSelection({
            fileId,
            ...(evidenceType ? { evidenceType } : {}),
          })
        }
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
      <EvidenceViewer
        fileId={evidenceSelection?.fileId ?? null}
        {...(evidenceSelection?.evidenceType
          ? { evidenceType: evidenceSelection.evidenceType }
          : {})}
        onClose={() => setEvidenceSelection(null)}
      />
    </div>
  );
}
