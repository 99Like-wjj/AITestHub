import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Tree,
} from 'antd';
import { z } from 'zod';
import {
  assetListSchema,
  assetDetailSchema,
  assetOperationStatusSchema,
  assetNavigationSchema,
  assetReceiptSchema,
  reviseAssetInputSchema,
} from '../../../packages/contracts/src/assets';
import type { Asset } from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { apiDraftFromContent, serializeApiDraft } from './api-draft';
import type { ApiDraft } from './api-draft';
import { ApiDiagnosticPage, ApiDraftDebugger } from './api-draft-debugger';
import type { DiagnosticDraft } from './api-draft-debugger';
import { AssetEditor } from './asset-editor';
import type { AssetEditorTarget } from './asset-editor';
import {
  AssetReviewPanel,
  reviewLabels,
  reviewTones,
} from './asset-review-panel';
import { useBusinessCommand } from './business-command';
import { AppIcon } from './app-icon';
import { PageHeading } from './page-heading';
import { registerNavigationBlocker } from './navigation-guard';
import { uiLayers } from './ui-layers';
import { ArchivedRequirementsToggle } from './archived-requirements-toggle';
import type { Project } from './types';

type Navigation = z.infer<typeof assetNavigationSchema>;
const hasRestoration = () => {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  return (
    idSchema.safeParse(query.get('debugRunId')).success ||
    idSchema.safeParse(query.get('debugCommandId')).success
  );
};

