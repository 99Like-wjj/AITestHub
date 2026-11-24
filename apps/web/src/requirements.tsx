import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Modal,
  Pagination,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DownloadOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import {
  materialSchema,
  requirementLifecycleSchema,
} from '../../../packages/contracts/src/domain';
import {
  requirementDetailSchema,
  requirementHistorySchema,
  requirementPageSchema,
  requirementPageQuerySchema,
  requirementMutationReceiptSchema,
  requirementEligibleParticipantsSchema,
  requirementParticipantSchema,
  requirementCollaborationStatusSchema,
} from '../../../packages/contracts/src/requirements';
import type {
  RequirementDetail,
  RequirementListItem,
} from '../../../packages/contracts/src/requirements';
import { api, ApiError, describeError, isClosedOperationReceipt } from './api';
import {
  identityCommandSettled,
  pendingIdentityCommands,
  resolveIdentityCommand,
  type IdentityCommandSettlement,
} from './identity-commands';
import { uiLayers } from './ui-layers';
import {
  PrivateFilePreviewContent,
  PrivateFilePreviewDownload,
  usePrivateFilePreview,
} from './private-file-preview';
import { PageHeading } from './page-heading';
import { BeijingTime, formatBeijingTime } from './beijing-time';
import { StatusTag } from './semantic-status';
import { canEditProjectRequirements } from './project-access';
import { RequirementDirectory } from './requirement-directory';
import { ExplorerTree, type ExplorerNode } from './explorer-tree';
import {
  ResultFilters,
  ResultListState,
  ResultPagination,
} from './result-list';
import { CommandDialog, useBusinessCommand } from './business-command';
import { downloadPrivateFile } from './file-channel';
import {
  purposeLabels,
  readabilityLabels,
  RequirementComposer,
} from './requirement-composer';
import type { Requirement } from './requirement-composer';
import type { Me, Project } from './types';
import {
  RequirementDeleteDialog,
  usePendingRequirementDeletions,
} from './requirement-delete';
import type { RequirementDeleteTarget } from './requirement-delete';

type Material = z.infer<typeof materialSchema>;
type Lifecycle = z.infer<typeof requirementLifecycleSchema>;
type EligibleParticipant = z.infer<typeof requirementParticipantSchema>;
export interface CaseScope {
  projectId: string;
  requirementId: string;
  requirementVersionId: string;
  title: string;
  versionNo: number;
  kind: 'UI' | 'API';
  historical?: boolean;
}
const statusLabel = (requirement: {
  lifecycle: Lifecycle;
  inactive: boolean;
}) =>
  requirement.lifecycle === 'archived'
    ? '已归档'
    : requirement.inactive
      ? '长期未活跃'
      : '进行中';

function MaterialPreview({
  material,
  onClose,
}: {
  material: Material | null;
  onClose: () => void;
}) {
  const preview = usePrivateFilePreview(material?.fileResourceId ?? null);
  return (
    <Modal
      open={material !== null}
      zIndex={uiLayers.evidence}
      title={material ? `预览：${material.originalName}` : '材料预览'}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭预览</Button>
          <PrivateFilePreviewDownload state={preview} />
        </Space>
      }
      width={1100}
      destroyOnHidden
    >
      <PrivateFilePreviewContent state={preview} />
    </Modal>
  );
}

