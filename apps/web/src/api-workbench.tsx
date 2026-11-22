import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
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
import {
  apiRegressionQualificationListSchema,
  debugHistorySchema,
  apiRegressionQualificationSchema,
  apiRegressionWithdrawReceiptSchema,
} from '../../../packages/contracts/src/api-execution';
import type { Asset } from '../../../packages/contracts/src/assets';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError } from './api';
import { ApiCaseFields } from './api-case-fields';
import { ApiCaseComposition } from './api-case-composition';
import { ApiScopedCaseEditor } from './api-scoped-case-editor';
import { ApiCoverage } from './api-coverage';
import { ApiDefinitionLibrary } from './api-definition-library';
import { apiDraftFromContent, serializeApiDraft } from './api-draft';
import type { ApiDraft } from './api-draft';
import {
  ApiDiagnosticPage,
  ApiDraftDebugger,
  readDiagnosticRestoration,
} from './api-draft-debugger';
import type {
  DiagnosticDraft,
  DiagnosticRestoration,
} from './api-draft-debugger';
import type { ResponseRule } from './api-attempt-evidence';
import { AssetEditor } from './asset-editor';
import type { AssetEditorTarget } from './asset-editor';
import { useBusinessCommand } from './business-command';
import { AppIcon } from './app-icon';
import { formatBeijingTime } from './beijing-time';
import { StandaloneWorkbenchHeader } from './standalone-workbench-header';
import './api-workbench.css';
import { StatusTag } from './semantic-status';
import { registerNavigationBlocker } from './navigation-guard';
import { uiLayers } from './ui-layers';
import {
  RequirementDirectory,
  RequirementDirectoryLabel,
} from './requirement-directory';
import type { Project } from './types';

type Navigation = z.infer<typeof assetNavigationSchema>;
type Qualification = z.infer<typeof apiRegressionQualificationSchema>;
const apiQuery = () => new URLSearchParams(window.location.hash.split('?')[1]);
const isDraftRoute = () => apiQuery().get('draft') === 'new-api-case';
const routeCaseId = () => {
  const result = idSchema.safeParse(apiQuery().get('caseId'));
  return result.success ? result.data : undefined;
};
const caseRestoration = () =>
  routeCaseId() ? readDiagnosticRestoration() : null;

