import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tree,
  Typography,
} from 'antd';
import type { TreeDataNode } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import {
  approvalCommitReceiptSchema,
  assetDetailSchema,
  assetListSchema,
  assetNavigationSchema,
  assetReceiptSchema,
  latestApprovedResponseSchema,
  removeAssetInputSchema,
} from '../../../packages/contracts/src/assets';
import type {
  Asset,
  AssetContent,
} from '../../../packages/contracts/src/assets';
import { precisePreviewSchema } from '../../../packages/contracts/src/domain';
import { api, describeError } from './api';
import { AssetEditor, targetTypeLabels } from './asset-editor';
import type { AssetEditorTarget } from './asset-editor';
import {
  AssetReviewPanel,
  reviewLabels,
  reviewTones,
} from './asset-review-panel';
import type { CaseScope } from './requirements';
import type { Project } from './types';
import { PageHeading } from './page-heading';
import { AppIcon } from './app-icon';
import { ArchivedRequirementsToggle } from './archived-requirements-toggle';

type Navigation = z.infer<typeof assetNavigationSchema>;
type Detail = z.infer<typeof assetDetailSchema>;
type Preview = z.infer<typeof precisePreviewSchema>;
type ApprovalReceipt = z.infer<typeof approvalCommitReceiptSchema>;
type Approved = z.infer<typeof latestApprovedResponseSchema>;
function reviewFromUrl() {
  const value = new URLSearchParams(window.location.hash.split('?')[1]).get(
    'review',
  );
  return value && ['unapproved', ...Object.keys(reviewLabels)].includes(value)
    ? value
    : 'all';
}
function kindFromUrl(): 'UI' | 'API' {
  return new URLSearchParams(window.location.hash.split('?')[1]).get('kind') ===
    'API'
    ? 'API'
    : 'UI';
}