export function RequirementsPage({
  me,
  project,
  onOpenCases,
}: {
  me: Me;
  project: Project | null;
  onOpenCases: (scope: CaseScope) => void;
}) {
  const { message } = App.useApp();
  const [requirements, setRequirements] = useState<RequirementListItem[]>([]);
  const [directory, setDirectory] = useState<
    z.infer<typeof assetNavigationSchema>['requirements']
  >([]);
  const [directoryError, setDirectoryError] = useState<string>();
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [participation, setParticipation] = useState<'all' | 'mine'>('all');
  const [status, setStatus] =
    useState<z.infer<typeof requirementPageQuerySchema>['status']>('all');
  const archived = status === 'archived';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequirementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [historicalVersionId, setHistoricalVersionId] = useState<string>();
  const [historicalMaterials, setHistoricalMaterials] =
    useState<RequirementDetail['currentVersion']>();
  const [preview, setPreview] = useState<Material | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerRequirement, setComposerRequirement] = useState<{
    requirement: Requirement;
    currentVersion: RequirementDetail['currentVersion'];
    mode: 'replace' | 'successor';
  }>();
  const [members, setMembers] = useState<EligibleParticipant[]>([]);
  const [collaborationBase, setCollaborationBase] = useState<{
    id: string;
    rowVersion: number;
    userIds: string[];
    lifecycle: Lifecycle;
  } | null>(null);
  const [draftParticipants, setDraftParticipants] = useState<string[]>([]);
  const collaborationDirty = Boolean(
    collaborationBase &&
    JSON.stringify([...draftParticipants].sort()) !==
      JSON.stringify([...collaborationBase.userIds].sort()),
  );
  const collaboration = useBusinessCommand(
    selectedId && collaborationBase?.id === selectedId
      ? `${project?.id}:${selectedId}:${collaborationBase.rowVersion}`
      : null,
  );
  const dirtyRef = useRef(collaborationDirty),
    uncertainRef = useRef(collaboration.uncertain),
    baseRef = useRef(collaborationBase);
  dirtyRef.current = collaborationDirty;
  uncertainRef.current = collaboration.uncertain;
  baseRef.current = collaborationBase;
  const [mutating, setMutating] = useState(false);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const tester = project?.roles.includes('tester') ?? false;
  const canEdit = canEditProjectRequirements(project);
  const pendingDeletions = usePendingRequirementDeletions(
    me.user.id,
    project?.id,
  );
  const [deletionTarget, setDeletionTarget] =
    useState<RequirementDeleteTarget | null>(null);
  const deletionContext = `${me.user.id}:${project?.id}:${tester}`;
  const deletionContextRef = useRef(deletionContext);
  deletionContextRef.current = deletionContext;
  const deletionPendingForSelected = pendingDeletions.records.some(
    (item) => item.requirementId === selectedId,
  );
  const deletionBlocked =
    collaborationDirty ||
    collaboration.pending ||
    collaboration.uncertain ||
    mutating ||
    composerOpen ||
    Boolean(pendingDeletions.error);
  useEffect(() => setDeletionTarget(null), [me.user.id, project?.id, tester]);
  const selectedVersion = historicalVersionId
    ? historicalMaterials
    : detail?.currentVersion;

  async function load(signal?: AbortSignal) {
    const epoch = ++listEpoch.current;
    if (!project) {
      setRequirements([]);
      setTotal(0);
      setLoadedProjectId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await api(
        `/projects/${project.id}/requirements/page?${new URLSearchParams({ archived: String(archived), page: String(page), pageSize: String(pageSize), participation, status, search: appliedSearch })}`,
        signal ? { signal } : {},
        requirementPageSchema,
      );
      if (!signal?.aborted && epoch === listEpoch.current) {
        setRequirements(response.requirements);
        setTotal(response.total);
        setLoadedProjectId(project.id);
        if (
          response.total > 0 &&
          response.page > Math.ceil(response.total / response.pageSize)
        )
          setPage(Math.max(1, Math.ceil(response.total / response.pageSize)));
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted && epoch === listEpoch.current) {
        setRequirements([]);
        setTotal(0);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === listEpoch.current) setLoading(false);
    }
  }
  async function loadDetail(
    id: string,
    pinnedVersionId = historicalVersionId,
    signal?: AbortSignal,
  ) {
    const epoch = ++detailEpoch.current;
    if (!project) return;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const [response, eligible, history] = await Promise.all([
        api(
          `/projects/${project.id}/requirements/${id}`,
          signal ? { signal } : {},
          requirementDetailSchema,
        ),
        pinnedVersionId
          ? undefined
          : api(
              `/projects/${project.id}/requirements/eligible-participants`,
              signal ? { signal } : {},
              requirementEligibleParticipantsSchema,
            ),
        pinnedVersionId
          ? api(
              `/projects/${project.id}/requirements/${id}/history`,
              signal ? { signal } : {},
              requirementHistorySchema,
            )
          : undefined,
      ]);
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setDetail(response);
        setMembers(eligible?.users ?? []);
        const pinned = history?.versions.find(
          (version) => version.id === pinnedVersionId,
        );
        setHistoricalMaterials(pinned);
        if (pinnedVersionId && !pinned)
          setDetailError('未找到此链接指向的需求资料快照。');
        if (
          baseRef.current?.id !== id ||
          (!dirtyRef.current && !uncertainRef.current)
        )
          syncCollaboration(response);
      }
    } catch (err) {
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setDetail(null);
        setDetailError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === detailEpoch.current)
        setDetailLoading(false);
    }
  }
  useEffect(() => {
    setSelectedId(null);
    setHistoricalVersionId(undefined);
    setHistoricalMaterials(undefined);
    setDetail(null);
    setPreview(null);
    setComposerOpen(false);
    setCollaborationBase(null);
    setError(undefined);
    setRequirements([]);
    setTotal(0);
    setLoadedProjectId(null);
    setPage(1);
  }, [project?.id]);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    setDirectory([]);
    setDirectoryError(undefined);
    void api(
      `/projects/${project.id}/assets/navigation?kind=UI&includeArchivedRequirements=${archived}`,
      { signal: controller.signal },
      assetNavigationSchema,
    ).then(
      ({ requirements }) => {
        if (!controller.signal.aborted) setDirectory(requirements);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setDirectoryError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [project?.id, archived, requirements]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(search.trim());
      setPage(1);
    }, 240);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [
    project?.id,
    archived,
    participation,
    status,
    appliedSearch,
    page,
    pageSize,
  ]);
  useEffect(() => {
    if (!selectedId) {
      detailEpoch.current += 1;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setHistoricalMaterials(undefined);
    void loadDetail(selectedId, historicalVersionId, controller.signal);
    return () => controller.abort();
  }, [selectedId, historicalVersionId, project?.id]);
  useEffect(() => {
    function followLink() {
      const [page, search] = window.location.hash.split('?');
      if (page !== '#requirements') return;
      const query = new URLSearchParams(search);
      if (query.get('projectId') !== project?.id) return;
      const selected = idSchema.safeParse(query.get('requirementId'));
      if (selected.success) {
        setHistoricalVersionId(
          idSchema.safeParse(query.get('requirementVersionId')).data,
        );
        setSelectedId(selected.data);
      }
    }
    followLink();
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, [project?.id]);

  function clearResultFilters() {
    setSearch('');
    setAppliedSearch('');
    setStatus('all');
    setPage(1);
  }
  function openCurrent(id: string) {
    const url = new URLSearchParams(window.location.hash.split('?')[1]);
    if (project && url.has('requirementVersionId')) {
      url.delete('requirementVersionId');
      url.set('projectId', project.id);
      url.set('requirementId', id);
      window.history.replaceState(null, '', `#requirements?${url}`);
    }
    setHistoricalVersionId(undefined);
    setSelectedId(id);
  }
  async function saved(id: string) {
    await load();
    if (selectedId !== id || historicalVersionId) openCurrent(id);
    else await loadDetail(id);
  }
  async function refreshSelected() {
    await load();
    if (selectedId) await loadDetail(selectedId);
  }
  function syncCollaboration(value: RequirementDetail) {
    const ids = value.participants.map((person) => person.id);
    setCollaborationBase({
      id: value.requirement.id,
      rowVersion: value.requirement.rowVersion,
      userIds: ids,
      lifecycle: value.requirement.lifecycle,
    });
    setDraftParticipants(ids);
  }
  async function saveCollaboration() {
    if (
      !project ||
      !detail ||
      !collaborationBase ||
      detail.requirement.id !== collaborationBase.id ||
      deletionPendingForSelected ||
      !collaborationDirty
    )
      return;
    const input = {
      rowVersion: collaborationBase.rowVersion,
      userIds: draftParticipants,
      lifecycle: collaborationBase.lifecycle,
    };
    const saved = await collaboration.run((commandId) =>
      api(
        `/projects/${project.id}/requirements/${detail.requirement.id}/collaboration`,
        { method: 'PUT', body: { commandId, ...input } },
        requirementMutationReceiptSchema,
      ),
    );
    if (saved) {
      setCollaborationBase({
        id: detail.requirement.id,
        rowVersion: saved.rowVersion,
        userIds: input.userIds,
        lifecycle: input.lifecycle,
      });
      await refreshSelected();
      void message.success('参与名单已保存');
    }
  }
  async function recoverCollaboration() {
    if (!project || !selectedId) return;
    const commandId = collaboration.commandId;
    const epoch = detailEpoch.current;
    const settleBrowserRecord = () => {
      const record = pendingIdentityCommands(me.user.id).find(
        (item) =>
          item.operation === 'requirements.collaboration' &&
          item.projectId === project.id &&
          item.targetId === selectedId &&
          item.commandId === commandId,
      );
      if (record) resolveIdentityCommand(record);
    };
    try {
      const value = await api(
        `/projects/${project.id}/requirements/${selectedId}/collaboration-receipts/${encodeURIComponent(commandId)}`,
        {},
        requirementCollaborationStatusSchema,
      );
      if (value.commandId !== commandId || epoch !== detailEpoch.current)
        return;
      if (value.status === 'completed' && value.response) {
        settleBrowserRecord();
        collaboration.confirmRecoveredReceipt();
        setCollaborationBase((current) =>
          current
            ? {
                ...current,
                rowVersion: value.response!.rowVersion,
                userIds: draftParticipants,
                lifecycle: current.lifecycle,
              }
            : current,
        );
        await refreshSelected();
        void message.success('已核对原保存回执');
      } else if (value.status === 'failed') {
        settleBrowserRecord();
        collaboration.closeRecoveredReceipt(commandId);
      } else
        collaboration.setError('原保存仍未结束，保持原标识查询，不重复提交。');
    } catch (failure) {
      if (epoch !== detailEpoch.current) return;
      if (isClosedOperationReceipt(failure)) {
        settleBrowserRecord();
        collaboration.closeRecoveredReceipt(commandId);
        return;
      }
      collaboration.setError(
        failure instanceof ApiError && failure.status === 404
          ? '暂未查到原回执。可在顶部「待核对操作」结束本次核对。'
          : describeError(failure),
      );
    }
  }
  useEffect(() => {
    const settle = ({ detail }: CustomEvent<IdentityCommandSettlement>) => {
      const { record } = detail;
      if (
        record.userId !== me.user.id ||
        record.operation !== 'requirements.collaboration' ||
        record.projectId !== project?.id ||
        record.targetId !== selectedId ||
        record.commandId !== collaboration.commandId
      )
        return;
      if (detail.outcome === 'closed')
        collaboration.closeRecoveredReceipt(record.commandId);
      if (detail.outcome === 'collaborationCompleted')
        void recoverCollaboration();
    };
    window.addEventListener(identityCommandSettled, settle);
    return () => window.removeEventListener(identityCommandSettled, settle);
  }, [me.user.id, project?.id, selectedId, collaboration.commandId]);
  async function archiveRequirement() {
    if (!project || !detail || deletionPendingForSelected) return;
    setMutating(true);
    setDetailError(undefined);
    try {
      await api(
        `/projects/${project.id}/requirements/${detail.requirement.id}/archive`,
        {
          method: 'PUT',
          body: {
            commandId: crypto.randomUUID(),
            rowVersion: detail.requirement.rowVersion,
            archived: !detail.requirement.archivedAt,
          },
        },
        requirementMutationReceiptSchema,
      );
      await refreshSelected();
    } catch (err) {
      setDetailError(describeError(err));
    } finally {
      setMutating(false);
    }
  }
  function cases(
    requirement: Requirement,
    version: { id: string; versionNo: number },
    kind: 'UI' | 'API',
    historical = false,
  ) {
    onOpenCases({
      projectId: requirement.projectId,
      requirementId: requirement.id,
      requirementVersionId: version.id,
      title: requirement.title,
      versionNo: version.versionNo,
      kind,
      ...(historical && { historical: true }),
    });
  }

  const requirementsDirectory: ExplorerNode[] = [
    { id: 'all', title: '全部需求', kind: 'all' },
    ...directory.map((requirement) => ({
      id: `requirement:${requirement.id}`,
      title: requirement.title,
      kind: 'requirement' as const,
      archived: requirement.archived,
      count: `${requirement.caseCount} 条 UI 用例`,
    })),
  ];

  if (!project)
    return (
      <Card>
        <Empty
          description={
            me.projects.length
              ? '请先选择当前有效项目，再访问需求管理。'
              : '当前没有可访问的项目。请联系项目管理员添加成员，再访问需求管理。'
          }
        />
      </Card>
    );
  return (
    <>
      <section className="requirements-page">
        <PageHeading
          title="需求管理"
          description="维护需求资料与协作范围，并进入需求对应的用例和缺陷。"
          actions={
            <Button
              className="btn primary"
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canEdit}
              onClick={() => {
                setComposerRequirement(undefined);
                setComposerOpen(true);
              }}
            >
              新增需求
            </Button>
          }
        />
        {tester && pendingDeletions.error && (
          <Alert
            type="warning"
            showIcon
            className="section-alert"
            title={pendingDeletions.error}
          />
        )}
        {tester && pendingDeletions.records.length > 0 && (
          <div className="notice amber mb">
            <p>
              原需求删除提交待核对。即使原需求行已消失，仍可按原标识只读查询。
            </p>
            {pendingDeletions.records.map((record) => (
              <div className="row wrap mt" key={record.commandId}>
                <span className="grow caption mono">
                  需求 {record.requirementId} · 原提交 {record.commandId}
                </span>
                <Button
                  className="btn small"
                  size="small"
                  disabled={collaboration.pending || mutating}
                  onClick={() =>
                    setDeletionTarget({
                      requirementId: record.requirementId,
                      session: crypto.randomUUID(),
                      recovery: record,
                    })
                  }
                >
                  查询原删除回执
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="requirement-directory-layout">
          <RequirementDirectory
            archiveLabel="查看已归档需求"
            includeArchived={archived}
            onIncludeArchivedChange={(value) => {
              setLoading(true);
              setStatus(value ? 'archived' : 'all');
              setPage(1);
            }}
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="搜索需求名称"
          >
            {directoryError ? (
              <Alert type="warning" title={directoryError} showIcon />
            ) : (
              <ExplorerTree
                label="需求目录"
                nodes={requirementsDirectory}
                search={search}
                storageKey={`explorer:requirements:${me.user.id}:${project.id}`}
                selected={selectedId ? `requirement:${selectedId}` : 'all'}
                onSelect={(key) => {
                  if (key === 'all') {
                    setSelectedId(null);
                    setHistoricalVersionId(undefined);
                    return;
                  }
                  if (key.startsWith('requirement:'))
                    openCurrent(key.slice(12));
                }}
              />
            )}
          </RequirementDirectory>
          <div className="explorer-workspace-main">
            <div className="requirement-filters">
              <ResultFilters
                onReset={clearResultFilters}
                summary={
                  loading
                    ? '正在读取'
                    : error
                      ? '读取失败'
                      : `共 ${total} 个需求`
                }
              >
                <div className="segmented" role="group" aria-label="需求范围">
                  <button
                    type="button"
                    className={`tab ${participation === 'all' ? 'active' : ''}`}
                    aria-pressed={participation === 'all'}
                    onClick={() => {
                      if (participation !== 'all' || page !== 1) {
                        setLoading(true);
                        setParticipation('all');
                        setPage(1);
                      }
                    }}
                  >
                    全部需求
                  </button>
                  <button
                    type="button"
                    className={`tab ${participation === 'mine' ? 'active' : ''}`}
                    aria-pressed={participation === 'mine'}
                    onClick={() => {
                      if (participation !== 'mine' || page !== 1) {
                        setLoading(true);
                        setParticipation('mine');
                        setPage(1);
                      }
                    }}
                  >
                    我参与的
                  </button>
                </div>
                <Select
                  aria-label="需求状态"
                  value={status}
                  onChange={(value: typeof status) => {
                    if (value === status) return;
                    setLoading(true);
                    setStatus(value);
                    setPage(1);
                  }}
                  options={[
                    { value: 'all', label: '当前需求' },
                    { value: 'inProgress', label: '进行中' },
                    { value: 'inactive', label: '长期未活跃' },
                    { value: 'archived', label: '已归档' },
                  ]}
                />
              </ResultFilters>
            </div>
            <div className="card tablewrap requirement-list-card">
              <table aria-label="需求列表" aria-busy={loading}>
                <thead>
                  <tr>
                    <th scope="col">需求 / 最新版本</th>
                    <th scope="col">状态</th>
                    <th scope="col">参与人</th>
                    <th scope="col">最近业务更新</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading || (!error && loadedProjectId !== project.id) ? (
                    <tr>
                      <td colSpan={5}>
                        <ResultListState
                          state="loading"
                          title="正在读取需求列表"
                        />
                      </td>
                    </tr>
                  ) : requirements.length ? (
                    requirements.map((item) => (
                      <tr key={item.id}>
                        <td className="table-title">
                          <b>{item.title}</b>
                          <div className="sub">
                            {item.businessNumber ?? `ID ${item.id.slice(0, 8)}`}
                          </div>
                        </td>
                        <td>
                          <StatusTag
                            tone={
                              item.lifecycle === 'archived'
                                ? 'neutral'
                                : item.inactive
                                  ? 'warning'
                                  : 'success'
                            }
                          >
                            {statusLabel(item)}
                          </StatusTag>
                        </td>
                        <td>
                          <div className="avatars">
                            {item.participantPreview.map((person) => (
                              <span
                                className="avatar"
                                key={person.id}
                                title={`${person.displayName}（${person.account}）`}
                                aria-label={`${person.displayName}（${person.account}）`}
                              >
                                {person.displayName.slice(0, 2) ||
                                  person.account.slice(0, 2)}
                              </span>
                            ))}
                          </div>
                          <div className="sub">
                            {item.participantCount} 人参与
                          </div>
                        </td>
                        <td>
                          <BeijingTime value={item.businessUpdatedAt} />
                        </td>
                        <td>
                          <div className="row wrap">
                            <Button
                              className="btn small"
                              size="small"
                              onClick={() => openCurrent(item.id)}
                            >
                              查看需求
                            </Button>
                            <Button
                              className="btn small"
                              size="small"
                              onClick={() =>
                                cases(
                                  item,
                                  {
                                    id: item.latestVersionId,
                                    versionNo: item.latestVersionNo,
                                  },
                                  'UI',
                                )
                              }
                            >
                              查看用例
                            </Button>
                          </div>
                          <div className="sub">
                            UI {item.uiCaseCount} · 接口 {item.apiCaseCount}
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>
                        {error ? (
                          <ResultListState
                            state="error"
                            title="需求列表读取失败"
                            description={error}
                            action={
                              <Button onClick={() => void load()}>
                                重新读取
                              </Button>
                            }
                          />
                        ) : appliedSearch || status !== 'all' ? (
                          <ResultListState
                            state="no-match"
                            title={
                              archived
                                ? '没有匹配的已归档需求'
                                : '没有符合条件的需求'
                            }
                            description="可调整搜索和状态，或清空结果筛选。"
                            action={
                              <Button onClick={clearResultFilters}>
                                清空结果筛选
                              </Button>
                            }
                          />
                        ) : (
                          <ResultListState
                            state="empty"
                            title={
                              participation === 'mine'
                                ? '暂无我参与的需求'
                                : '此项目暂无当前需求'
                            }
                            description={
                              participation === 'mine'
                                ? '可切换需求范围查看其他有权限的需求。'
                                : '新增需求后可上传资料并设计用例。已归档需求可通过状态筛选查看。'
                            }
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {!error && total > 0 && (
              <ResultPagination
                summary={`第 ${page}／${Math.ceil(total / pageSize)} 页 · 共 ${total} 个需求`}
              >
                <Pagination
                  current={page}
                  pageSize={pageSize}
                  total={total}
                  showSizeChanger
                  pageSizeOptions={[10, 20, 50, 100]}
                  onChange={(next, size) => {
                    setLoading(true);
                    setPage(next);
                    setPageSize(size);
                  }}
                />
              </ResultPagination>
            )}
            <p className="caption mt">
              长期未活跃仅是静默标记。例行接口回归、查看和参与名单变更不刷新业务活跃时间。
            </p>
          </div>
        </div>
      </section>
      <CommandDialog
        title={
          detail?.requirement.projectId === project.id
            ? detail.requirement.title
            : '需求详情'
        }
        open={selectedId !== null}
        onClose={() => {
          setSelectedId(null);
          setHistoricalVersionId(undefined);
          setDetail(null);
          setCollaborationBase(null);
        }}
        width={1030}
        zIndex={uiLayers.detail}
        command={collaboration}
        dirty={collaborationDirty}
        onSave={() => void saveCollaboration()}
        saveLabel="保存参与名单"
        busy={detailLoading || mutating}
        allowSave={Boolean(
          detail &&
          detail.requirement.projectId === project.id &&
          !historicalVersionId &&
          !deletionPendingForSelected &&
          collaborationDirty,
        )}
      >
        {detailLoading && <Skeleton active />}
        {detailError && (
          <Alert
            type="error"
            showIcon
            title={detailError}
            className="section-alert"
          />
        )}
        {detail && detail.requirement.projectId === project.id && (
          <>
            {!historicalVersionId && (
              <>
                {collaboration.uncertain && (
                  <Button
                    className="btn"
                    onClick={() => void recoverCollaboration()}
                  >
                    核对原保存回执
                  </Button>
                )}
                {collaborationBase &&
                  detail.requirement.rowVersion !==
                    collaborationBase.rowVersion && (
                    <Alert
                      type="warning"
                      className="section-alert"
                      title="服务器资料已有更新，本地修改已保留"
                      description={
                        <>
                          <p>
                            服务器：{statusLabel(detail.requirement)}
                            ；参与人：
                            {detail.participants
                              .map((person) => person.displayName)
                              .join('、') || '无'}
                            。
                          </p>
                          <Space wrap>
                            <Button
                              disabled={
                                collaboration.pending || collaboration.uncertain
                              }
                              onClick={() => syncCollaboration(detail)}
                            >
                              载入服务器内容
                            </Button>
                            <Button
                              disabled={
                                collaboration.pending || collaboration.uncertain
                              }
                              onClick={() =>
                                setCollaborationBase({
                                  id: detail.requirement.id,
                                  rowVersion: detail.requirement.rowVersion,
                                  userIds: detail.participants.map(
                                    (person) => person.id,
                                  ),
                                  lifecycle: detail.requirement.lifecycle,
                                })
                              }
                            >
                              采用当前基准，保留我的修改
                            </Button>
                          </Space>
                        </>
                      }
                    />
                  )}
                <div className="row wrap mb">
                  <span
                    className={`badge ${detail.requirement.lifecycle === 'archived' ? '' : detail.requirement.inactive ? 'amber' : 'green'}`}
                  >
                    {statusLabel(detail.requirement)}
                  </span>
                  <span className="badge">
                    {detail.requirement.businessNumber ??
                      `ID ${detail.requirement.id.slice(0, 8)}`}
                  </span>
                  {collaborationDirty && (
                    <span className="caption">有未保存修改</span>
                  )}
                  <span className="grow" />
                  <Button
                    className="btn small"
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={collaboration.pending || mutating}
                    loading={detailLoading}
                    onClick={() => {
                      if (selectedId) void loadDetail(selectedId);
                    }}
                  >
                    刷新详情
                  </Button>
                </div>
                <h3>需求参与人</h3>
                <p className="caption">
                  所有项目成员可维护参与名单，不改变项目角色或缺陷分配。
                </p>
                <div className="row wrap mt requirement-members">
                  {members.map((person) => (
                    <label
                      className="chip"
                      key={person.id}
                      title={person.account}
                    >
                      <input
                        type="checkbox"
                        checked={draftParticipants.includes(person.id)}
                        disabled={
                          collaboration.pending ||
                          collaboration.uncertain ||
                          deletionPendingForSelected
                        }
                        onChange={(e) =>
                          setDraftParticipants((current) =>
                            e.target.checked
                              ? [...current, person.id]
                              : current.filter((id) => id !== person.id),
                          )
                        }
                      />
                      {person.displayName}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="divider" />
            <div className="requirement-version-toolbar">
              <Space wrap>
                <h3>{historicalVersionId ? '资料快照' : '需求资料'}</h3>
                {historicalVersionId ? (
                  <Button onClick={() => openCurrent(detail.requirement.id)}>
                    查看当前资料
                  </Button>
                ) : (
                  <StatusTag tone={detail.materialLock ? 'success' : 'neutral'}>
                    {detail.materialLock ? '资料已固定' : '资料可更新'}
                  </StatusTag>
                )}
                {selectedVersion && (
                  <Button
                    href={`#issues?projectId=${project.id}&requirementId=${detail.requirement.id}${historicalVersionId ? '&requirementVersion=' + selectedVersion.id : ''}`}
                  >
                    查看缺陷
                  </Button>
                )}
              </Space>
              {canEdit && !historicalVersionId && (
                <Button
                  type="primary"
                  disabled={
                    collaborationDirty ||
                    collaboration.pending ||
                    collaboration.uncertain ||
                    mutating ||
                    deletionPendingForSelected ||
                    (!detail.materialLock &&
                      detail.requirement.lifecycle === 'archived')
                  }
                  onClick={() => {
                    setComposerRequirement({
                      requirement: detail.requirement,
                      currentVersion: detail.currentVersion,
                      mode: detail.materialLock ? 'successor' : 'replace',
                    });
                    setComposerOpen(true);
                  }}
                >
                  {detail.materialLock ? '新建后续需求' : '更新需求资料'}
                </Button>
              )}
            </div>
            {!historicalVersionId &&
              (detail.predecessor || detail.successors.length > 0) && (
                <div className="row wrap mt">
                  {detail.predecessor && (
                    <Button
                      size="small"
                      onClick={() =>
                        openCurrent(detail.predecessor!.requirementId)
                      }
                    >
                      前序需求 · {detail.predecessor.title}
                    </Button>
                  )}
                  {detail.successors.map((next) => (
                    <Button
                      key={next.requirementId}
                      size="small"
                      onClick={() => openCurrent(next.requirementId)}
                    >
                      后续需求 · {next.title}
                    </Button>
                  ))}
                </div>
              )}
            {tester && !historicalVersionId && (
              <div className="row mt">
                <Button
                  className="btn small"
                  size="small"
                  loading={mutating}
                  disabled={
                    collaborationDirty ||
                    collaboration.pending ||
                    collaboration.uncertain ||
                    deletionPendingForSelected
                  }
                  onClick={() => void archiveRequirement()}
                >
                  {detail.requirement.archivedAt
                    ? '恢复至当前需求'
                    : '归档需求'}
                </Button>
                <Button
                  className="btn small"
                  size="small"
                  danger
                  disabled={
                    deletionBlocked ||
                    deletionPendingForSelected ||
                    detailLoading
                  }
                  onClick={() =>
                    setDeletionTarget({
                      requirementId: detail.requirement.id,
                      name: detail.requirement.title,
                      session: crypto.randomUUID(),
                    })
                  }
                >
                  检查永久删除条件
                </Button>
              </div>
            )}
            {selectedVersion && (
              <>
                {historicalVersionId && (
                  <p className="caption">
                    资料快照 v{selectedVersion.versionNo} ·{' '}
                    {formatBeijingTime(selectedVersion.createdAt, true)}
                  </p>
                )}
                {selectedVersion.summary && (
                  <Typography.Paragraph className="section-alert">
                    {selectedVersion.summary}
                  </Typography.Paragraph>
                )}
                <details className="caption technical-details">
                  <summary>版本校验信息</summary>
                  <Typography.Paragraph type="secondary">
                    材料集合摘要：
                    <Typography.Text code>
                      {selectedVersion.materialSetDigest}
                    </Typography.Text>
                  </Typography.Paragraph>
                </details>
                <Table<Material>
                  rowKey="id"
                  dataSource={selectedVersion.materials}
                  pagination={false}
                  size="small"
                  scroll={{ x: 730 }}
                  columns={[
                    { title: '材料', dataIndex: 'originalName' },
                    {
                      title: '用途',
                      render: (_, material) => (
                        <Tag>{purposeLabels[material.purpose]}</Tag>
                      ),
                    },
                    {
                      title: '可读性',
                      render: (_, material) =>
                        readabilityLabels[material.readability],
                    },
                    {
                      title: '原件与预览',
                      render: (_, material) =>
                        material.sourceLink ? (
                          <Space direction="vertical" size={2}>
                            <a
                              href={material.sourceLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看来源链接
                            </a>
                            <Typography.Text type="secondary">
                              保存链接不代表平台已读取
                            </Typography.Text>
                          </Space>
                        ) : material.sourceLinkUnavailableReason ? (
                          <Typography.Text type="warning">
                            {material.sourceLinkUnavailableReason ===
                            'AUTHENTICATION_SOURCE_LINK'
                              ? '来源链接包含认证信息，已隐藏；原历史和其他材料保留。'
                              : material.sourceLinkUnavailableReason ===
                                  'UNSUPPORTED_SOURCE_LINK_PROTOCOL'
                                ? '来源链接协议不可用，已隐藏；原历史保留。'
                                : '原来源链接格式不可用，已隐藏；其他材料仍可查看。'}
                          </Typography.Text>
                        ) : material.fileResourceId ? (
                          <Space>
                            <Button
                              icon={<EyeOutlined />}
                              onClick={() => setPreview(material)}
                            >
                              预览
                            </Button>
                            <Button
                              icon={<DownloadOutlined />}
                              onClick={() => {
                                if (material.fileResourceId)
                                  void downloadPrivateFile(
                                    material.fileResourceId,
                                    material.originalName,
                                  ).catch((err: unknown) =>
                                    message.error(describeError(err)),
                                  );
                              }}
                            >
                              原件
                            </Button>
                          </Space>
                        ) : (
                          <Tag color="red">材料引用缺失</Tag>
                        ),
                    },
                  ]}
                />
                <Space className="section-alert" wrap>
                  <Button
                    disabled={
                      collaborationDirty ||
                      collaboration.pending ||
                      collaboration.uncertain ||
                      mutating
                    }
                    onClick={() =>
                      cases(
                        detail.requirement,
                        selectedVersion,
                        'UI',
                        Boolean(historicalVersionId),
                      )
                    }
                  >
                    查看 UI 用例
                  </Button>
                  <Button
                    disabled={
                      collaborationDirty ||
                      collaboration.pending ||
                      collaboration.uncertain ||
                      mutating
                    }
                    onClick={() =>
                      cases(
                        detail.requirement,
                        selectedVersion,
                        'API',
                        Boolean(historicalVersionId),
                      )
                    }
                  >
                    查看接口用例
                  </Button>
                </Space>
              </>
            )}
          </>
        )}
      </CommandDialog>
      <RequirementComposer
        projectId={project.id}
        target={composerRequirement}
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSaved={saved}
      />
      <MaterialPreview material={preview} onClose={() => setPreview(null)} />
      {tester && deletionTarget && (
        <RequirementDeleteDialog
          key={deletionTarget.session}
          userId={me.user.id}
          projectId={project.id}
          tester={tester}
          blocked={deletionBlocked}
          target={deletionTarget}
          onClose={() => setDeletionTarget(null)}
          onDeleted={(id) => {
            if (deletionContextRef.current !== deletionContext) return;
            setSelectedId((current) => (current === id ? null : current));
            setDetail((current) =>
              current?.requirement.id === id ? null : current,
            );
            setCollaborationBase((current) =>
              current?.id === id ? null : current,
            );
            const query = new URLSearchParams(
              window.location.hash.split('?')[1],
            );
            if (
              window.location.hash.startsWith('#requirements') &&
              query.get('requirementId') === id
            )
              window.location.hash = `requirements?projectId=${project.id}`;
            void load();
          }}
        />
      )}
    </>
  );
}