export function ApiWorkbenchPage({
  project,
  userId,
  onNavigate,
}: {
  project: Project | null;
  userId: string;
  onNavigate: (hash: string) => void;
}) {
  const { message, modal } = App.useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [active, setActive] = useState<Asset | null>(null);
  const [draft, setDraft] = useState<ApiDraft | null>(null);
  const [versionId, setVersionId] = useState<string>();
  const [batchId, setBatchId] = useState<string>();
  const [sceneId, setSceneId] = useState<string>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const [caseSearch, setCaseSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [includeArchivedRequirements, setIncludeArchivedRequirements] =
    useState(false);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const nextAction = useRef<(() => void) | null>(null);
  const preserveDraftOnLeave = useRef(false);
  const libraryHash = useRef<string | undefined>(undefined);
  const libraryScroll = useRef(0);
  const [routedCase, setRoutedCase] = useState(routeCaseId);
  const [editor, setEditor] = useState<AssetEditorTarget | null>(null);
  const [createCaseOpen, setCreateCaseOpen] = useState(false);
  const [createCaseStaged, setCreateCaseStaged] = useState(false);
  const [caseSettingsOpen, setCaseSettingsOpen] = useState(false);
  const [environmentHost, setEnvironmentHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [diagnostic, setDiagnostic] = useState<DiagnosticDraft | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [restoration, setRestoration] = useState(caseRestoration);
  const [diagnosticLookup, setDiagnosticLookup] = useState<{
    kind: DiagnosticRestoration['kind'];
    id: string;
    error?: string;
  }>();
  const [history, setHistory] =
    useState<z.infer<typeof debugHistorySchema>['rounds']>();
  const [historyError, setHistoryError] = useState<string>();
  const lookupOpen = Boolean(diagnosticLookup);
  useEffect(() => {
    if (!lookupOpen || !active || !project) return;
    const controller = new AbortController();
    setHistory(undefined);
    setHistoryError(undefined);
    void api(
      '/projects/' +
        project.id +
        '/api-executions/debug-history?caseId=' +
        active.id,
      { signal: controller.signal },
      debugHistorySchema,
    )
      .then((reply) => {
        if (!controller.signal.aborted) setHistory(reply.rounds);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setHistoryError(describeError(failure));
      });
    return () => controller.abort();
  }, [lookupOpen, active?.id, project?.id]);
  const [ruleFocus, setRuleFocus] = useState<{
    stepId: string;
    tab: 'parameters' | 'assertions' | 'extractors';
    nonce: string;
  }>();

  const [previewEnvironmentId, setPreviewEnvironmentId] = useState<string>();
  const [lookup, setLookup] = useState(
    () => readDiagnosticRestoration() !== null && !routeCaseId(),
  );
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [caseView, setCaseView] = useState<
    'cases' | 'pending' | 'coverage' | 'definitions'
  >('cases');
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
  const directoryRequirement = navigation.requirements.find((item) =>
    item.versions.some((version) => version.id === versionId),
  );
  const directoryVersion = directoryRequirement?.versions.find(
    (version) => version.id === versionId,
  );
  const visibleVersion = Boolean(directoryVersion);

  function activate(asset: Asset | null, deriveScope = false) {
    setActive(asset);
    setDraft(
      asset && 'dslVersion' in asset.content
        ? apiDraftFromContent(asset.content)
        : null,
    );
    setDirty(false);
    setRevisionSession(
      asset
        ? `${project?.id}:${asset.id}:${asset.revisionId}:${crypto.randomUUID()}`
        : null,
    );
    if (asset && deriveScope) {
      setVersionId(asset.requirementVersionId);
      setBatchId(asset.setId);
      setSceneId(asset.parentId ?? undefined);
    }
  }
  function guard(action: () => void, preserveDraft = false) {
    if (command.pending || diagnosticBusy) return;
    if (dirty || command.uncertain) {
      nextAction.current = action;
      preserveDraftOnLeave.current = preserveDraft;
      setLeave(true);
    } else action();
  }
  function caseHash(caseId: string, original?: DiagnosticRestoration | null) {
    const query = new URLSearchParams({
      projectId: project?.id ?? '',
      caseId,
      view: 'workbench',
    });
    if (versionId) query.set('versionId', versionId);
    if (original)
      query.set(
        original.kind === 'run' ? 'debugRunId' : 'debugCommandId',
        original.id,
      );
    return '#api-regression?' + query.toString();
  }
  function stageNewCase(draftRouteId: string) {
    if (!project) return;
    const source = new URLSearchParams({ projectId: project.id });
    if (versionId) source.set('versionId', versionId);
    if (sceneId) source.set('assetId', sceneId);
    libraryHash.current = '#api-regression?' + source.toString();
    libraryScroll.current = window.scrollY;
    activate(null);
    setCreateCaseStaged(true);
    setRoutedCase(draftRouteId);
    onNavigate(caseHash(draftRouteId) + '&draft=new-api-case');
    window.requestAnimationFrame(() => window.scrollTo(0, 0));
  }
  function closeNewCase() {
    const leaveDraftRoute = createCaseStaged || isDraftRoute();
    setCreateCaseOpen(false);
    setCreateCaseStaged(false);
    if (!leaveDraftRoute) return;
    setRoutedCase(undefined);
    const url =
      libraryHash.current ?? '#api-regression?projectId=' + (project?.id ?? '');
    onNavigate(url);
    restoreLibraryPosition();
  }
  function openCase(asset: Asset) {
    if (!project) return;
    if (!active) {
      libraryScroll.current = window.scrollY;
      const source = new URLSearchParams({ projectId: project.id });
      if (versionId) source.set('versionId', versionId);
      if (sceneId) source.set('assetId', sceneId);
      libraryHash.current = '#api-regression?' + source.toString();
    }
    setDiagnostic(null);
    setRestoration(null);
    setRuleFocus(undefined);
    setRoutedCase(asset.id);
    activate(asset);
    onNavigate(caseHash(asset.id));
    window.requestAnimationFrame(() => window.scrollTo(0, 0));
  }
  function restoreLibraryPosition() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!routeCaseId()) window.scrollTo(0, libraryScroll.current);
      });
    });
  }
  function backToLibrary() {
    guard(() => {
      const source = new URLSearchParams({ projectId: project?.id ?? '' });
      if (versionId) source.set('versionId', versionId);
      const hash =
        libraryHash.current ?? '#api-regression?' + source.toString();
      activate(null);
      setDiagnostic(null);
      setRestoration(null);
      setRuleFocus(undefined);
      setRoutedCase(undefined);
      onNavigate(hash);
      restoreLibraryPosition();
    });
  }
  function setDirectoryScope(nextVersion?: string) {
    setVersionId(nextVersion);
    setBatchId(undefined);
    setSceneId(undefined);
  }
  function changeArchiveScope(value: boolean) {
    guard(() => {
      epoch.current += 1;
      setLoading(true);
      if (!value && directoryRequirement?.archived) setDirectoryScope();
      setIncludeArchivedRequirements(value);
    }, true);
  }
  async function load(signal?: AbortSignal, initialize = false) {
    if (!project) return false;
    const generation = ++epoch.current;
    setLoading(true);
    try {
      const [map, list, available] = await Promise.all([
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
        api(
          `/projects/${project.id}/api-executions/regression-qualifications`,
          signal ? { signal } : {},
          apiRegressionQualificationListSchema,
        ),
      ]);
      if (signal?.aborted || generation !== epoch.current) return false;
      setNavigation(map);
      setAssets(list.assets);
      setQualifications(available.qualifications);
      if (initialize)
        setExpandedKeys(
          map.requirements.map((item) => `requirement:${item.id}`),
        );
      setError(undefined);
      if (initialize && !isDraftRoute()) {
        const query = new URLSearchParams(window.location.hash.split('?')[1]);
        const targetId = idSchema.safeParse(
          query.get('caseId') ?? query.get('assetId'),
        );
        const selected = idSchema.safeParse(query.get('caseId'));
        let selectedAsset = selected.success
          ? (list.assets.find(
              (asset) =>
                asset.targetType === 'case' && asset.id === selected.data,
            ) ?? null)
          : null;
        if (selected.success && !selectedAsset) {
          const historical = await api(
            `/projects/${project.id}/assets/${selected.data}`,
            signal ? { signal } : {},
            assetDetailSchema,
          );
          if (signal?.aborted || generation !== epoch.current) return false;
          if (
            historical.asset.kind !== 'API' ||
            historical.asset.targetType !== 'case'
          )
            throw new Error('此历史链接不是接口用例。');
          selectedAsset = historical.asset;
        }
        activate(selectedAsset, true);
        if (selectedAsset) {
          setRoutedCase(selectedAsset.id);
          if (
            query.get('view') !== 'workbench' ||
            query.get('projectId') !== project.id
          ) {
            onNavigate(caseHash(selectedAsset.id, caseRestoration()));
          }
        }
        const versionFilter = idSchema.safeParse(query.get('versionId'));
        if (
          !selectedAsset &&
          versionFilter.success &&
          map.requirements.some((entry) =>
            entry.versions.some((version) => version.id === versionFilter.data),
          )
        )
          setVersionId(versionFilter.data);
        if (!selectedAsset && targetId.success) {
          const target = list.assets.find(
            (asset) => asset.id === targetId.data,
          );
          if (target?.targetType === 'case') {
            setRoutedCase(target.id);
            activate(target, true);
            onNavigate(caseHash(target.id));
          } else if (
            target?.targetType === 'scenario' ||
            target?.targetType === 'set'
          ) {
            setVersionId(target.requirementVersionId);
            setBatchId(target.setId);
            setSceneId(
              target.targetType === 'scenario' ? target.id : undefined,
            );
          }
        }
      }
      if (initialize) loadedProject.current = project.id;
      return true;
    } catch (failure) {
      if (!signal?.aborted && generation === epoch.current)
        setError(describeError(failure));
      return false;
    } finally {
      if (!signal?.aborted && generation === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const initialize = loadedProject.current !== project?.id;
    setAssets([]);
    setQualifications([]);
    setNavigation({ requirements: [] });
    if (initialize) {
      activate(null);
      libraryHash.current = undefined;
      setRoutedCase(routeCaseId());
    }
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
    if (!dirty && !command.pending && !command.uncertain && !diagnosticBusy)
      return;
    return registerNavigationBlocker((action) => guard(action));
  }, [dirty, command.pending, command.uncertain, diagnosticBusy]);
  useEffect(() => {
    if (!dirty && !command.uncertain) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, command.uncertain]);
  useEffect(() => {
    function update() {
      if (readDiagnosticRestoration() !== null && !routeCaseId())
        setLookup(true);
      const requested = routeCaseId();
      const next = caseRestoration();
      setRestoration((current) =>
        current?.id === next?.id && current?.kind === next?.kind
          ? current
          : next,
      );
      setRoutedCase(requested);
      if (isDraftRoute()) return;
      if (createCaseStaged) {
        setCreateCaseOpen(false);
        setCreateCaseStaged(false);
      }
      if (requested === active?.id) return;
      setDiagnostic(null);
      if (!requested) {
        if (active) {
          activate(null);
          restoreLibraryPosition();
        }
        return;
      }
      const asset = assets.find(
        (item) => item.id === requested && item.targetType === 'case',
      );
      if (asset) activate(asset);
      else void load(undefined, true);
    }
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [assets, active?.id, project?.id, createCaseStaged]);
  async function saved(asset: Asset) {
    const generation = epoch.current + 1;
    const refreshed = await load();
    if (generation !== epoch.current) return;
    if (!refreshed) {
      setAssets((current) => [
        ...current.filter((item) => item.id !== asset.id),
        asset,
      ]);
      setError(
        '内容已保存，但目录未能更新。请刷新目录核对；无需再次创建或保存。',
      );
    }
    if (asset.targetType === 'case') {
      if (active?.id === asset.id) activate(asset);
      else openCase(asset);
    } else {
      activate(null);
      setVersionId(asset.requirementVersionId);
      setBatchId(asset.targetType === 'set' ? asset.id : asset.setId);
      setSceneId(asset.targetType === 'scenario' ? asset.id : undefined);
    }
    const requirement = navigation.requirements.find((item) =>
      item.versions.some(
        (version) => version.id === asset.requirementVersionId,
      ),
    );
    const keys = [
      requirement ? `requirement:${requirement.id}` : null,
      asset.targetType === 'scenario'
        ? `scenario:${asset.id}`
        : asset.parentId
          ? `scenario:${asset.parentId}`
          : null,
    ].filter((key): key is string => key !== null);
    setExpandedKeys((current) => [...new Set([...current, ...keys])]);
    setEditor(null);
  }
  async function save() {
    if (
      !project ||
      !active ||
      !draft ||
      !tester ||
      pendingReceipt ||
      diagnosticBusy
    )
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
    void message.success('已保存草稿修订。完整调试通过后可保存为可回归。');
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
  function prepareDiagnostic(stepId?: string) {
    if (
      !draft ||
      !active ||
      !tester ||
      active.removedAt ||
      command.pending ||
      command.uncertain ||
      pendingReceipt ||
      diagnosticBusy
    )
      return;
    try {
      setRestoration(null);
      if (caseRestoration()) onNavigate(caseHash(active.id));
      setDiagnostic({
        content: serializeApiDraft(draft),
        sourceCaseId: active.id,
        sourceCaseRevisionId: active.revisionId,
        sourceCaseRowVersion: active.rowVersion,
        ...(stepId ? { stepId } : {}),
        ...(previewEnvironmentId ? { previewEnvironmentId } : {}),
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
  function openOriginalDiagnostic() {
    if (!diagnosticLookup || !active || diagnosticBusy) return;
    const id = idSchema.safeParse(diagnosticLookup.id.trim());
    if (!id.success) {
      setDiagnosticLookup({
        ...diagnosticLookup,
        error: '请输入有效的原调试轮次 ID 或原命令 ID。',
      });
      return;
    }
    const original: DiagnosticRestoration = {
      kind: diagnosticLookup.kind,
      id: id.data,
    };
    setDiagnosticLookup(undefined);
    setDiagnostic(null);
    setRestoration(original);
    onNavigate(caseHash(active.id, original));
  }
  function addResponseRule(stepId: string, rule: ResponseRule) {
    if (
      !draft ||
      !active ||
      active.removedAt ||
      !tester ||
      command.pending ||
      command.uncertain ||
      pendingReceipt ||
      diagnosticBusy
    )
      return '当前工作草稿不可编辑。';
    const current = draft.requests.find((step) => step.stepId === stepId);
    if (!current)
      return '原请求步骤已经移除或来自准备步骤，请在当前编辑步骤配置规则。';
    if (
      rule.kind === 'extractor' &&
      draft.requests.some((step) =>
        step.extractors.some((extractor) => extractor.name === rule.name),
      )
    )
      return '此用例已存在同名提取变量。';
    const next =
      rule.kind === 'assertion'
        ? {
            ...current,
            assertions: [
              ...current.assertions,
              {
                id: crypto.randomUUID(),
                source: 'json' as const,
                path: rule.path,
                operator: 'equals' as const,
                expectedText: JSON.stringify(rule.expected),
              },
            ],
          }
        : {
            ...current,
            extractors: [
              ...current.extractors,
              {
                name: rule.name,
                source: 'json' as const,
                path: rule.path,
                required: true,
                sensitive: rule.sensitive,
              },
            ],
          };
    setDraft({
      ...draft,
      requests: draft.requests.map((step) =>
        step.stepId === stepId ? next : step,
      ),
    });
    setRuleFocus({
      stepId,
      tab: rule.kind === 'assertion' ? 'assertions' : 'extractors',
      nonce: crypto.randomUUID(),
    });
    setDirty(true);
    return undefined;
  }
  function validateDraft() {
    if (!draft) return;
    try {
      const content = serializeApiDraft(draft);
      const hasJudgment = content.steps.some(
        (step) => step.assertions.length || step.preScript || step.postScript,
      );
      setError(undefined);
      if (hasJudgment)
        void message.success(
          '请求、变量和断言结构检查完成。真实结果以调试回执为准。',
        );
      else
        void message.warning(
          '当前用例没有业务断言，可查看调试响应，调试不能判定通过。',
        );
    } catch (failure) {
      setError(describeError(failure));
    }
  }
  function createScenario() {
    if (!versionId || !visibleVersion || (!batchId && sets.length !== 1))
      return;
    guard(() =>
      setEditor({
        targetType: 'scenario',
        kind: 'API',
        requirementVersionId: versionId,
        setId: batchId ?? (sets.length === 1 ? sets[0]?.id : undefined) ?? null,
        scenarioId: null,
        asset: null,
      }),
    );
  }
  const keyword = query.trim().toLocaleLowerCase();
  const requirementTitles = new Map(
    navigation.requirements.flatMap((requirement) =>
      requirement.versions.map((version) => [version.id, requirement.title]),
    ),
  );
  const assetTitles = new Map(assets.map((asset) => [asset.id, asset.title]));
  function matchesDirectory(asset: Asset, term = keyword) {
    return (
      !term ||
      [
        requirementTitles.get(asset.requirementVersionId),
        asset.parentId ? assetTitles.get(asset.parentId) : undefined,
        asset.title,
        asset.id,
      ].some((value) => value?.toLocaleLowerCase().includes(term))
    );
  }
  const qualificationsByCase = new Map(
    qualifications.map((item) => [item.caseId, item]),
  );
  const activeQualification = active
    ? qualificationsByCase.get(active.id)
    : undefined;
  const casesInScope = assets.filter(
    (asset) =>
      asset.targetType === 'case' &&
      (!versionId || asset.requirementVersionId === versionId) &&
      (!batchId || asset.setId === batchId) &&
      (!sceneId || asset.parentId === sceneId) &&
      matchesDirectory(asset, caseSearch.trim().toLocaleLowerCase()),
  );
  const pendingCases = casesInScope.filter(
    (asset) =>
      qualificationsByCase.get(asset.id)?.revisionId !== asset.revisionId,
  );
  const readyCases = casesInScope.filter((asset) =>
    qualificationsByCase.has(asset.id),
  );
  const visibleCases = caseView === 'pending' ? pendingCases : casesInScope;
  const libraryTabs = [
    { key: 'cases', label: '用例库' },
    {
      key: 'pending',
      label: (
        <span>
          待调试 <small>{pendingCases.length}</small>
        </span>
      ),
    },
    { key: 'coverage', label: '覆盖矩阵' },
    { key: 'definitions', label: '接口定义' },
  ] as const;
  function stopUsing(qualification: Qualification) {
    if (!project || !tester) return;
    const commandId = crypto.randomUUID();
    let reason = '';
    modal.confirm({
      title: `停止使用可回归修订 r${qualification.revisionNo}`,
      content: (
        <Space direction="vertical">
          <span>后续运行将重新解析资格。原运行和资格证据仍可查阅。</span>
          <Input.TextArea
            aria-label="停用原因"
            maxLength={1000}
            onChange={(event) => {
              reason = event.target.value.trim();
            }}
          />
        </Space>
      ),
      okText: '停止使用',
      cancelText: '取消',
      onOk: async () => {
        if (!reason) {
          void message.error('请填写停用原因。');
          throw new Error('Missing withdrawal reason');
        }
        try {
          await api(
            `/projects/${project.id}/api-executions/regression-qualifications/withdraw`,
            {
              method: 'POST',
              body: { commandId, snapshotId: qualification.snapshotId, reason },
            },
            apiRegressionWithdrawReceiptSchema,
          );
          await load();
        } catch (error) {
          void message.error(describeError(error));
          throw error;
        }
      },
    });
  }
  if (!project)
    return <Empty description="请选择当前有效项目后维护接口用例。" />;
  const caseWorkspace = Boolean(routedCase || active);
  const editDisabled =
    !tester ||
    Boolean(active?.removedAt) ||
    command.pending ||
    command.uncertain ||
    Boolean(pendingReceipt) ||
    diagnosticBusy;
  let diagnosticCurrent = false;
  if (
    diagnostic &&
    active?.revisionId === diagnostic.sourceCaseRevisionId &&
    draft
  ) {
    try {
      diagnosticCurrent =
        JSON.stringify(serializeApiDraft(draft)) ===
        JSON.stringify(diagnostic.content);
    } catch {
      // A draft with invalid input cannot match an earlier diagnostic candidate.
    }
  }

  return (
    <>
      {caseWorkspace ? (
        createCaseStaged ? null : (
          <StandaloneWorkbenchHeader
            title="接口自动化工作台"
            projectName={project.name}
            backLabel="返回接口用例管理"
            onBack={backToLibrary}
            backDisabled={command.pending || diagnosticBusy}
          />
        )
      ) : (
        <header className="api-library-heading">
          <div>
            <h1>接口用例管理</h1>
            <p>按需求、版本和场景维护接口用例，核对调试与回归资格。</p>
          </div>
          <Button
            type="primary"
            icon={<AppIcon name="plus" />}
            disabled={
              !tester ||
              !navigation.requirements.some((entry) => !entry.archived)
            }
            onClick={() => guard(() => setCreateCaseOpen(true))}
          >
            新建接口用例
          </Button>
        </header>
      )}
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
      {caseWorkspace && !createCaseStaged && (
        <main className="api-immersive-content">
          {!loading && !error && active && !currentRequirement && (
            <Alert
              type="info"
              showIcon
              className="section-alert"
              title="当前历史用例不在本次需求浏览范围"
              description="原详情、草稿与保存回执仍保留。可开启“显示已归档需求”找回目录；归档浏览开关不会撤销访问权限或重新提交保存。"
            />
          )}
          {active && draft && (
            <div className="api-editor-card">
              <header className="api-proto-intro">
                <p className="api-proto-path">
                  <span>{currentRequirement?.title ?? '原需求'}</span>
                  <span aria-hidden="true">/</span>
                  <span>
                    {currentRequirement?.versions.find(
                      (version) => version.id === active.requirementVersionId,
                    )
                      ? 'v' +
                        currentRequirement.versions.find(
                          (version) =>
                            version.id === active.requirementVersionId,
                        )?.versionNo
                      : '原需求版本'}
                  </span>
                  <span aria-hidden="true">/</span>
                  <span>
                    {assets.find((asset) => asset.id === active.parentId)
                      ?.title ?? '原场景'}
                  </span>
                </p>
                <div className="api-proto-intro-row">
                  <div className="api-proto-intro-main">
                    <div className="api-proto-title-line">
                      <h1>{draft.base.title}</h1>
                      {dirty ? (
                        <StatusTag tone="warning">未保存</StatusTag>
                      ) : (
                        <StatusTag tone="neutral">
                          当前 r{active.revisionNo}
                        </StatusTag>
                      )}
                      <StatusTag
                        tone={activeQualification ? 'success' : 'neutral'}
                      >
                        {activeQualification
                          ? '可回归 r' + activeQualification.revisionNo
                          : '暂无回归资格'}
                      </StatusTag>
                    </div>
                    <p>
                      {draft.requests.length} 个请求，
                      {draft.requests.reduce(
                        (total, step) => total + step.assertions.length,
                        0,
                      )}{' '}
                      条断言
                    </p>
                  </div>
                  <div className="api-proto-intro-actions">
                    <Button
                      type="text"
                      aria-label="编辑用例说明"
                      title="编辑用例说明"
                      icon={<AppIcon name="settings" />}
                      onClick={() => setCaseSettingsOpen(true)}
                    />
                    <Button
                      icon={<AppIcon name="check" />}
                      disabled={editDisabled || !dirty}
                      loading={command.pending}
                      onClick={() => void save()}
                    >
                      保存草稿
                    </Button>
                    <div ref={setEnvironmentHost} />
                    <Button
                      type="primary"
                      icon={<AppIcon name="play" />}
                      disabled={editDisabled}
                      onClick={() => prepareDiagnostic()}
                    >
                      运行调试
                    </Button>
                  </div>
                </div>
              </header>
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
              <div className="api-workbench-split">
                <div className="api-workbench-editor stack">
                  <ApiCaseFields
                    projectId={project.id}
                    value={draft}
                    disabled={editDisabled}
                    presentation="workbench"
                    onSingleDiagnostic={prepareDiagnostic}
                    ruleFocus={ruleFocus}
                    previewEnvironmentId={previewEnvironmentId}
                    onPreviewEnvironmentChange={setPreviewEnvironmentId}
                    onChange={(value) => {
                      setDraft(value);
                      setDirty(true);
                    }}
                    environmentHost={environmentHost}
                    onValidate={validateDraft}
                    workspaceSummary={
                      <div className="api-proto-summary">
                        <p>
                          <strong>当前用例</strong>
                          <code title={active.id}>{active.id}</code>
                        </p>
                        <p>
                          <span>编辑修订</span>
                          <StatusTag tone="neutral">
                            r{active.revisionNo}
                          </StatusTag>
                        </p>
                        <p>
                          <span>执行资格</span>
                          <StatusTag
                            tone={activeQualification ? 'success' : 'neutral'}
                          >
                            {activeQualification
                              ? '可回归 r' + activeQualification.revisionNo
                              : '暂无资格'}
                          </StatusTag>
                        </p>
                      </div>
                    }
                    workspacePanels={{
                      data: (
                        <ApiCaseComposition
                          key={`${active.id}:${active.revisionId}`}
                          value={draft.base}
                          cases={assets.flatMap((asset) => {
                            const qualified = qualificationsByCase.get(
                              asset.id,
                            );
                            return asset.targetType === 'case' &&
                              asset.id !== active.id &&
                              qualified
                              ? [
                                  {
                                    ...asset,
                                    revisionId: qualified.revisionId,
                                    revisionNo: qualified.revisionNo,
                                  },
                                ]
                              : [];
                          })}
                          disabled={editDisabled}
                          onApply={(composition) => {
                            setDraft({
                              ...draft,
                              base: { ...draft.base, ...composition },
                            });
                            setDirty(true);
                          }}
                        />
                      ),
                      sources: currentRequirement ? (
                        <ApiDefinitionLibrary
                          projectId={project.id}
                          requirementId={currentRequirement.id}
                          versionId={active.requirementVersionId}
                          {...(!editDisabled
                            ? {
                                onAdopt: (step, basis) => {
                                  if (draft.requests.length >= 100) {
                                    void message.warning(
                                      '当前用例已达到步骤上限。',
                                    );
                                    return;
                                  }
                                  setDraft({
                                    ...draft,
                                    requests: [...draft.requests, step],
                                    base: {
                                      ...draft.base,
                                      basisRefs: draft.base.basisRefs.some(
                                        (ref) =>
                                          ref.objectId === basis.objectId &&
                                          ref.revisionId === basis.revisionId &&
                                          ref.locator === basis.locator,
                                      )
                                        ? draft.base.basisRefs
                                        : [...draft.base.basisRefs, basis],
                                    },
                                  });
                                  setDirty(true);
                                  setRuleFocus({
                                    stepId: step.stepId,
                                    tab: 'parameters',
                                    nonce: crypto.randomUUID(),
                                  });
                                },
                              }
                            : {})}
                        />
                      ) : undefined,
                      revisions: (
                        <div className="stack">
                          <div className="api-proto-revision-note">
                            <strong>当前草稿 r{active.revisionNo}</strong>
                            <p className="caption">
                              保存草稿生成新修订，已有资格继续指向对应的冻结修订。
                            </p>
                          </div>
                          {activeQualification && (
                            <div className="api-proto-revision-note">
                              <strong>
                                可回归 r{activeQualification.revisionNo}
                              </strong>
                              <p className="caption">
                                原资格 {activeQualification.snapshotId}
                              </p>
                            </div>
                          )}
                          <Space wrap>
                            {activeQualification?.debugRunId && (
                              <Button
                                onClick={() =>
                                  guard(() => {
                                    if (!activeQualification.debugRunId) return;
                                    setDiagnostic(null);
                                    setRestoration({
                                      kind: 'run',
                                      id: activeQualification.debugRunId,
                                    });
                                    onNavigate(
                                      caseHash(active.id, {
                                        kind: 'run',
                                        id: activeQualification.debugRunId,
                                      }),
                                    );
                                  }, true)
                                }
                              >
                                查看资格调试证据
                              </Button>
                            )}
                            {activeQualification && (
                              <Button
                                onClick={() => {
                                  void modal.info({
                                    title: '回归计划选版',
                                    content: (
                                      <div className="stack">
                                        <strong>
                                          {active.title +
                                            ' · r' +
                                            activeQualification.revisionNo}
                                        </strong>
                                        <p className="caption">
                                          这是此刻有效的资格。正式启动会重新核对资格、目标环境和清理配置。
                                        </p>
                                        <span className="caption">
                                          资格 {activeQualification.snapshotId}
                                        </span>
                                      </div>
                                    ),
                                  });
                                }}
                              >
                                查看计划选版
                              </Button>
                            )}
                            {tester && activeQualification && (
                              <>
                                <Button
                                  onClick={() =>
                                    guard(() => {
                                      window.location.hash = `plans?kind=API&caseId=${active.id}`;
                                    })
                                  }
                                >
                                  加入回归计划
                                </Button>
                                <Button
                                  danger
                                  onClick={() => stopUsing(activeQualification)}
                                >
                                  停止使用此资格
                                </Button>
                              </>
                            )}
                          </Space>
                        </div>
                      ),
                    }}
                  />
                </div>
                <ApiDraftDebugger
                  projectId={project.id}
                  draft={diagnostic}
                  restoration={restoration}
                  expectedCaseId={active.id}
                  userId={userId}
                  onOpenHistory={() =>
                    setDiagnosticLookup({ kind: 'run', id: '' })
                  }
                  candidateCurrent={diagnosticCurrent}
                  {...(!editDisabled ? { onRule: addResponseRule } : {})}
                  onBusyChange={setDiagnosticBusy}
                  onQualified={async (asset) => {
                    setDiagnostic(null);
                    await saved(asset);
                    void message.success('已保存为可回归修订。');
                  }}
                  onClose={() => {
                    setDiagnostic(null);
                    setRestoration(null);
                    onNavigate(caseHash(active.id));
                  }}
                />
              </div>
              <Modal
                title="用例名称与说明"
                open={caseSettingsOpen}
                onCancel={() => setCaseSettingsOpen(false)}
                footer={
                  <Button onClick={() => setCaseSettingsOpen(false)}>
                    完成
                  </Button>
                }
              >
                <div className="api-documentation-fields">
                  <label className="field-label">
                    标题
                    <Input
                      value={draft.base.title}
                      disabled={editDisabled}
                      maxLength={200}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          base: {
                            ...draft.base,
                            title: event.target.value,
                          },
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
                        disabled={editDisabled}
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
                      disabled={editDisabled}
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
              </Modal>
              <Modal
                title="只读查询原诊断"
                open={Boolean(diagnosticLookup)}
                onCancel={() => setDiagnosticLookup(undefined)}
                onOk={openOriginalDiagnostic}
                okText="查询原诊断"
              >
                {diagnosticLookup && (
                  <div className="stack">
                    <p className="caption">
                      以原始标识读取当前项目同一用例的证据。
                    </p>
                    <Select
                      aria-label="选择此用例已有调试轮次"
                      placeholder="选择此用例的历史调试轮次"
                      loading={!history && !historyError}
                      showSearch
                      optionFilterProp="label"
                      value={
                        diagnosticLookup.kind === 'run' &&
                        history?.some(
                          (entry) => entry.runId === diagnosticLookup.id,
                        )
                          ? diagnosticLookup.id
                          : null
                      }
                      options={(history ?? []).map((entry) => ({
                        value: entry.runId,
                        label: [
                          formatBeijingTime(entry.createdAt, true),
                          entry.diagnosticStepId ? '单步诊断' : '完整调试',
                          entry.sourceRevisionNo !== null
                            ? '来源 r' + entry.sourceRevisionNo
                            : '来源修订未取得',
                          entry.state,
                          entry.qualificationRetained
                            ? '资格证据保留'
                            : '临时诊断',
                        ].join(' · '),
                      }))}
                      notFoundContent="没有仍可读取的已登记调试轮次。"
                      onChange={(id: string) =>
                        setDiagnosticLookup({ kind: 'run', id })
                      }
                    />
                    {historyError && (
                      <Alert type="warning" showIcon title={historyError} />
                    )}
                    <p className="caption">也可用原调试轮次或命令标识查询。</p>

                    <Select
                      aria-label="原诊断标识类型"
                      value={diagnosticLookup.kind}
                      options={[
                        { value: 'run', label: '原调试轮次 ID' },
                        { value: 'command', label: '原命令 ID' },
                      ]}
                      onChange={(kind: DiagnosticRestoration['kind']) =>
                        setDiagnosticLookup({ kind, id: diagnosticLookup.id })
                      }
                    />
                    <Input
                      aria-label="原诊断标识"
                      value={diagnosticLookup.id}
                      onChange={(event) =>
                        setDiagnosticLookup({
                          kind: diagnosticLookup.kind,
                          id: event.target.value,
                        })
                      }
                    />
                    {diagnosticLookup.error && (
                      <Alert
                        type="error"
                        showIcon
                        title={diagnosticLookup.error}
                      />
                    )}
                  </div>
                )}
              </Modal>
            </div>
          )}
          {!active &&
            (loading ? (
              <Skeleton active />
            ) : (
              <Empty
                description={
                  isDraftRoute()
                    ? '当前没有可恢复的未保存草稿。返回后可重新新建。'
                    : '未取得此接口用例'
                }
              />
            ))}
        </main>
      )}
      <div className="api-management-library" hidden={caseWorkspace}>
        <div className="asset-workspace live-asset-workspace api-workbench requirement-directory-layout">
          <RequirementDirectory
            includeArchived={includeArchivedRequirements}
            onIncludeArchivedChange={changeArchiveScope}
            archiveDisabled={command.pending}
            search={query}
            onSearchChange={setQuery}
            searchPlaceholder="搜索需求、场景或用例"
          >
            <button
              type="button"
              className={`tree-node requirement-directory-button${directoryVersion ? '' : ' active'}`}
              aria-pressed={!directoryVersion}
              onClick={() =>
                guard(() => {
                  activate(null);
                  setDirectoryScope();
                })
              }
            >
              <RequirementDirectoryLabel
                title="全部需求"
                count={`${navigation.requirements.reduce(
                  (count, requirement) => count + requirement.caseCount,
                  0,
                )} 条用例`}
              />
            </button>
            {loading && !assets.length ? (
              <Skeleton active />
            ) : (
              <Tree
                blockNode
                expandedKeys={
                  keyword
                    ? [
                        ...navigation.requirements.map(
                          (item) => `requirement:${item.id}`,
                        ),
                        ...assets
                          .filter((item) => item.targetType === 'scenario')
                          .map((item) => `scenario:${item.id}`),
                      ]
                    : expandedKeys
                }
                onExpand={(keys) => {
                  if (!keyword) setExpandedKeys(keys.map(String));
                }}
                selectedKeys={
                  directoryVersion && active
                    ? [`case:${active.id}`]
                    : sceneId
                      ? [`scenario:${sceneId}`]
                      : directoryRequirement
                        ? [`requirement:${directoryRequirement.id}`]
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
                      setDirectoryScope(
                        requirement
                          ? [...requirement.versions].sort(
                              (a, b) => b.versionNo - a.versionNo,
                            )[0]?.id
                          : undefined,
                      );
                    });
                  } else {
                    const asset = assets.find((item) => item.id === id);
                    if (asset)
                      guard(() => {
                        if (type === 'case') openCase(asset);
                        else {
                          activate(null);
                          setVersionId(asset.requirementVersionId);
                          setBatchId(asset.setId);
                          setSceneId(asset.id);
                        }
                      });
                  }
                }}
                autoExpandParent={Boolean(keyword)}
                treeData={navigation.requirements
                  .filter(
                    (requirement) =>
                      !keyword ||
                      requirement.title.toLocaleLowerCase().includes(keyword) ||
                      assets.some(
                        (asset) =>
                          asset.targetType !== 'set' &&
                          matchesDirectory(asset) &&
                          requirement.versions.some(
                            (version) =>
                              version.id === asset.requirementVersionId,
                          ),
                      ),
                  )
                  .map((requirement) => ({
                    key: `requirement:${requirement.id}`,
                    title: (
                      <RequirementDirectoryLabel
                        title={requirement.title}
                        archived={requirement.archived}
                        count={`${requirement.caseCount} 条用例`}
                      />
                    ),
                    children: assets
                      .filter(
                        (asset) =>
                          asset.targetType === 'scenario' &&
                          requirement.versions.some(
                            (version) =>
                              version.id === asset.requirementVersionId,
                          ),
                      )
                      .filter(
                        (asset) =>
                          matchesDirectory(asset) ||
                          assets.some(
                            (child) =>
                              child.parentId === asset.id &&
                              matchesDirectory(child),
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
                              matchesDirectory(asset),
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
          </RequirementDirectory>
          <section className="asset-pane api-library-card">
            <div className="api-proto-pane-heading">
              <h2>{directoryRequirement?.title ?? '全部需求'}</h2>
              {sceneId && (
                <StatusTag tone="neutral">
                  {assetTitles.get(sceneId) ?? '场景'}
                </StatusTag>
              )}
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'refresh', label: '刷新目录' },
                    ...(tester
                      ? [
                          { key: 'generate', label: '生成选定范围' },
                          {
                            key: 'scenario',
                            label: '新增场景',
                            disabled:
                              !versionId ||
                              !visibleVersion ||
                              (!batchId && sets.length !== 1),
                          },
                        ]
                      : []),
                    { key: 'diagnostic', label: '原诊断找回' },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'refresh') void load();
                    else if (key === 'generate')
                      guard(() => {
                        window.location.hash = 'workspace';
                      });
                    else if (key === 'scenario') createScenario();
                    else if (key === 'diagnostic') setLookup(true);
                  },
                }}
              >
                <Button
                  type="text"
                  size="small"
                  title="更多操作"
                  aria-label="更多操作"
                  icon={<AppIcon name="more" />}
                />
              </Dropdown>
            </div>
            <Tabs
              className="api-library-tabs"
              activeKey={caseView}
              size="small"
              items={[...libraryTabs]}
              onChange={(key) => {
                const tab = libraryTabs.find((item) => item.key === key);
                if (tab) setCaseView(tab.key);
              }}
            />
            <div className="api-library-scroll">
              <div className="api-library-toolbar">
                <Select
                  aria-label="接口需求版本"
                  placeholder="全部版本"
                  allowClear
                  value={visibleVersion ? versionId : undefined}
                  onChange={(id) =>
                    guard(() => {
                      activate(null);
                      setDirectoryScope(id);
                    })
                  }
                  options={(directoryRequirement
                    ? [directoryRequirement]
                    : navigation.requirements
                  ).flatMap((requirement) =>
                    requirement.versions.map((version) => ({
                      value: version.id,
                      label: directoryRequirement
                        ? 'v' + version.versionNo
                        : requirement.title + ' · v' + version.versionNo,
                    })),
                  )}
                />
                {sets.length > 1 && visibleVersion && (
                  <Select
                    aria-label="历史用例来源"
                    placeholder="历史来源（全部）"
                    allowClear
                    value={
                      sets.some((set) => set.id === batchId)
                        ? batchId
                        : undefined
                    }
                    onChange={(id) =>
                      guard(() => {
                        activate(null);
                        setBatchId(id);
                        setSceneId(undefined);
                      })
                    }
                    options={sets.map((set) => ({
                      value: set.id,
                      label: set.title,
                    }))}
                  />
                )}
                {caseView !== 'definitions' && (
                  <div className="api-library-search">
                    <Input
                      allowClear
                      aria-label="搜索接口用例"
                      placeholder="搜索用例或场景"
                      value={searchText}
                      onChange={(event) => {
                        setSearchText(event.target.value);
                        if (!event.target.value) setCaseSearch('');
                      }}
                      onPressEnter={() => setCaseSearch(searchText)}
                    />
                    <Button onClick={() => setCaseSearch(searchText)}>
                      搜索
                    </Button>
                  </div>
                )}
              </div>
              {caseView !== 'definitions' && (
                <div className="api-library-statistics">
                  <button type="button" onClick={() => setCaseView('cases')}>
                    <b>{casesInScope.length}</b>
                    <span>范围内用例</span>
                  </button>
                  <button type="button" onClick={() => setCaseView('pending')}>
                    <b>{pendingCases.length}</b>
                    <span>当前修订待调试</span>
                  </button>
                  <button type="button" onClick={() => setCaseView('coverage')}>
                    <b>{readyCases.length}</b>
                    <span>有回归资格</span>
                  </button>
                </div>
              )}
              {caseView === 'definitions' ? (
                directoryRequirement && versionId ? (
                  <ApiDefinitionLibrary
                    projectId={project.id}
                    requirementId={directoryRequirement.id}
                    versionId={versionId}
                  />
                ) : (
                  <Empty description="选择明确的需求版本后查看此版登记的接口材料。" />
                )
              ) : caseView === 'coverage' ? (
                <ApiCoverage
                  projectId={project.id}
                  cases={visibleCases}
                  assets={assets}
                  readyCaseIds={new Set(qualificationsByCase.keys())}
                  openScenario={(id) => {
                    const scenario = assets.find((item) => item.id === id);
                    if (!scenario) return;
                    setVersionId(scenario.requirementVersionId);
                    setBatchId(scenario.setId);
                    setSceneId(scenario.id);
                    setCaseView('cases');
                  }}
                />
              ) : (
                <Table
                  className="api-library-table"
                  size="small"
                  rowKey="id"
                  loading={loading}
                  dataSource={visibleCases}
                  pagination={
                    visibleCases.length > 10
                      ? { pageSize: 10, showSizeChanger: false }
                      : false
                  }
                  scroll={{ x: 600 }}
                  columns={[
                    {
                      title: '接口用例',
                      render: (_, asset) => (
                        <div className="api-library-case">
                          <Button
                            type="link"
                            className="api-library-case-title"
                            onClick={() => guard(() => openCase(asset))}
                          >
                            {asset.title}
                          </Button>
                          <small className="caption" title={asset.id}>
                            {asset.id.slice(0, 8)} ·{' '}
                            {assetTitles.get(asset.parentId ?? '') ?? '原场景'}
                          </small>
                        </div>
                      ),
                    },
                    {
                      title: '步骤 / 断言',
                      render: (_, asset) =>
                        'dslVersion' in asset.content
                          ? asset.content.steps.length +
                            ' / ' +
                            asset.content.steps.reduce(
                              (total, step) => total + step.assertions.length,
                              0,
                            )
                          : '—',
                    },
                    {
                      title: '当前修订',
                      render: (_, asset) => (
                        <Space size={4} wrap>
                          <StatusTag tone="neutral">
                            当前 r{asset.revisionNo}
                          </StatusTag>
                          {qualificationsByCase.get(asset.id)?.revisionId !==
                            asset.revisionId && (
                            <StatusTag tone="warning">待调试</StatusTag>
                          )}
                        </Space>
                      ),
                    },
                    {
                      title: '可回归修订',
                      render: (_, asset) => {
                        const available = qualificationsByCase.get(asset.id);
                        return available ? (
                          <StatusTag tone="success">
                            可回归 r{available.revisionNo}
                          </StatusTag>
                        ) : (
                          <StatusTag tone="neutral">暂无回归资格</StatusTag>
                        );
                      },
                    },
                    {
                      title: '操作',
                      render: (_, asset) => (
                        <Button
                          size="small"
                          icon={<AppIcon name="arrow" />}
                          aria-label={'打开 ' + asset.title}
                          onClick={() => guard(() => openCase(asset))}
                        >
                          打开
                        </Button>
                      ),
                    },
                  ]}
                  locale={{
                    emptyText:
                      '当前范围没有接口用例。可先选择需求、版本和场景。',
                  }}
                />
              )}
            </div>
            {lookup && (
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
                    children: caseWorkspace ? null : (
                      <ApiDiagnosticPage project={project} />
                    ),
                  },
                ]}
              />
            )}
          </section>
        </div>
      </div>
      {createCaseOpen && (
        <ApiScopedCaseEditor
          projectId={project.id}
          projectName={project.name}
          userId={userId}
          requirements={navigation.requirements}
          assets={assets}
          initialVersionId={versionId}
          initialScenarioId={sceneId}
          onStage={stageNewCase}
          onClose={closeNewCase}
          onSaved={async (asset) => {
            setCreateCaseOpen(false);
            setCreateCaseStaged(false);
            await saved(asset);
          }}
        />
      )}
      <AssetEditor
        userId={userId}
        projectId={project.id}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={saved}
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
    </>
  );
}