function ContentView({ content }: { content: AssetContent }) {
  return (
    <>
      {'objective' in content && (
        <Descriptions
          column={1}
          items={[
            {
              key: 'objective',
              label: '场景目标',
              children: (
                <span className="preserve-lines">{content.objective}</span>
              ),
            },
            {
              key: 'preconditions',
              label: '共享前提',
              children: content.sharedPreconditions.length ? (
                <ul>
                  {content.sharedPreconditions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              ) : (
                '未设置'
              ),
            },
          ]}
        />
      )}
      {'testPoint' in content && (
        <Descriptions
          column={1}
          items={[
            {
              key: 'testPoint',
              label: '测试点',
              children: (
                <span className="preserve-lines">{content.testPoint}</span>
              ),
            },
            {
              key: 'preconditions',
              label: '前提',
              children: content.preconditions.length ? (
                <ul>
                  {content.preconditions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              ) : (
                '未设置'
              ),
            },
            {
              key: 'expected',
              label: '业务预期',
              children: (
                <span className="preserve-lines">{content.expected}</span>
              ),
            },
          ]}
        />
      )}
      <Typography.Paragraph type="secondary">
        依据：
        {content.basisRefs.length
          ? content.basisRefs.map((basis) => basis.description).join('；')
          : '未登记依据引用'}
      </Typography.Paragraph>
      {'steps' in content && (
        <Collapse
          items={content.steps.map((step, index) => ({
            key: step.stepId,
            label: `请求 ${index + 1} · ${step.method} · ${step.name}`,
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text code>{step.url}</Typography.Text>
                <Typography.Text>
                  断言 {step.assertions.length} 项 · 提取{' '}
                  {step.extractors.length} 项
                </Typography.Text>
                {step.assertions.map((assertion) => (
                  <Typography.Paragraph key={assertion.id}>
                    {assertion.source}
                    {assertion.path ? `.${assertion.path}` : ''}{' '}
                    {assertion.operator}{' '}
                    {assertion.expected === undefined
                      ? ''
                      : JSON.stringify(assertion.expected)}
                  </Typography.Paragraph>
                ))}
                <Typography.Text type="secondary">
                  Body：{step.body.format}；脚本扩展：
                  {step.preScript || step.postScript ? '已配置' : '未配置'}
                  ；账号用途：{step.purposeRef ?? '未指定'}
                </Typography.Text>
                {!!step.query.length && (
                  <Descriptions
                    size="small"
                    column={1}
                    title="Query"
                    items={step.query.map((entry, at) => ({
                      key: String(at),
                      label: entry.name,
                      children: entry.value,
                    }))}
                  />
                )}
                {!!step.headers.length && (
                  <Descriptions
                    size="small"
                    column={1}
                    title="Header"
                    items={step.headers.map((entry, at) => ({
                      key: String(at),
                      label: entry.name,
                      children:
                        /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(
                          entry.name,
                        )
                          ? '敏感字段已隐藏；认证应使用账号用途配置'
                          : entry.value,
                    }))}
                  />
                )}
                {step.body.format !== 'none' && (
                  <pre className="material-text-preview">
                    {step.body.format === 'json'
                      ? JSON.stringify(step.body.value, null, 2)
                      : step.body.format === 'text'
                        ? step.body.value
                        : step.body.fields
                            .map((field) => `${field.name}: ${field.value}`)
                            .join('\n')}
                  </pre>
                )}
                {!!step.extractors.length && (
                  <Descriptions
                    size="small"
                    column={1}
                    title="提取规则"
                    items={step.extractors.map((extractor, at) => ({
                      key: String(at),
                      label: extractor.name,
                      children: `${extractor.source}${extractor.path ? `.${extractor.path}` : ''} · ${extractor.required ? '必须提取' : '可选'}`,
                    }))}
                  />
                )}
                {step.preScript && (
                  <>
                    <Typography.Text strong>前处理脚本（只读）</Typography.Text>
                    <pre className="material-text-preview">
                      {step.preScript}
                    </pre>
                  </>
                )}
                {step.postScript && (
                  <>
                    <Typography.Text strong>
                      响应处理脚本（只读）
                    </Typography.Text>
                    <pre className="material-text-preview">
                      {step.postScript}
                    </pre>
                  </>
                )}
              </Space>
            ),
          }))}
        />
      )}
      {'cleanup' in content && (
        <Card
          size="small"
          title={`清理定义（只读）· ${content.cleanup.mode}`}
          className="section-alert"
        >
          <Typography.Paragraph type="secondary">
            本处展示已保存定义供评审，不发送清理请求或执行
            SQL。清理目标、清理结果和测试结论分别记录。
          </Typography.Paragraph>
          {content.cleanup.mode === 'none' ? (
            <Typography.Text>此修订未启用清理。</Typography.Text>
          ) : (
            <Collapse
              items={content.cleanup.steps.map((step, index) => ({
                key: step.cleanupStepId,
                label: `清理 ${index + 1} · ${step.type === 'sql' ? step.driver : `${step.request.method} ${step.request.name}`}`,
                children: (
                  <>
                    <Typography.Paragraph>
                      必须具备的本轮目标：{step.requiredTargets.join('、')}
                    </Typography.Paragraph>
                    {step.type === 'sql' ? (
                      <>
                        <Descriptions
                          size="small"
                          column={1}
                          items={[
                            {
                              key: 'environment',
                              label: '环境 ID',
                              children: step.environmentId,
                            },
                            {
                              key: 'connection',
                              label: '连接 ID',
                              children: step.connectionId,
                            },
                            {
                              key: 'parameters',
                              label: '受控参数绑定',
                              children: step.parameters
                                .map(
                                  (parameter) =>
                                    `${parameter.name} ← ${parameter.valueRef}`,
                                )
                                .join('；'),
                            },
                          ]}
                        />
                        <pre className="material-text-preview">
                          {step.statement}
                        </pre>
                      </>
                    ) : (
                      <>
                        <Typography.Paragraph code>
                          {step.request.url}
                        </Typography.Paragraph>
                        <Typography.Paragraph>
                          账号用途：{step.request.purposeRef ?? '未指定'}
                          ；认证配置：{step.request.authProfileRef ?? '未指定'}
                        </Typography.Paragraph>
                        <Typography.Paragraph>
                          断言：
                          {step.request.assertions
                            .map(
                              (assertion) =>
                                `${assertion.source}${assertion.path ? `.${assertion.path}` : ''} ${assertion.operator} ${assertion.expected === undefined ? '' : JSON.stringify(assertion.expected)}`,
                            )
                            .join('；') || '无'}
                        </Typography.Paragraph>
                        {step.request.body.format !== 'none' && (
                          <pre className="material-text-preview">
                            {step.request.body.format === 'json'
                              ? JSON.stringify(step.request.body.value, null, 2)
                              : step.request.body.format === 'text'
                                ? step.request.body.value
                                : step.request.body.fields
                                    .map(
                                      (field) =>
                                        `${field.name}: ${field.value}`,
                                    )
                                    .join('\n')}
                          </pre>
                        )}
                        {step.request.preScript && (
                          <pre className="material-text-preview">
                            {step.request.preScript}
                          </pre>
                        )}
                        {step.request.postScript && (
                          <pre className="material-text-preview">
                            {step.request.postScript}
                          </pre>
                        )}
                      </>
                    )}
                  </>
                ),
              }))}
            />
          )}
        </Card>
      )}
    </>
  );
}

export function AssetsPage({
  project,
  userId,
  scope,
  onScopeChange,
}: {
  project: Project | null;
  userId: string;
  scope: CaseScope | null;
  onScopeChange: (scope: CaseScope | null) => void;
}) {
  const { modal, message } = App.useApp();
  const [localKind, setLocalKind] = useState<'UI' | 'API'>(kindFromUrl);
  const [reviewCounts, setReviewCounts] = useState<{
    UI: number;
    API: number;
  } | null>(null);
  const kind = scope?.kind ?? localKind;
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [batchId, setBatchId] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState<string>(reviewFromUrl);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [includeArchivedRequirements, setIncludeArchivedRequirements] =
    useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [revisionId, setRevisionId] = useState<string>();
  const [latestApproved, setLatestApproved] = useState<Approved | null>(null);
  const [approvalError, setApprovalError] = useState<string>();
  const [editor, setEditor] = useState<AssetEditorTarget | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [receipt, setReceipt] = useState<ApprovalReceipt | null>(null);
  const [commitError, setCommitError] = useState<string>();
  const [committing, setCommitting] = useState(false);
  const commitCommand = useRef(crypto.randomUUID());
  const loadEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const browseContext = useRef<string | null>(null);
  const tester = project?.roles.includes('tester') ?? false;
  const batches = assets.filter((asset) => asset.targetType === 'set');
  const batch = batches.find((asset) => asset.id === batchId) ?? null;
  const selectedRequirement = navigation.requirements.find(
    (requirement) => requirement.id === scope?.requirementId,
  );
  const scopeExists =
    scope === null ||
    Boolean(
      selectedRequirement?.versions.some(
        (version) => version.id === scope.requirementVersionId,
      ),
    );
  const visibleAssets = assets.filter(
    (asset) => batchId === 'all' || asset.setId === batchId,
  );
  const scenarios = visibleAssets.filter(
    (asset) => asset.targetType === 'scenario',
  );
  const keyword = search.trim().toLocaleLowerCase();
  const cases = visibleAssets.filter(
    (asset) =>
      asset.targetType === 'case' &&
      (reviewFilter === 'all' ||
        (reviewFilter === 'unapproved'
          ? asset.reviewState !== 'approved'
          : asset.reviewState === reviewFilter)) &&
      `${asset.title} ${'testPoint' in asset.content ? asset.content.testPoint : ''} ${assets.find((parent) => parent.id === asset.parentId)?.title ?? ''}`
        .toLocaleLowerCase()
        .includes(keyword),
  );
  const revision =
    detail?.revisions.find((item) => item.id === revisionId) ??
    detail?.revisions.find((item) => item.id === detail.asset.revisionId);

  async function load(signal?: AbortSignal) {
    const epoch = ++loadEpoch.current;
    if (!project) {
      setAssets([]);
      setNavigation({ requirements: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        kind,
        includeRemoved: String(includeRemoved),
        includeArchivedRequirements: String(includeArchivedRequirements),
      });
      if (scope) query.set('requirementVersionId', scope.requirementVersionId);
      const [map, data] = await Promise.all([
        api(
          `/projects/${project.id}/assets/navigation?kind=${kind}&includeArchivedRequirements=${includeArchivedRequirements}`,
          signal ? { signal } : {},
          assetNavigationSchema,
        ),
        api(
          `/projects/${project.id}/assets?${query}`,
          signal ? { signal } : {},
          assetListSchema,
        ),
      ]);
      if (!signal?.aborted && epoch === loadEpoch.current) {
        setNavigation(map);
        setAssets(data.assets);
        setError(undefined);
      }
    } catch (err) {
      if (!signal?.aborted && epoch === loadEpoch.current) {
        setAssets([]);
        setNavigation({ requirements: [] });
        setSelectedId(null);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && epoch === loadEpoch.current) setLoading(false);
    }
  }
  async function loadDetail(id: string, signal?: AbortSignal) {
    if (!project) return;
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const response = await api(
        `/projects/${project.id}/assets/${id}`,
        signal ? { signal } : {},
        assetDetailSchema,
      );
      if (!signal?.aborted && epoch === detailEpoch.current) {
        setDetail(response);
        setRevisionId((current) =>
          response.revisions.some(
            (item) =>
              item.id ===
              new URLSearchParams(window.location.hash.split('?')[1]).get(
                'assetRevisionId',
              ),
          )
            ? (new URLSearchParams(window.location.hash.split('?')[1]).get(
                'assetRevisionId',
              ) ?? response.asset.revisionId)
            : response.revisions.some((item) => item.id === current)
              ? current
              : response.asset.revisionId,
        );
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
    const controller = new AbortController();
    const context = `${project?.id}:${kind}:${scope?.requirementVersionId}:${includeRemoved}`;
    const changedContext = browseContext.current !== context;
    browseContext.current = context;
    setAssets([]);
    setBatchId('all');
    setSelectedKeys([]);
    setPreview(null);
    if (changedContext) {
      setSelectedId(null);
      setEditor(null);
      setSearch('');
      setReviewFilter(reviewFromUrl());
    }
    void load(controller.signal);
    return () => controller.abort();
  }, [
    project?.id,
    kind,
    scope?.requirementVersionId,
    includeRemoved,
    includeArchivedRequirements,
  ]);
  useEffect(() => {
    const update = () => {
      setReviewFilter(reviewFromUrl());
      setLocalKind(kindFromUrl());
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReviewCounts(null);
    if (!project || reviewFilter === 'all') return;
    void Promise.all(
      (['UI', 'API'] as const).map(async (assetKind) => {
        const query = new URLSearchParams({
          kind: assetKind,
          includeRemoved: String(includeRemoved),
          includeArchivedRequirements: String(includeArchivedRequirements),
        });
        if (scope)
          query.set('requirementVersionId', scope.requirementVersionId);
        const data = await api(
          `/projects/${project.id}/assets?${query}`,
          { signal: controller.signal },
          assetListSchema,
        );
        return [
          assetKind,
          data.assets.filter(
            (asset) =>
              asset.targetType === 'case' &&
              (reviewFilter === 'unapproved'
                ? asset.reviewState !== 'approved'
                : asset.reviewState === reviewFilter),
          ).length,
        ] as const;
      }),
    )
      .then((counts) => {
        if (!controller.signal.aborted)
          setReviewCounts({
            UI: counts.find(([key]) => key === 'UI')?.[1] ?? 0,
            API: counts.find(([key]) => key === 'API')?.[1] ?? 0,
          });
      })
      .catch(() => {
        /* The current list retains its own read errors; unavailable cross-type counts remain unknown. */
      });
    return () => controller.abort();
  }, [
    project?.id,
    scope?.requirementVersionId,
    reviewFilter,
    includeRemoved,
    includeArchivedRequirements,
    assets,
  ]);
  useEffect(() => {
    const parsed = z
      .uuid()
      .safeParse(
        new URLSearchParams(window.location.hash.split('?')[1]).get('assetId'),
      );
    if (!parsed.success || loading) return;
    const asset = assets.find((item) => item.id === parsed.data);
    if (asset) selectAsset(asset);
    else setSelectedId(parsed.data);
  }, [project?.id, kind, loading, assets]);
  useEffect(() => {
    if (!selectedId) {
      detailEpoch.current += 1;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setRevisionId(undefined);
    void loadDetail(selectedId, controller.signal);
    return () => controller.abort();
  }, [selectedId, project?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLatestApproved(null);
    setApprovalError(undefined);
    if (!project || !detail || detail.asset.targetType !== 'case') return;
    void api(
      `/projects/${project.id}/assets/${detail.asset.id}/latest-approved?kind=${kind}`,
      { signal: controller.signal },
      latestApprovedResponseSchema,
    )
      .then((response) => {
        if (!controller.signal.aborted) setLatestApproved(response);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setApprovalError(describeError(err));
      });
    return () => controller.abort();
  }, [project?.id, detail?.asset.id, detail?.asset.rowVersion, kind]);

  function selectRequirement(id: string) {
    if (!project) return;
    if (id === 'all') {
      changeScope(null);
      return;
    }
    const requirement = navigation.requirements.find((item) => item.id === id);
    const version = requirement
      ? [...requirement.versions].sort((a, b) => b.versionNo - a.versionNo)[0]
      : undefined;
    if (requirement && version)
      changeScope({
        projectId: project.id,
        requirementId: requirement.id,
        title: requirement.title,
        requirementVersionId: version.id,
        versionNo: version.versionNo,
        kind,
      });
  }
  function selectVersion(id: string) {
    if (!scope || !selectedRequirement) return;
    const version = selectedRequirement.versions.find((item) => item.id === id);
    if (version)
      changeScope({
        ...scope,
        requirementVersionId: id,
        versionNo: version.versionNo,
      });
  }
  function changeScope(next: CaseScope | null) {
    onScopeChange(next);
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    query.set('kind', next?.kind ?? kind);
    if (reviewFilter !== 'all') query.set('review', reviewFilter);
    else query.delete('review');
    query.delete('assetId');
    query.delete('assetRevisionId');
    window.location.hash = `cases?${query}`;
  }
  function selectAsset(asset: Asset) {
    if (asset.setId !== batchId) setSelectedKeys([]);
    setSelectedId(asset.id);
    setBatchId(asset.setId);
    const query = new URLSearchParams(window.location.hash.split('?')[1]);
    if (query.has('assetId') && query.get('assetId') !== asset.id) {
      query.set('assetId', asset.id);
      query.delete('assetRevisionId');
      window.location.hash = `cases?${query}`;
    }
  }
  async function changed() {
    await load();
    if (selectedId) await loadDetail(selectedId);
  }
  async function saved(asset: Asset) {
    await load();
    setBatchId(asset.setId);
    setSelectedId(asset.id);
    if (selectedId === asset.id) await loadDetail(asset.id);
  }
  function openEditor(targetType: 'set' | 'scenario' | 'case', source?: Asset) {
    if (!scope) {
      void message.info('先选择明确需求版本。');
      return;
    }
    const setId = source?.setId ?? batch?.id ?? null;
    const scenarioId =
      source?.targetType === 'scenario'
        ? source.id
        : source?.targetType === 'case'
          ? source.parentId
          : null;
    setEditor({
      targetType,
      kind,
      requirementVersionId: scope.requirementVersionId,
      setId,
      scenarioId,
      asset: null,
    });
  }
  function edit(asset: Asset) {
    setEditor({
      targetType: asset.targetType,
      kind: asset.kind,
      requirementVersionId: asset.requirementVersionId,
      setId: asset.setId,
      scenarioId: asset.targetType === 'case' ? asset.parentId : null,
      asset,
    });
  }
  function remove(asset: Asset) {
    if (!project) return;
    const projectId = project.id;
    modal.confirm({
      title: `显式移除${targetTypeLabels[asset.targetType]}「${asset.title}」？`,
      content:
        '历史修订与既有引用保留。批次/场景仍有有效子项时服务会拒绝，不会级联删除子项。',
      okText: '移除当前资产',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const body = removeAssetInputSchema.parse({
            commandId: crypto.randomUUID(),
            baseRevisionId: asset.revisionId,
            rowVersion: asset.rowVersion,
          });
          await api(
            `/projects/${projectId}/assets/${asset.id}`,
            { method: 'DELETE', body },
            assetReceiptSchema,
          );
          setSelectedId(null);
          await load();
        } catch (err) {
          setError(describeError(err));
          throw err;
        }
      },
    });
  }
  async function startPreview(objectIds: string[]) {
    if (!project) return;
    const targets = assets.filter(
      (asset) => objectIds.includes(asset.id) && !asset.removedAt,
    );
    const sets = new Set(targets.map((asset) => asset.setId));
    if (!targets.length || targets.length !== new Set(objectIds).size) {
      setError('没有完整可预览的有效对象，请先刷新范围。');
      return;
    }
    if (sets.size !== 1) {
      setError('请在同一个批次内预览批准范围。不同批次独立评审。');
      return;
    }
    setPreviewLoading(true);
    setError(undefined);
    setCommitError(undefined);
    setReceipt(null);
    try {
      const result = await api(
        `/projects/${project.id}/assets/approval-previews`,
        {
          method: 'POST',
          body: { commandId: crypto.randomUUID(), kind, objectIds },
        },
        precisePreviewSchema,
      );
      commitCommand.current = crypto.randomUUID();
      setPreview(result);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPreviewLoading(false);
    }
  }
  async function approve() {
    if (!project || !preview) return;
    setCommitting(true);
    setCommitError(undefined);
    try {
      const result = await api(
        `/projects/${project.id}/assets/approve`,
        {
          method: 'POST',
          body: {
            commandId: commitCommand.current,
            previewId: preview.previewId,
            scopeDigest: preview.scopeDigest,
            objectIds: preview.items.map((item) => item.id),
          },
        },
        approvalCommitReceiptSchema,
      );
      if (
        result.scopeDigest !== preview.scopeDigest ||
        result.results.length !== preview.items.length ||
        new Set(result.results.map((item) => item.id)).size !==
          preview.items.length ||
        !preview.items.every((item) =>
          result.results.some((row) => row.id === item.id),
        )
      )
        throw new Error(
          '批准回执范围不完整，结果需核对；请保留当前提交标识查询原回执。',
        );
      setReceipt(result);
      await changed();
      setSelectedKeys([]);
    } catch (err) {
      setCommitError(describeError(err));
    } finally {
      setCommitting(false);
    }
  }

  const tree = useMemo<TreeDataNode[]>(
    () =>
      navigation.requirements.map((requirement) => ({
        key: `requirement:${requirement.id}`,
        title: (
          <span>
            {requirement.title}
            {requirement.archived ? '（已归档）' : ''}{' '}
            <Typography.Text type="secondary">
              全版本 {requirement.caseCount}
            </Typography.Text>
          </span>
        ),
        children: assets
          .filter(
            (asset) =>
              asset.targetType === 'scenario' &&
              requirement.versions.some(
                (version) => version.id === asset.requirementVersionId,
              ) &&
              (batchId === 'all' || asset.setId === batchId),
          )
          .map((scenario) => ({
            key: `scenario:${scenario.id}`,
            title: (
              <span>
                {scenario.title}{' '}
                <Typography.Text type="secondary">
                  v
                  {
                    requirement.versions.find(
                      (version) => version.id === scenario.requirementVersionId,
                    )?.versionNo
                  }{' '}
                  · {batches.find((set) => set.id === scenario.setId)?.title}
                </Typography.Text>
              </span>
            ),
            children: assets
              .filter(
                (asset) =>
                  asset.targetType === 'case' && asset.parentId === scenario.id,
              )
              .map((asset) => ({
                key: `case:${asset.id}`,
                title: asset.title,
                isLeaf: true,
              })),
          })),
      })),
    [navigation, assets, batchId],
  );
  if (!project)
    return (
      <Card>
        <Empty description="请先选择当前有效项目，再浏览和维护用例。" />
      </Card>
    );
  const batchMembers = batch
    ? assets.filter((asset) => asset.setId === batch.id && !asset.removedAt)
    : [];
  return (
    <>
      <PageHeading
        eyebrow="TEST ASSETS"
        title="用例中心"
        description="按需求、场景和用例审阅；UI 与接口资产各自维护。"
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              disabled={!tester || !scope || !batch || Boolean(batch.removedAt)}
              onClick={() => openEditor('scenario')}
            >
              新增场景
            </Button>
            <Button
              type="primary"
              icon={<AppIcon name="spark" />}
              disabled={!tester}
              onClick={() => {
                window.location.hash = 'workspace';
              }}
            >
              生成用例
            </Button>
          </>
        }
      />
      <div className="between mb wrap">
        <div className="segmented" aria-label="用例类型">
          {(['UI', 'API'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`tab ${kind === value ? 'active' : ''}`}
              aria-pressed={kind === value}
              onClick={() => {
                setLocalKind(value);
                if (scope) changeScope({ ...scope, kind: value });
                else {
                  const query = new URLSearchParams(
                    window.location.hash.split('?')[1],
                  );
                  query.set('kind', value);
                  query.delete('assetId');
                  window.location.hash = `cases?${query}`;
                }
              }}
            >
              {value === 'UI' ? 'UI 自主测试' : '接口回归'}
              {reviewFilter !== 'all'
                ? ` (${reviewCounts?.[value] ?? '…'})`
                : ''}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <ArchivedRequirementsToggle
            checked={includeArchivedRequirements}
            disabled={editor !== null || preview !== null || committing}
            onChange={(value) => {
              loadEpoch.current += 1;
              setAssets([]);
              setNavigation({ requirements: [] });
              setSelectedKeys([]);
              setLoading(true);
              setIncludeArchivedRequirements(value);
            }}
          />
          <span className="caption">
            先评审，后执行 · AI 已优化仍需人工确认
          </span>
        </div>
      </div>
      {reviewFilter === 'unapproved' && (
        <p className="caption" role="status">
          待评审包含 UI
          与接口两类独立资产，请按上方类型查看；切换类型会保留评审筛选。
        </p>
      )}
      {tester && scope && !batch && (
        <Alert
          type="info"
          showIcon
          className="mb"
          title="新增场景前，请先创建或选择生成批次。"
          action={
            <Button size="small" onClick={() => openEditor('set')}>
              新建批次
            </Button>
          }
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          className="section-alert"
          action={<Button onClick={() => void load()}>刷新范围</Button>}
        />
      )}
      {!loading && !error && !scopeExists && (
        <Alert
          type="info"
          showIcon
          title="当前需求版本不在本次浏览范围"
          description="已归档需求默认隐藏。可开启“显示已归档需求”，或重新选择浏览范围；此开关不删除版本及历史资料。"
          className="section-alert"
        />
      )}
      <div className="asset-workspace live-asset-workspace">
        <aside className="asset-tree">
          <div className="tree-head">需求 / 场景 / 用例</div>
          <button
            type="button"
            className={`tree-node ${scope ? '' : 'active'}`}
            onClick={() => selectRequirement('all')}
          >
            <AppIcon name="folder-closed" />
            <span className="grow">全部需求</span>
            <span className="count">
              {navigation.requirements.reduce((n, r) => n + r.caseCount, 0)}
            </span>
          </button>
          {loading ? (
            <Skeleton active />
          ) : (
            <Tree
              key={`${kind}:${scope?.requirementVersionId ?? 'all'}:${batchId}`}
              treeData={tree}
              defaultExpandAll
              blockNode
              selectedKeys={
                selectedId
                  ? [
                      `${assets.find((asset) => asset.id === selectedId)?.targetType ?? 'case'}:${selectedId}`,
                    ]
                  : scope
                    ? [`requirement:${scope.requirementId}`]
                    : []
              }
              onSelect={([key]) => {
                if (typeof key !== 'string') return;
                if (key.startsWith('requirement:'))
                  selectRequirement(key.slice(12));
                else {
                  const asset = assets.find(
                    (item) => item.id === key.split(':')[1],
                  );
                  if (asset) selectAsset(asset);
                }
              }}
            />
          )}
        </aside>
        <section className="asset-pane">
          <div className="context-head">
            <div>
              <h2>{scope?.title ?? '全部需求'}</h2>
              <p>
                {scope
                  ? `v${scope.versionNo} · ${selectedRequirement?.archived ? '已归档需求' : '当前选定版本'}`
                  : '跨版本只读浏览；新建前请选择明确需求版本。'}
              </p>
            </div>
            <div className="context-controls">
              <Select
                aria-label="用例需求范围"
                value={
                  scope
                    ? selectedRequirement
                      ? scope.requirementId
                      : null
                    : 'all'
                }
                placeholder="当前历史需求未在浏览目录中"
                onChange={selectRequirement}
                options={[
                  { value: 'all', label: '全部需求' },
                  ...navigation.requirements.map((r) => ({
                    value: r.id,
                    label: r.title + (r.archived ? '（已归档）' : ''),
                  })),
                ]}
                style={{ width: 190 }}
              />
              {scope && (
                <Select
                  aria-label="用例需求版本"
                  value={scopeExists ? scope.requirementVersionId : null}
                  placeholder="版本未在浏览目录中"
                  disabled={!selectedRequirement}
                  onChange={selectVersion}
                  options={(selectedRequirement?.versions ?? []).map((v) => ({
                    value: v.id,
                    label: `v${v.versionNo} · ${v.caseCount} 条用例`,
                  }))}
                  style={{ width: 130 }}
                />
              )}
              <Select
                aria-label="生成批次"
                value={batchId}
                onChange={(id) => {
                  setBatchId(id);
                  setSelectedKeys([]);
                  setSelectedId(null);
                }}
                options={[
                  { value: 'all', label: '全部批次' },
                  ...batches.map((b) => ({
                    value: b.id,
                    label: b.title + (b.removedAt ? '（已移除）' : ''),
                  })),
                ]}
                style={{ width: 170 }}
              />
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void load()}
                aria-label="刷新资产"
              />
              {tester && (
                <Button
                  size="small"
                  disabled={!scope || !scopeExists}
                  onClick={() => openEditor('set')}
                >
                  新建批次
                </Button>
              )}
            </div>
          </div>
          <div className="toolbar mb asset-toolbar">
            <Input
              className="searchbox"
              aria-label="搜索用例"
              placeholder="搜索场景或用例"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
            <Select
              aria-label="评审状态筛选"
              value={reviewFilter}
              onChange={(value) => {
                setReviewFilter(value);
                const query = new URLSearchParams(
                  window.location.hash.split('?')[1],
                );
                if (value === 'all') query.delete('review');
                else query.set('review', value);
                window.history.replaceState(
                  null,
                  '',
                  `${window.location.pathname}${window.location.search}#cases${query.size ? '?' + query.toString() : ''}`,
                );
              }}
              options={[
                { value: 'all', label: '全部评审状态' },
                { value: 'unapproved', label: '全部待评审' },
                ...Object.entries(reviewLabels).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              style={{ minWidth: 128 }}
            />
            <span className="grow" />
            <Button
              size="small"
              disabled={!batch}
              onClick={() => batch && setSelectedId(batch.id)}
            >
              测试集意见
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!tester || !selectedKeys.length}
              loading={previewLoading}
              onClick={() => void startPreview(selectedKeys)}
            >
              预览通过已选 {selectedKeys.length} 项
            </Button>
          </div>
          {batch && (
            <div className="batch-note mb">
              <div className="between">
                <div>
                  <b className="small">
                    {batch.title} · {reviewLabels[batch.reviewState]}
                  </b>
                  <p className="caption">
                    本批有效对象 {batchMembers.length} 项，当前通过{' '}
                    {
                      batchMembers.filter((a) => a.reviewState === 'approved')
                        .length
                    }{' '}
                    项；上层意见以批准预览判断，旧批准快照独立保留。
                  </p>
                </div>
                <Button
                  size="small"
                  disabled={!tester || Boolean(batch.removedAt)}
                  loading={previewLoading}
                  onClick={() =>
                    void startPreview(batchMembers.map((a) => a.id))
                  }
                >
                  预览整批对象
                </Button>
              </div>
            </div>
          )}
          {loading ? (
            <Skeleton active />
          ) : !scopeExists || error ? (
            <div className="card pad">
              <Empty
                description={
                  error
                    ? '资产尚未读取成功。'
                    : includeArchivedRequirements
                      ? '此需求版本不在当前项目目录，请重新选择范围。'
                      : '此需求版本当前未展示，可开启“显示已归档需求”或另选范围。'
                }
              />
            </div>
          ) : (
            <>
              {scenarios
                .filter(
                  (scene) =>
                    !keyword ||
                    cases.some((c) => c.parentId === scene.id) ||
                    scene.title.toLocaleLowerCase().includes(keyword),
                )
                .map((scene) => {
                  const rows = cases.filter((c) => c.parentId === scene.id);
                  const requirement = navigation.requirements.find((r) =>
                    r.versions.some((v) => v.id === scene.requirementVersionId),
                  );
                  return (
                    <section className="card scene-card" key={scene.id}>
                      <div className="scene-summary">
                        <AppIcon name="folder-closed" />
                        <div className="grow">
                          <h3>{scene.title}</h3>
                          <p>
                            {requirement?.title ?? '原需求未取得'} ·{' '}
                            {batches.find((b) => b.id === scene.setId)?.title ??
                              '原批次'}{' '}
                            · {rows.length} 条当前筛选用例
                          </p>
                        </div>
                        <span
                          className={`badge ${reviewTones[scene.reviewState]}`}
                        >
                          {reviewLabels[scene.reviewState]}
                        </span>
                        <Button size="small" onClick={() => selectAsset(scene)}>
                          场景意见
                        </Button>
                        {tester && (
                          <Button
                            size="small"
                            disabled={!scope || Boolean(scene.removedAt)}
                            onClick={() => openEditor('case', scene)}
                          >
                            新增用例
                          </Button>
                        )}
                      </div>
                      {rows.map((asset) => (
                        <div className="case-row" key={asset.id}>
                          <Checkbox
                            aria-label={`选择${asset.title}`}
                            disabled={!tester || Boolean(asset.removedAt)}
                            checked={selectedKeys.includes(asset.id)}
                            onChange={(e) =>
                              setSelectedKeys((keys) =>
                                e.target.checked
                                  ? [...keys, asset.id]
                                  : keys.filter((id) => id !== asset.id),
                              )
                            }
                          />
                          <div className="grow">
                            <h3>{asset.title}</h3>
                            <p>
                              {asset.id} · 编辑 r{asset.revisionNo}
                              {'steps' in asset.content
                                ? ` · ${asset.content.steps.length} 个请求`
                                : ''}
                              {asset.removedAt ? ' · 已移除，历史保留' : ''}
                            </p>
                          </div>
                          <span
                            className={`badge ${reviewTones[asset.reviewState]}`}
                          >
                            {reviewLabels[asset.reviewState]}
                          </span>
                          <Button
                            size="small"
                            onClick={() => selectAsset(asset)}
                          >
                            查看
                          </Button>
                          {tester &&
                            asset.reviewState !== 'approved' &&
                            !asset.removedAt && (
                              <Button
                                size="small"
                                onClick={() => void startPreview([asset.id])}
                              >
                                通过
                              </Button>
                            )}
                        </div>
                      ))}
                      {!rows.length && (
                        <div className="case-row">
                          <p className="caption">
                            此场景在当前筛选下暂无具体用例，场景本身仍独立保留。
                          </p>
                        </div>
                      )}
                    </section>
                  );
                })}
              {!scenarios.length && (
                <div className="card pad">
                  <Empty description="此范围尚无场景或用例。UI 与接口资产各自维护。" />
                  {tester && (
                    <div className="row mt">
                      <Button
                        disabled={!scope || !batch}
                        type="primary"
                        onClick={() => openEditor('scenario')}
                      >
                        创建场景
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="between mt">
            <p className="caption">
              当前 {cases.length} 条 · 已选择 {selectedKeys.length}{' '}
              条。不同批次独立评审；生成入口进入真实 AI 工作台后明确范围。
            </p>
            <Checkbox
              checked={includeRemoved}
              onChange={(e) => setIncludeRemoved(e.target.checked)}
            >
              包含已移除历史
            </Checkbox>
          </div>
        </section>
      </div>
      <Drawer
        open={selectedId !== null}
        title={
          detail
            ? `${targetTypeLabels[detail.asset.targetType]} · ${detail.asset.title}`
            : '资产内容与评审'
        }
        width={1000}
        onClose={() => setSelectedId(null)}
        destroyOnHidden
      >
        {detailLoading && <Skeleton active />}
        {detailError && <Alert type="error" showIcon title={detailError} />}
        {detail && revision && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Tag>{kind}</Tag>
              <Tag>当前编辑 r{detail.asset.revisionNo}</Tag>
              <Tag>当前评审：{reviewLabels[detail.asset.reviewState]}</Tag>
              {detail.asset.removedAt && <Tag>已移除，历史保留</Tag>}
            </Space>
            <Select
              aria-label="资产修订历史"
              value={revision.id}
              onChange={setRevisionId}
              options={detail.revisions.map((item) => ({
                value: item.id,
                label: `r${item.revisionNo}${item.id === detail.asset.revisionId ? '（当前编辑）' : '（历史内容）'} · ${new Date(item.createdAt).toLocaleString('zh-CN')}`,
              }))}
            />
            {detail.asset.targetType === 'case' && (
              <>
                <Typography.Text>
                  最新可取得的已审快照：
                  {latestApproved
                    ? `r${latestApproved.snapshot.case.revisionNo} · ${latestApproved.approval.id}`
                    : '尚未取得'}
                </Typography.Text>
                {approvalError && (
                  <Alert type="info" title={approvalError} showIcon />
                )}
              </>
            )}
            {detail.asset.targetType !== 'set' && (
              <Alert
                type="info"
                showIcon
                title={`所属批次：${batches.find((item) => item.id === detail.asset.setId)?.title ?? detail.asset.setId}`}
                description={
                  <Space wrap>
                    <Button onClick={() => setSelectedId(detail.asset.setId)}>
                      查看整批意见
                    </Button>
                    {detail.asset.targetType === 'case' &&
                      detail.asset.parentId && (
                        <Button
                          onClick={() => setSelectedId(detail.asset.parentId)}
                        >
                          查看场景意见
                        </Button>
                      )}
                  </Space>
                }
              />
            )}
            <Card
              title={`正在查看 r${revision.revisionNo}：${revision.content.title}`}
              size="small"
            >
              <ContentView content={revision.content} />
            </Card>
            {tester && !detail.asset.removedAt && (
              <Space wrap>
                <Button
                  icon={<EditOutlined />}
                  onClick={() => edit(detail.asset)}
                >
                  编辑当前内容并建新修订
                </Button>
                {detail.asset.targetType !== 'case' && scope && (
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() =>
                      openEditor(
                        detail.asset.targetType === 'set' ? 'scenario' : 'case',
                        detail.asset,
                      )
                    }
                  >
                    新增{detail.asset.targetType === 'set' ? '场景' : '用例'}
                  </Button>
                )}
                <Button
                  loading={previewLoading}
                  onClick={() => void startPreview([detail.asset.id])}
                >
                  预览通过此对象
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(detail.asset)}
                >
                  显式移除
                </Button>
              </Space>
            )}
            <AssetReviewPanel
              key={`${detail.asset.id}:${revision.id}`}
              projectId={project.id}
              asset={detail.asset}
              revisionId={revision.id}
              tester={tester && !detail.asset.removedAt}
              onChanged={changed}
            />
          </Space>
        )}
      </Drawer>
      <AssetEditor
        userId={userId}
        projectId={project.id}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={saved}
      />
      <Modal
        title="人工批准 · 精确范围预览"
        open={preview !== null}
        width={1050}
        onCancel={() => {
          if (!committing) setPreview(null);
        }}
        closable={!committing}
        maskClosable={!committing}
        footer={
          <Space>
            <Button disabled={committing} onClick={() => setPreview(null)}>
              {receipt ? '关闭回执' : '取消'}
            </Button>
            {!receipt && (
              <Button
                type="primary"
                loading={committing}
                disabled={!preview?.items.some((item) => item.eligible)}
                onClick={() => void approve()}
              >
                确认批准预览中的精确对象
              </Button>
            )}
          </Space>
        }
        destroyOnHidden
      >
        <Typography.Paragraph>
          确认绑定下列
          ID、修订、基准和摘要，不重新扩大筛选。逐项冲突或上层阻塞会独立返回；没有可批准项时不能确认。
        </Typography.Paragraph>
        {commitError && (
          <Alert
            type="error"
            title={commitError}
            showIcon
            className="section-alert"
          />
        )}
        {preview && (
          <>
            <Typography.Paragraph type="secondary">
              预览 {preview.previewId} · scopeDigest {preview.scopeDigest}
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="id"
              pagination={{ pageSize: 20 }}
              dataSource={preview.items}
              columns={[
                {
                  title: '对象',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{item.title}</Typography.Text>
                      <Typography.Text code>{item.id}</Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '固定修订/基准',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text code>{item.revisionId}</Typography.Text>
                      <Typography.Text>
                        rowVersion {item.rowVersion}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '可批准性',
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={item.eligible ? 'green' : 'gold'}>
                        {item.eligible ? '可批准' : '将跳过'}
                      </Tag>
                      {item.reasons.map((reason) => (
                        <Typography.Text key={reason}>{reason}</Typography.Text>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: '实际回执',
                  render: (_, item) => {
                    const result = receipt?.results.find(
                      (row) => row.id === item.id,
                    );
                    return result ? (
                      <Space direction="vertical" size={0}>
                        <Tag
                          color={
                            result.status === 'approved'
                              ? 'green'
                              : result.status === 'conflict'
                                ? 'red'
                                : 'gold'
                          }
                        >
                          {
                            {
                              approved: '已批准',
                              conflict: '基准冲突',
                              skipped: '已跳过',
                            }[result.status]
                          }
                        </Tag>
                        {result.status === 'skipped' &&
                          result.reasons.map((reason) => (
                            <Typography.Text key={reason}>
                              {reason}
                            </Typography.Text>
                          ))}
                      </Space>
                    ) : (
                      '尚未提交'
                    );
                  },
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              批准提交标识：{commitCommand.current}
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </>
  );
}