export function ApiWorkbenchPage({
  project,
  userId,
}: {
  project: Project | null;
  userId: string;
}) {
  const { message } = App.useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [active, setActive] = useState<Asset | null>(null);
  const [draft, setDraft] = useState<ApiDraft | null>(null);
  const [versionId, setVersionId] = useState<string>();
  const [batchId, setBatchId] = useState<string>();
  const [sceneId, setSceneId] = useState<string>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [includeArchivedRequirements, setIncludeArchivedRequirements] =
    useState(false);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const nextAction = useRef<(() => void) | null>(null);
  const preserveDraftOnLeave = useRef(false);
  const [editor, setEditor] = useState<AssetEditorTarget | null>(null);
  const [diagnostic, setDiagnostic] = useState<DiagnosticDraft | null>(null);
  const [lookup, setLookup] = useState(hasRestoration);
  const [review, setReview] = useState(false);
  const [revisionSession, setRevisionSession] = useState<string | null>(null);
  const command = useBusinessCommand(revisionSession);
  const recoveryKey = project
    ? `aitesthub:asset-save-receipt:v1:${userId}:${project.id}`
    : null;
  const recoverySchema = z.strictObject({
    commandId: idSchema,
    assetId: idSchema,
  });
  const [pendingReceipt, setPendingReceipt] = useState<z.infer<
    typeof recoverySchema
  > | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<string>();
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const resolvedCommands = useRef(new Set<string>());
  const epoch = useRef(0);
  const loadedProject = useRef<string | null | undefined>(undefined);
  const tester = project?.roles.includes('tester') ?? false;
  const scene = assets.find(
    (asset) => asset.id === sceneId && asset.targetType === 'scenario',
  );
  const currentRequirement = navigation.requirements.find((requirement) =>
    requirement.versions.some(
      (version) => version.id === (active?.requirementVersionId ?? versionId),
    ),
  );
  const sets = assets.filter(
    (asset) =>
      asset.targetType === 'set' &&
      (!versionId || asset.requirementVersionId === versionId),
  );
  const visibleVersion = navigation.requirements.some((requirement) =>
    requirement.versions.some((version) => version.id === versionId),
  );

  function activate(asset: Asset | null) {
    setActive(asset);
    setDraft(
      asset && 'dslVersion' in asset.content
        ? apiDraftFromContent(asset.content)
        : null,
    );
    setDirty(false);
    setReview(false);
    setRevisionSession(
      asset
        ? `${project?.id}:${asset.id}:${asset.revisionId}:${crypto.randomUUID()}`
        : null,
    );
    if (asset) {
      setVersionId(asset.requirementVersionId);
      setBatchId(asset.setId);
      setSceneId(asset.parentId ?? undefined);
    }
  }
  function guard(action: () => void, preserveDraft = false) {
    if (command.pending) return;
    if (dirty || command.uncertain) {
      nextAction.current = action;
      preserveDraftOnLeave.current = preserveDraft;
      setLeave(true);
    } else action();
  }
  async function load(signal?: AbortSignal, initialize = false) {
    if (!project) return;
    const generation = ++epoch.current;
    setLoading(true);
    try {
      const [map, list] = await Promise.all([
        api(
          `/projects/${project.id}/assets/navigation?kind=API&includeArchivedRequirements=${includeArchivedRequirements}`,
          signal ? { signal } : {},
          assetNavigationSchema,
        ),
        api(
          `/projects/${project.id}/assets?kind=API&includeArchivedRequirements=${includeArchivedRequirements}`,
          signal ? { signal } : {},
          assetListSchema,
        ),
      ]);
      if (signal?.aborted || generation !== epoch.current) return;
      setNavigation(map);
      setAssets(list.assets);
      setError(undefined);
      if (initialize) {
        const selected = idSchema.safeParse(
          new URLSearchParams(window.location.hash.split('?')[1]).get('caseId'),
        );
        let selectedAsset =
          list.assets.find(
            (asset) =>
              asset.targetType === 'case' &&
              (!selected.success || asset.id === selected.data),
          ) ?? null;
        if (selected.success && !selectedAsset) {
          const historical = await api(
            `/projects/${project.id}/assets/${selected.data}`,
            signal ? { signal } : {},
            assetDetailSchema,
          );
          if (signal?.aborted || generation !== epoch.current) return;
          if (
            historical.asset.kind !== 'API' ||
            historical.asset.targetType !== 'case'
          )
            throw new Error('此历史链接不是接口用例。');
          selectedAsset = historical.asset;
        }
        activate(selectedAsset);
        loadedProject.current = project.id;
      }
    } catch (failure) {
      if (!signal?.aborted && generation === epoch.current)
        setError(describeError(failure));
    } finally {
      if (!signal?.aborted && generation === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const initialize = loadedProject.current !== project?.id;
    setAssets([]);
    setNavigation({ requirements: [] });
    if (initialize) activate(null);
    void load(controller.signal, initialize);
    return () => controller.abort();
  }, [project?.id, includeArchivedRequirements]);
  useEffect(() => {
    setPendingReceipt(null);
    setRecoveryStatus(undefined);
    setRecoveryFailed(false);
    if (!recoveryKey) return;
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const parsed = recoverySchema.safeParse(JSON.parse(raw));
        if (parsed.success) setPendingReceipt(parsed.data);
      }
    } catch {
      setRecoveryStatus(
        '浏览器无法读取原保存标识，请保留上次记录的 commandId。',
      );
    }
  }, [recoveryKey]);
  useEffect(() => {
    if (
      !command.uncertain ||
      !active ||
      !recoveryKey ||
      resolvedCommands.current.has(command.commandId)
    )
      return;
    const record = { commandId: command.commandId, assetId: active.id };
    setPendingReceipt(record);
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(record));
    } catch {
      setRecoveryStatus(
        '浏览器无法保留原保存标识，请抄下当前 commandId 后再离开。',
      );
    }
  }, [command.uncertain, command.commandId, active?.id, recoveryKey]);
  useEffect(() => {
    if (!dirty && !command.pending && !command.uncertain) return;
    return registerNavigationBlocker((action) => guard(action));
  }, [dirty, command.pending, command.uncertain]);
  useEffect(() => {
    if (!dirty && !command.uncertain) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, command.uncertain]);
  useEffect(() => {
    function update() {
      if (hasRestoration()) setLookup(true);
    }
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  async function saved(asset: Asset) {
    await load();
    activate(asset);
    setEditor(null);
  }
  async function save() {
    if (!project || !active || !draft || !tester || pendingReceipt)
      return false;
    const response = await command.run((commandId) =>
      api(
        `/projects/${project.id}/assets/${active.id}`,
        {
          method: 'PUT',
          body: reviseAssetInputSchema.parse({
            commandId,
            baseRevisionId: active.revisionId,
            rowVersion: active.rowVersion,
            content: serializeApiDraft(draft),
          }),
        },
        assetReceiptSchema,
      ),
    );
    if (!response) return false;
    await saved(response.asset);
    void message.success('已保存新修订，等待人工评审。');
    return true;
  }
  function clearRecovery() {
    if (pendingReceipt) resolvedCommands.current.add(pendingReceipt.commandId);
    if (recoveryKey)
      try {
        localStorage.removeItem(recoveryKey);
      } catch {
        /* An acknowledged receipt is still shown in the current page. */
      }
    setPendingReceipt(null);
    setRecoveryFailed(false);
    command.confirmRecoveredReceipt();
  }
  async function recoverSave() {
    if (!project || !pendingReceipt || recovering) return;
    setRecovering(true);
    setRecoveryStatus(undefined);
    try {
      const result = await api(
        `/projects/${project.id}/assets/receipts/${pendingReceipt.commandId}?operation=assets.revise`,
        {},
        assetOperationStatusSchema,
      );
      if (
        result.commandId !== pendingReceipt.commandId ||
        result.operation !== 'assets.revise'
      )
        throw Error('原回执标识或操作不一致，保持禁重发。');
      if (result.status === 'completed' && result.response) {
        if (result.response.asset.id !== pendingReceipt.assetId)
          throw Error('原回执目标不一致，保持禁重发。');
        clearRecovery();
        activate(result.response.asset);
        await load();
        setRecoveryStatus('原保存已确认完成，已读取当时回执修订。');
      } else if (result.status === 'failed') {
        setRecoveryFailed(true);
        setRecoveryStatus('原保存已确认失败，未以当前对象状态推断成功。');
      } else
        setRecoveryStatus(
          result.status === 'pending'
            ? '原保存仍在处理，保持原标识稍后只读查询。'
            : '原保存仍未知，保持禁重发。',
        );
    } catch (failure) {
      setRecoveryStatus(
        `${describeError(failure)} 404仅表示当前未查到，不表示未受理。`,
      );
    } finally {
      setRecovering(false);
    }
  }
  function prepareDiagnostic() {
    if (!draft || !active) return;
    try {
      setDiagnostic({
        content: serializeApiDraft(draft),
        sourceCaseId: active.id,
        sourceCaseRevisionId: active.revisionId,
      });
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof z.ZodError
          ? failure.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('；')
          : describeError(failure),
      );
    }
  }
  function create(targetType: 'set' | 'scenario' | 'case') {
    if (
      !versionId ||
      !visibleVersion ||
      (targetType !== 'set' && !batchId) ||
      (targetType === 'case' && !scene)
    )
      return;
    guard(() =>
      setEditor({
        targetType,
        kind: 'API',
        requirementVersionId: versionId,
        setId: batchId ?? null,
        scenarioId: targetType === 'case' ? (sceneId ?? null) : null,
        asset: null,
      }),
    );
  }
  const keyword = query.trim().toLocaleLowerCase();
  if (!project)
    return <Empty description="请选择当前有效项目后维护接口用例。" />;
  return (
    <>
      <PageHeading
        eyebrow="API REGRESSION"
        title="接口回归工作台"
        description="按独立接口场景组织可维护用例，请求步骤保留在用例内部。"
        actions={
          <>
            <Button
              icon={<AppIcon name="spark" />}
              disabled={!tester}
              onClick={() =>
                guard(() => {
                  window.location.hash = 'workspace';
                })
              }
            >
              生成选定范围
            </Button>
            <Button
              type="primary"
              icon={<AppIcon name="plus" />}
              disabled={!tester || !scene}
              onClick={() => create('case')}
            >
              新建接口用例
            </Button>
          </>
        }
      />
      {error && (
        <Alert type="error" title={error} showIcon className="section-alert" />
      )}
      {pendingReceipt && (
        <Alert
          className="section-alert"
          type="warning"
          showIcon
          title={`有一笔原保存回执待核对：${pendingReceipt.commandId}`}
          description={
            <Space direction="vertical">
              <span>
                只在本浏览器保存本人/项目/对象的标识，不保存正文或凭据；找回前禁用新的用例保存。
              </span>
              <Space>
                <Button loading={recovering} onClick={() => void recoverSave()}>
                  查询原保存回执
                </Button>
                {recoveryFailed && (
                  <Button
                    onClick={() => {
                      clearRecovery();
                      setRevisionSession(crypto.randomUUID());
                      setRecoveryStatus(
                        '已知失败已记录，原草稿保留；再次保存需要明确操作。',
                      );
                    }}
                  >
                    已知失败，继续编辑
                  </Button>
                )}
              </Space>
            </Space>
          }
        />
      )}
      {recoveryStatus && (
        <p className="caption mb" role="status">
          {recoveryStatus}
        </p>
      )}
      <div className="asset-workspace live-asset-workspace api-workbench">
        <aside className="asset-tree">
          <div className="tree-head">接口回归 · 需求 / 场景 / 用例</div>
          <div className="tree-search">
            <ArchivedRequirementsToggle
              checked={includeArchivedRequirements}
              disabled={command.pending}
              onChange={(value) =>
                guard(() => {
                  epoch.current += 1;
                  setLoading(true);
                  setIncludeArchivedRequirements(value);
                }, true)
              }
            />
          </div>
          <div className="tree-search">
            <Input
              aria-label="搜索接口资产"
              placeholder="搜索需求或用例"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              allowClear
            />
          </div>
          {loading && !assets.length ? (
            <Skeleton active />
          ) : (
            <Tree
              blockNode
              defaultExpandAll
              selectedKeys={
                active
                  ? [`case:${active.id}`]
                  : sceneId
                    ? [`scenario:${sceneId}`]
                    : []
              }
              onSelect={([key]) => {
                if (typeof key !== 'string') return;
                const [type, id] = key.split(':');
                if (type === 'requirement') {
                  const requirement = navigation.requirements.find(
                    (item) => item.id === id,
                  );
                  guard(() => {
                    activate(null);
                    setVersionId(
                      requirement
                        ? [...requirement.versions].sort(
                            (a, b) => b.versionNo - a.versionNo,
                          )[0]?.id
                        : undefined,
                    );
                    setBatchId(undefined);
                    setSceneId(undefined);
                  });
                } else {
                  const asset = assets.find((item) => item.id === id);
                  if (asset)
                    guard(() => {
                      if (type === 'case') activate(asset);
                      else {
                        activate(null);
                        setVersionId(asset.requirementVersionId);
                        setBatchId(asset.setId);
                        setSceneId(asset.id);
                      }
                    });
                }
              }}
              treeData={navigation.requirements.map((requirement) => ({
                key: `requirement:${requirement.id}`,
                title: (
                  <span>
                    {requirement.title}
                    {requirement.archived ? '（已归档）' : ''}
                    <span className="caption"> · {requirement.caseCount}</span>
                  </span>
                ),
                children: assets
                  .filter(
                    (asset) =>
                      asset.targetType === 'scenario' &&
                      requirement.versions.some(
                        (version) => version.id === asset.requirementVersionId,
                      ),
                  )
                  .filter(
                    (asset) =>
                      !keyword ||
                      `${requirement.title} ${asset.title}`
                        .toLocaleLowerCase()
                        .includes(keyword) ||
                      assets.some(
                        (child) =>
                          child.parentId === asset.id &&
                          child.title.toLocaleLowerCase().includes(keyword),
                      ),
                  )
                  .map((scenario) => ({
                    key: `scenario:${scenario.id}`,
                    title: scenario.title,
                    children: assets
                      .filter(
                        (asset) =>
                          asset.targetType === 'case' &&
                          asset.parentId === scenario.id &&
                          (!keyword ||
                            `${requirement.title} ${scenario.title} ${asset.title}`
                              .toLocaleLowerCase()
                              .includes(keyword)),
                      )
                      .map((asset) => ({
                        key: `case:${asset.id}`,
                        title: asset.title,
                        isLeaf: true,
                      })),
                  })),
              }))}
            />
          )}
          <div className="api-scope-tools mt">
            <div className="context-controls api-scope-controls">
              <Select
                aria-label="接口需求版本"
                placeholder="选择明确需求版本"
                value={visibleVersion ? versionId : undefined}
                onChange={(id) =>
                  guard(() => {
                    activate(null);
                    setVersionId(id);
                    setBatchId(undefined);
                    setSceneId(undefined);
                  })
                }
                style={{ width: 220 }}
                options={navigation.requirements.flatMap((requirement) =>
                  requirement.versions.map((version) => ({
                    value: version.id,
                    label: `${requirement.title} · v${version.versionNo}`,
                  })),
                )}
              />
              <Select
                aria-label="接口生成批次"
                placeholder="选择批次"
                value={
                  sets.some((set) => set.id === batchId) ? batchId : undefined
                }
                onChange={(id) =>
                  guard(() => {
                    activate(null);
                    setBatchId(id);
                    setSceneId(undefined);
                  })
                }
                style={{ width: 165 }}
                options={sets.map((set) => ({
                  value: set.id,
                  label: set.title,
                }))}
              />
              {tester && (
                <>
                  <Button
                    size="small"
                    disabled={!versionId || !visibleVersion}
                    onClick={() => create('set')}
                  >
                    新建批次
                  </Button>
                  <Button
                    size="small"
                    disabled={!versionId || !visibleVersion || !batchId}
                    onClick={() => create('scenario')}
                  >
                    新增场景
                  </Button>
                </>
              )}
            </div>
            <Button size="small" loading={loading} onClick={() => void load()}>
              刷新目录
            </Button>
          </div>
        </aside>
        <section className="asset-pane">
          {!loading && !error && active && !currentRequirement && (
            <Alert
              type="info"
              showIcon
              className="section-alert"
              title="当前历史用例不在本次需求浏览范围"
              description="原详情、草稿与保存回执仍保留。可开启“显示已归档需求”找回目录；归档浏览开关不会撤销访问权限或重新提交保存。"
            />
          )}
          {active && draft ? (
            <div className="card api-editor-card">
              <div className="case-editor-head">
                <div className="between">
                  <div>
                    <h2>{draft.base.title}</h2>
                    <p>
                      {currentRequirement?.title ?? '原需求'} /{' '}
                      {assets.find((asset) => asset.id === active.parentId)
                        ?.title ?? '原场景'}{' '}
                      · {active.id}
                    </p>
                  </div>
                  <div className="row">
                    <Button
                      icon={<AppIcon name="check" />}
                      disabled={
                        !tester ||
                        !dirty ||
                        command.uncertain ||
                        Boolean(pendingReceipt)
                      }
                      loading={command.pending}
                      onClick={() => void save()}
                    >
                      保存修改
                    </Button>
                    <Button
                      type="primary"
                      icon={<AppIcon name="play" />}
                      disabled={
                        !tester ||
                        command.pending ||
                        command.uncertain ||
                        Boolean(pendingReceipt)
                      }
                      onClick={prepareDiagnostic}
                    >
                      调试
                    </Button>
                  </div>
                </div>
                <div className="row wrap mt">
                  <span className={`badge ${reviewTones[active.reviewState]}`}>
                    {reviewLabels[active.reviewState]}
                  </span>
                  <span className="caption">
                    编辑 r{active.revisionNo} · {draft.requests.length} 个请求
                  </span>
                  {dirty && <span className="badge amber">未保存</span>}
                </div>
              </div>
              {command.error && (
                <Alert
                  className="section-alert"
                  type="error"
                  title={command.error}
                  showIcon
                />
              )}
              {command.uncertain && (
                <Alert
                  className="section-alert"
                  type="warning"
                  title={`保存回执未知：${command.commandId}`}
                  description="已禁重发。保留当前输入与原提交标识；刷新目录不能证明原操作未受理。"
                  showIcon
                />
              )}
              <ApiCaseFields
                projectId={project.id}
                value={draft}
                disabled={
                  !tester ||
                  command.pending ||
                  command.uncertain ||
                  Boolean(pendingReceipt)
                }
                presentation="workbench"
                onChange={(value) => {
                  setDraft(value);
                  setDirty(true);
                }}
                documentation={
                  <div className="api-documentation-fields">
                    <label className="field-label">
                      标题
                      <Input
                        value={draft.base.title}
                        disabled={
                          !tester ||
                          command.pending ||
                          command.uncertain ||
                          Boolean(pendingReceipt)
                        }
                        maxLength={200}
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            base: { ...draft.base, title: event.target.value },
                          });
                          setDirty(true);
                        }}
                      />
                    </label>
                    {(['testPoint', 'expected'] as const).map((field) => (
                      <label className="field-label" key={field}>
                        {field === 'testPoint' ? '测试点' : '业务预期'}
                        <Input.TextArea
                          value={draft.base[field]}
                          rows={3}
                          disabled={
                            !tester ||
                            command.pending ||
                            command.uncertain ||
                            Boolean(pendingReceipt)
                          }
                          onChange={(event) => {
                            setDraft({
                              ...draft,
                              base: {
                                ...draft.base,
                                [field]: event.target.value,
                              },
                            });
                            setDirty(true);
                          }}
                        />
                      </label>
                    ))}
                    <label className="field-label">
                      用例前提（每行一项）
                      <Input.TextArea
                        rows={3}
                        value={draft.base.preconditions.join('\n')}
                        disabled={
                          !tester ||
                          command.pending ||
                          command.uncertain ||
                          Boolean(pendingReceipt)
                        }
                        onChange={(event) => {
                          setDraft({
                            ...draft,
                            base: {
                              ...draft.base,
                              preconditions: event.target.value.split('\n'),
                            },
                          });
                          setDirty(true);
                        }}
                      />
                    </label>
                    <p className="caption">
                      依据引用随原内容保留：
                      {draft.base.basisRefs
                        .map((basis) => basis.description)
                        .join('；') || '未登记'}
                    </p>
                  </div>
                }
              />
              <div className="api-editor-footer between">
                <p className="caption">
                  调试不等于评审通过。未审修改不会覆盖原有效已审版本。
                </p>
                <Button
                  icon={<AppIcon name="check" />}
                  disabled={dirty || command.pending || command.uncertain}
                  onClick={() => setReview(true)}
                >
                  内容评审
                </Button>
              </div>
            </div>
          ) : (
            <div className="card pad">
              <Empty
                description={
                  loading
                    ? '正在读取接口用例…'
                    : scene
                      ? `已选择场景「${scene.title}」，可新建接口用例。`
                      : '选择接口用例进行维护，或先选择需求版本、批次和场景。'
                }
              />
            </div>
          )}
          <Collapse
            className="mt"
            activeKey={lookup ? ['lookup'] : []}
            onChange={(keys) =>
              setLookup(Array.isArray(keys) && keys.includes('lookup'))
            }
            items={[
              {
                key: 'lookup',
                label: '原诊断找回（只读，不重发）',
                children: <ApiDiagnosticPage project={project} />,
              },
            ]}
          />
        </section>
      </div>
      <AssetEditor
        userId={userId}
        projectId={project.id}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={saved}
      />
      <ApiDraftDebugger
        projectId={project.id}
        draft={diagnostic}
        onClose={() => setDiagnostic(null)}
      />
      <Modal
        title="用例有未保存修改"
        open={leave}
        zIndex={uiLayers.confirmation}
        onCancel={() => setLeave(false)}
        footer={
          <Space>
            <Button onClick={() => setLeave(false)}>继续编辑</Button>
            <Button
              danger={!preserveDraftOnLeave.current}
              onClick={() => {
                setLeave(false);
                if (!preserveDraftOnLeave.current) {
                  setDirty(false);
                  if (active && 'dslVersion' in active.content)
                    setDraft(apiDraftFromContent(active.content));
                }
                const action = nextAction.current;
                nextAction.current = null;
                action?.();
              }}
            >
              {preserveDraftOnLeave.current ? '保留草稿并切换' : '放弃修改'}
            </Button>
            <Button
              type="primary"
              disabled={command.uncertain}
              loading={command.pending}
              onClick={() =>
                void save().then((success) => {
                  if (success) {
                    setLeave(false);
                    const action = nextAction.current;
                    nextAction.current = null;
                    action?.();
                  }
                })
              }
            >
              保存并继续
            </Button>
          </Space>
        }
      >
        <p>
          {preserveDraftOnLeave.current
            ? '此操作只切换需求目录的浏览范围，当前草稿与原保存标识保留，不会重新提交。'
            : '保存按当前修订提交；放弃只丢弃本次未保存输入。'}
          {command.uncertain
            ? `原回执仍未知，请保留提交标识 ${command.commandId}。`
            : ''}
        </p>
      </Modal>
      <Modal
        width={1030}
        title="接口用例评审"
        open={review}
        onCancel={() => setReview(false)}
        footer={null}
        zIndex={uiLayers.detail}
      >
        {active && (
          <AssetReviewPanel
            projectId={project.id}
            asset={active}
            revisionId={active.revisionId}
            tester={tester}
            onChanged={async () => {
              await load();
            }}
          />
        )}
      </Modal>
    </>
  );
}
