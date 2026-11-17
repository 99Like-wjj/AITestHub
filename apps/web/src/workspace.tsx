import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  InlineComposer,
  InlineMessageContent,
  type InlineComposerHandle,
} from './inline-composer';
import {
  inlineReferenceKey,
  inlineReferenceMarker,
  inlineSkillMarker,
  replaceConversationReferenceCode,
  parseInlineComposerTokens,
} from './workspace-inline-tokens';
import type { ReactNode } from 'react';
import {
  Alert,
  App,
  Button,
  Dropdown,
  Drawer,
  Form,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  PaperClipOutlined,
  PlusOutlined,
  CommentOutlined,
  ProjectOutlined,
  ApiOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { auxiliaryTaskReceiptSchema } from '../../../packages/contracts/src/auxiliary';
import { availableModelV2ListSchema } from '../../../packages/contracts/src/model-configuration-v2';
import type { AvailableModelV2 } from '../../../packages/contracts/src/model-configuration-v2';
import {
  conversationDetailSchema,
  conversationMutationSchema,
  conversationSidebarSchema,
  requirementGroupCandidatesSchema,
  requirementGroupMutationSchema,
  sendMessageInputSchema,
  taskAcceptedSchema,
  taskStateSchema,
} from '../../../packages/contracts/src/conversations';
import type {
  Conversation,
  ConversationDetail,
  ConversationSidebar,
  ConversationMessage,
  SendMessageInput,
  OperationTarget,
} from '../../../packages/contracts/src/conversations';
import { api, ApiError, describeError, isUncertainMutationError } from './api';
import { modelDisplayLabel, modelServiceCaption } from './model-display-label';
import { resolveComposerDestination } from './workspace-first-send';
import {
  conversationCreateChanged,
  pendingConversationCreates,
  prepareConversationCreate,
  dispatchConversationCreate,
  recoverConversationCreate,
} from './workspace-create';
import type { ConversationCreateAttempt } from './workspace-create';
import { uiLayers } from './ui-layers';
import { AppIcon } from './app-icon';
import { AppearanceToggle } from './appearance-toggle';
import { AgentWorkspace } from './agent-workspace';
import { FileCenter } from './file-center';
import { ConversationActionCards } from './conversation-action-cards';
import { ExternalMcpInvocationsPanel } from './external-mcp-settings';
import { AiRetryStatus } from './ai-retry-status';
import {
  ModelAttemptFragments,
  ModelRetryStatus,
} from './workspace-model-retry';
import { onPersonalContentChanged } from './personal-content-events';
import { uploadPersonalFile } from './file-channel';
import { AuxiliaryAction } from './auxiliary-action';
import { AutomaticAuxiliaryPanel } from './automatic-auxiliary-panel';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import {
  encodeConversationReference,
  decodeConversationReference,
} from '../../../packages/contracts/src/conversation-reference-code';
import { downloadConversationMarkdown } from './conversation-download';
import { ConversationMenu, WorkspaceSidebar } from './workspace-sidebar';
import type {
  ConversationAction,
  GroupAction,
  RequirementGroup,
} from './workspace-sidebar';
import {
  WorkspaceInlineCandidates,
  type WorkspaceInlineCandidatesHandle,
} from './workspace-inline-candidates';
import { composerTrigger } from './workspace-trigger';
import type { PlatformGuidanceSkillId } from '../../../packages/contracts/src/skill-guidance';
import './workspace-composer.css';
import './workspace-ai-controls.css';
import { WorkspaceContextPicker } from './workspace-context-picker';
import {
  WorkspaceAccessPicker,
  readWorkspaceAccess,
  saveWorkspaceAccess,
} from './workspace-access';
import { WorkspaceModelPicker } from './workspace-model-picker';
import { WorkspaceContextDrawer } from './workspace-context-drawer';
import { WorkspaceSendButton } from './workspace-send-button';
import { WorkspaceJumpLatest } from './workspace-jump-latest';
import { WorkspaceComposerReferences } from './workspace-composer-references';
import { WorkspaceMessageReferences } from './workspace-message-references';
import { serializeComposerSkills } from './workspace-composer-skills';
import {
  readWorkspaceSendMode,
  saveWorkspaceSendMode,
  workspaceSendModeStorageKey,
  WORKSPACE_SEND_MODE_CHANGED_EVENT,
  type WorkspaceSendMode,
} from './workspace-queue-preference';
import type { WorkspaceQueuedMessage } from './workspace-send-queue';
import {
  chooseWorkspaceModel,
  rememberWorkspaceModelSelection,
  restoreWorkspaceModelPreference,
  type WorkspaceModelPreference,
} from './workspace-model-preference';
import {
  WorkspacePendingMessages,
  useWorkspaceSendQueue,
} from './workspace-queue-controller';
import { workspaceDataScope } from '../../../packages/contracts/src/workspace-access';
import type { PreparedReference, ReferenceTab } from './workspace-references';
import { taskStateLabels, useAiTask } from './workspace-tasks';
import {
  workspaceDrafts,
  pendingWorkspaceSends,
  pendingCreationDrafts,
  clearSubmittedDraft,
  promoteWorkspaceDraft,
  saveWorkspaceDraft,
  resolveWorkspaceDraftTarget,
  newDraftKey,
  moveInsertion,
  removeInsertions,
} from './workspace-drafts';
import type { ComposerInsertion, WorkspaceDraft } from './workspace-drafts';
import { readWorkspaceSendReceipt } from './workspace-send-receipt';
import { WorkspaceMarkdown } from './workspace-markdown';
import { WorkspaceTurn } from './workspace-turn';
import { useWorkspaceScroll } from './workspace-scroll';
import './workspace-stream.css';
import type { Me, Project } from './types';

const modelsSchema = availableModelV2ListSchema;
const cancelReceiptSchema = z.strictObject({
  taskId: z.uuid(),
  status: taskStateSchema,
});
type GroupCandidate = z.infer<
  typeof requirementGroupCandidatesSchema
>['groups'][number];
type AliasTarget =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'group'; group: RequirementGroup };
type Draft = WorkspaceDraft;
interface UncertainSend {
  conversationId: string;
  commandId: string;
  input: SendMessageInput;
  draft: Draft;
}

function conversationFromUrl() {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const result = idSchema.safeParse(query.get('conversationId'));
  return result.success ? result.data : null;
}
function operationTargetFor(
  projectId: string | null,
  conversation: Conversation | null,
): OperationTarget | null {
  return projectId
    ? {
        projectId,
        ...(projectId === conversation?.projectId && conversation.requirementId
          ? { requirementId: conversation.requirementId }
          : {}),
      }
    : null;
}
function MessageText({
  text,
  references = [],
}: {
  text: string;
  references?: ConversationMessage['references'];
}) {
  const allowed = new Set(
    references.flatMap((item) =>
      item.reference.kind === 'projectAccess'
        ? []
        : [inlineReferenceKey(item.reference)],
    ),
  );
  return (
    <InlineMessageContent
      text={text}
      allowedReferences={allowed}
      renderText={(value) => <WorkspaceMarkdown text={value} />}
    />
  );
}
function isInlineMessageReference(
  text: string,
  reference: ConversationMessage['references'][number]['reference'],
) {
  if (reference.kind === 'projectAccess') return false;
  const key = inlineReferenceKey(reference);
  return parseInlineComposerTokens(text).some(
    (token) => token.referenceKey === key,
  );
}
function ModelCaption({ message }: { message: ConversationMessage }) {
  return (
    <Typography.Text type="secondary" className="message-caption">
      发送时选择：
      {message.modelSnapshot
        ? 'schemaVersion' in message.modelSnapshot
          ? `${modelDisplayLabel(message.modelSnapshot)} · ${modelServiceCaption(message.modelSnapshot)}`
          : `${message.modelSnapshot.provider} / ${message.modelSnapshot.modelId}`
        : (message.modelServiceId ?? '未记录模型标识')}{' '}
      · 配置 r{message.configRevision ?? '未知'}
      {message.effort ? ` · ${message.effort}` : ''}
      {message.role === 'assistant'
        ? ` · ${message.status === 'queued' ? '尚无模型响应' : message.executionOrigin === 'fixture' ? '隔离夹具记录' : message.executionOrigin === 'liveProvider' ? '供应商通道记录' : '执行来源未确认'}`
        : ''}
      {message.role === 'assistant' &&
      ['failed', 'cancelled', 'interrupted'].includes(message.status)
        ? ' · 此回复未完成，片段保留供核对'
        : ''}
    </Typography.Text>
  );
}

export function Workspace({
  dark,
  onAppearance,
  appearancePending,
  notificationBell,
  me,
  project,
  onProjectChange,
  onSettings,
}: {
  dark: boolean;
  onAppearance: () => void;
  appearancePending: boolean;
  notificationBell: ReactNode;
  me: Me;
  project: Project | null;
  onProjectChange: (id: string | null) => void;
  onSettings: () => void;
}) {
  const { message, modal } = App.useApp();
  const [sidebar, setSidebar] = useState<ConversationSidebar | null>(null);
  const [sideLoading, setSideLoading] = useState(true);
  const [sideError, setSideError] = useState<string>();
  const [models, setModels] = useState<AvailableModelV2[]>([]);
  const [modelError, setModelError] = useState<string>();
  const [modelLoading, setModelLoading] = useState(true);
  const [modelPreference, setModelPreference] =
    useState<WorkspaceModelPreference | null>(null);
  const selection =
    modelPreference?.ownerId === me.user.id ? modelPreference : null;
  const selectedModelId = selection?.modelEntryId ?? null;
  const selectedRevision = selection?.serviceRevision ?? null;
  const effort = selection?.effort ?? null;
  const [activeId, setActiveId] = useState<string | null>(conversationFromUrl);
  const activeRef = useRef(activeId);
  const pendingMessages = useWorkspaceSendQueue(me.user.id, activeId);
  const browseRef = useRef(project?.id ?? null);
  const browseGeneration = useRef(0);
  if (browseRef.current !== (project?.id ?? null))
    browseGeneration.current += 1;
  browseRef.current = project?.id ?? null;
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string>();
  const [content, setContent] = useState('');
  const [composerSkills, setComposerSkills] = useState<
    PlatformGuidanceSkillId[]
  >([]);
  const [draftTarget, setDraftTarget] = useState<{
    ownerId: string;
    scope: string;
    value: OperationTarget | null;
  } | null>(null);
  const [accessMode, setAccessMode] = useState(() =>
    readWorkspaceAccess(me.user.id),
  );
  const dataScope = workspaceDataScope(accessMode);
  useEffect(() => {
    setAccessMode(readWorkspaceAccess(me.user.id));
  }, [me.user.id]);
  const [references, setReferences] = useState<PreparedReference[]>([]);
  const targetProjectId = project?.id ?? null;
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sendModePreference, setSendModePreference] = useState<{
    ownerId: string;
    mode: WorkspaceSendMode;
  } | null>(null);
  const sendMode =
    sendModePreference?.ownerId === me.user.id
      ? sendModePreference.mode
      : 'queue';
  const [sendModeError, setSendModeError] = useState<string>();
  useEffect(() => {
    const load = () => {
      if (currentIdentityOwner() !== me.user.id) return;
      try {
        setSendModePreference({
          ownerId: me.user.id,
          mode: readWorkspaceSendMode(me.user.id),
        });
        setSendModeError(undefined);
      } catch {
        setSendModeError('发送偏好暂时无法读取，当前使用排队模式。');
        setSendModePreference(null);
      }
    };
    const changed = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === workspaceSendModeStorageKey(me.user.id)
      )
        load();
    };
    load();
    window.addEventListener('storage', changed);
    window.addEventListener(WORKSPACE_SEND_MODE_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener(WORKSPACE_SEND_MODE_CHANGED_EVENT, load);
    };
  }, [me.user.id]);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendPreview, setSendPreview] = useState<{
    conversationId: string;
    content: string;
    references: ConversationMessage['references'];
    userMessageId: string | null;
    createdAt: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [createAttempts, setCreateAttempts] = useState<
    ConversationCreateAttempt[]
  >([]);
  const [createRecoveryError, setCreateRecoveryError] = useState<string>();
  const [uploading, setUploading] = useState<
    { id: string; name: string; state: string; error?: string }[]
  >([]);
  const [sendError, setSendError] = useState<string>();
  const [uncertain, setUncertain] = useState<UncertainSend | null>(null);
  const [taskId, setTaskIdState] = useState<string | null>(null);
  const taskIdentity = useRef(taskId);
  function setTaskId(id: string | null) {
    taskIdentity.current = id;
    setTaskIdState(id);
  }
  const [proposalTaskId, setProposalTaskId] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceTab, setReferenceTab] = useState<ReferenceTab>('history');
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissedCandidate, setDismissedCandidate] = useState<string | null>(
    null,
  );
  const [activeCandidateId, setActiveCandidateId] = useState<string>();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [groupCandidates, setGroupCandidates] = useState<GroupCandidate[]>([]);
  const [groupError, setGroupError] = useState<string>();
  const [groupLoading, setGroupLoading] = useState(false);
  const [aliasTarget, setAliasTarget] = useState<AliasTarget | null>(null);
  const [compactNavigation, setCompactNavigation] = useState(
    () => window.matchMedia('(max-width: 700px)').matches,
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [fileCenterOpen, setFileCenterOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const changed = () => {
      setCompactNavigation(media.matches);
      if (!media.matches) setNavigationOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const aliasReturnFocus = useRef<(() => void) | null>(null);
  const [aliasError, setAliasError] = useState<string>();
  const [aliasForm] = Form.useForm<{ alias: string }>();
  const [associateOpen, setAssociateOpen] = useState(false);
  const [associationError, setAssociationError] = useState<string>();
  const drafts = useRef(workspaceDrafts(me.user.id));
  drafts.current = workspaceDrafts(me.user.id);
  const creationDrafts = useRef(pendingCreationDrafts(me.user.id));
  creationDrafts.current = pendingCreationDrafts(me.user.id);
  const candidateInsertion = useRef<ComposerInsertion | null>(null);
  const creatingRef = useRef(false);
  const sendDispatchInProgress = useRef(false);
  const mounted = useRef(true);
  const conversationNavigation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      conversationNavigation.current += 1;
    };
  }, []);
  const uncertainSends = useRef(pendingWorkspaceSends(me.user.id));
  uncertainSends.current = pendingWorkspaceSends(me.user.id);
  const conversationEpoch = useRef(0);
  const sidebarEpoch = useRef(0);
  const groupEpoch = useRef(0);
  const composition = useRef(false);
  const input = useRef<InlineComposerHandle | null>(null);
  const composerContent = useRef(content);
  composerContent.current = content;
  const selectedReferenceHistory = useRef(
    new Map<string, Map<string, PreparedReference>>(),
  );
  const inlineAllowedReferences = useMemo(
    () => new Set(references.map((item) => inlineReferenceKey(item.reference))),
    [references],
  );
  useEffect(() => {
    if (composerSkills.length) {
      setContent((value) => serializeComposerSkills(composerSkills, value));
      setComposerSkills([]);
    }
  }, [composerSkills]);
  useEffect(() => {
    const existing = parseInlineComposerTokens(content);
    const missing = references.filter(
      (reference) =>
        reference.reference.kind !== 'resource' &&
        !reference.insertions?.length &&
        !existing.some(
          (token) =>
            token.referenceKey === inlineReferenceKey(reference.reference),
        ),
    );
    if (!missing.length) return;
    let next = content;
    const positions = new Map<
      string,
      { start: number; end: number; text: string }
    >();
    for (const reference of missing) {
      const token = inlineReferenceMarker(reference.label, reference.reference);
      if (next && !/\s$/.test(next)) next += ' ';
      positions.set(reference.id, {
        start: next.length,
        end: next.length + token.length,
        text: token,
      });
      next += token + ' ';
    }
    setContent(next);
    setReferences((previous) =>
      previous.map((reference) =>
        positions.has(reference.id)
          ? { ...reference, insertions: [positions.get(reference.id)!] }
          : reference,
      ),
    );
  }, [references, content]);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const candidatesControl = useRef<WorkspaceInlineCandidatesHandle | null>(
    null,
  );
  const codeReads = useRef(new Set<string>());
  const draftGenerations = useRef(new Map<string, number>());
  const stream = useAiTask(taskId);
  const sendTimings = useRef(
    new Map<string, { submittedAt: number; acceptedAt: number }>(),
  );
  const currentSendTiming = taskId
    ? sendTimings.current.get(taskId)
    : undefined;
  const automaticTitleTaskId = stream.events.findLast(
    (event) => event.type === 'task.finished',
  )?.payload.automaticTitleTaskId;
  const pendingRefreshCount = stream.events.filter(
    (event) =>
      event.type === 'ai.tool' &&
      (event.payload.confirmationId || event.payload.externalInvocationId),
  ).length;
  const model = models.find(
    (entry) =>
      entry.modelEntryId === selectedModelId &&
      entry.modelServiceId === selection?.modelServiceId,
  );
  const active = detail?.conversation ?? null;
  const scroll = useWorkspaceScroll(activeId);
  const mention = composing ? null : composerTrigger(content, caret);
  const mentionKey = mention
    ? `${mention.symbol}:${mention.start}:${mention.end}:${mention.query}`
    : null;
  const codedReference =
    mention?.symbol === '@' ? decodeConversationReference(mention.query) : null;
  const codePrepared = Boolean(
    codedReference &&
    references.some(
      (entry) =>
        entry.reference.kind === 'conversation' &&
        entry.reference.conversationId === codedReference.conversationId,
    ),
  );
  const candidateOpen = Boolean(
    mention &&
    (accessMode === 'full' || mention.symbol === '/') &&
    dismissedCandidate !== mentionKey &&
    !codePrepared,
  );
  const currentGroup = sidebar?.groups.find(
    (group) => group.requirementId === active?.requirementId,
  );
  const welcomeRequirement = active?.requirementId
    ? (currentGroup?.alias ??
      currentGroup?.generatedName ??
      currentGroup?.formalTitle ??
      active.requirementTitle)
    : null;
  const taskMatches = stream.task?.id === taskId;
  const messageForTask = detail?.messages.findLast(
    (entry) => entry.role === 'assistant' && entry.taskId === taskId,
  );
  const inFlight = Boolean(
    taskId &&
    (taskMatches
      ? !stream.terminal
      : messageForTask
        ? ['queued', 'streaming'].includes(messageForTask.status)
        : true),
  );
  const contextCollapsible = Boolean(
    activeId &&
    (conversationLoading ||
      !active ||
      active.id !== activeId ||
      taskId ||
      detail?.messages.length ||
      (sendPreview?.conversationId === activeId && sendPreview.userMessageId)),
  );
  useEffect(() => {
    if (contextCollapsible) {
      setProjectPickerOpen(false);
      setAssociateOpen(false);
    }
  }, [contextCollapsible]);
  const latestAssistant = detail?.messages.findLast(
    (entry) => entry.role === 'assistant',
  );
  const replyCompleted = taskMatches
    ? stream.task?.status === 'completed' &&
      stream.task.messageStatus === 'completed'
    : taskId
      ? messageForTask?.status === 'completed'
      : latestAssistant?.status === 'completed';
  const jumpMode =
    creating || sending || uncertain || conversationLoading || inFlight
      ? 'generating'
      : replyCompleted
        ? 'completed'
        : 'idle';
  const selectionCurrent = Boolean(
    model?.available && model.serviceRevision === selectedRevision,
  );
  const targetProject = me.projects.find(
    (entry) => entry.id === targetProjectId,
  );
  const composerScope = activeId ?? newDraftKey(targetProjectId);
  useEffect(() => {
    if (
      conversationLoading ||
      (activeId && detail?.conversation.id !== activeId)
    )
      return;
    const selected =
      selectedReferenceHistory.current.get(composerScope) ??
      new Map<string, PreparedReference>();
    for (const reference of references)
      selected.set(inlineReferenceKey(reference.reference), reference);
    selectedReferenceHistory.current.set(composerScope, selected);
  }, [
    composerScope,
    references,
    conversationLoading,
    activeId,
    detail?.conversation.id,
  ]);
  const restoredTarget =
    draftTarget?.ownerId === me.user.id && draftTarget.scope === composerScope
      ? draftTarget
      : null;
  const currentOperationTarget: OperationTarget | null =
    accessMode === 'full' ? operationTargetFor(targetProjectId, active) : null;
  const hasRestoredTargetDifference = Boolean(
    restoredTarget &&
    JSON.stringify(restoredTarget.value) !==
      JSON.stringify(currentOperationTarget),
  );
  const unresolvedCreates = createAttempts.filter(
    (attempt) => attempt.state === 'unknown',
  );
  function refreshCreateAttempts() {
    try {
      setCreateAttempts(pendingConversationCreates(me.user.id));
      setCreateRecoveryError(undefined);
    } catch (error) {
      setCreateRecoveryError(describeError(error));
    }
  }
  useEffect(() => {
    refreshCreateAttempts();
    const changed = () => refreshCreateAttempts();
    window.addEventListener(conversationCreateChanged, changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener(conversationCreateChanged, changed);
      window.removeEventListener('storage', changed);
    };
  }, [me.user.id]);

  async function loadSidebar(signal?: AbortSignal, silent = false) {
    const requestedProjectId = browseRef.current;
    const epoch = ++sidebarEpoch.current;
    if (!silent) setSideLoading(true);
    try {
      const response = await api(
        `/me/conversations/sidebar${requestedProjectId ? `?projectId=${requestedProjectId}` : ''}`,
        signal ? { signal } : {},
        conversationSidebarSchema,
      );
      if (
        !signal?.aborted &&
        epoch === sidebarEpoch.current &&
        requestedProjectId === browseRef.current
      ) {
        setSidebar(response);
        const listed = [
          ...response.recent,
          ...response.pinned.map(
            ({ parentHidden: _parentHidden, ...entry }) => entry,
          ),
          ...response.groups.flatMap((group) => group.conversations),
        ].find((entry) => entry.id === activeRef.current);
        if (listed)
          setDetail((previous) =>
            previous?.conversation.id === listed.id &&
            BigInt(listed.rowVersion) >=
              BigInt(previous.conversation.rowVersion)
              ? { ...previous, conversation: listed }
              : previous,
          );
        setSideError(undefined);
      }
    } catch (error) {
      if (
        !signal?.aborted &&
        epoch === sidebarEpoch.current &&
        requestedProjectId === browseRef.current
      ) {
        if (!silent) setSidebar(null);
        setSideError(describeError(error));
      }
    } finally {
      if (!signal?.aborted && epoch === sidebarEpoch.current)
        setSideLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = () => {
      if (refreshing || document.visibilityState !== 'visible') return;
      refreshing = true;
      void loadSidebar(controller.signal, true).finally(() => {
        refreshing = false;
      });
    };
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [me.user.id]);
  useEffect(() => {
    if (taskMatches) void loadSidebar(undefined, true);
  }, [stream.task?.id, stream.task?.status, taskMatches]);
  useEffect(() => {
    if (!automaticTitleTaskId) return;
    const controller = new AbortController();
    const deadline = Date.now() + 120_000;
    let timer: number | undefined;
    const poll = async () => {
      if (controller.signal.aborted || currentIdentityOwner() !== me.user.id)
        return;
      if (Date.now() >= deadline) {
        void loadSidebar(controller.signal, true);
        return;
      }
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => void poll(), 1500);
        return;
      }
      try {
        const { task } = await api(
          `/me/auxiliary-tasks/${automaticTitleTaskId}`,
          { signal: controller.signal },
          auxiliaryTaskReceiptSchema,
        );
        if (controller.signal.aborted || currentIdentityOwner() !== me.user.id)
          return;
        if (['accepted', 'running', 'cancelling'].includes(task.state))
          timer = window.setTimeout(() => void poll(), 1000);
        else await loadSidebar(controller.signal, true);
      } catch {
        if (!controller.signal.aborted && currentIdentityOwner() === me.user.id)
          setSideError('自动标题状态暂未读到，当前名称已保留。');
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [automaticTitleTaskId, me.user.id]);
  async function loadModels(signal?: AbortSignal) {
    const ownerId = me.user.id;
    setModelLoading(true);
    try {
      const response = await api(
        '/model-services',
        signal ? { signal } : {},
        modelsSchema,
      );
      if (!signal?.aborted && currentIdentityOwner() === ownerId) {
        setModels(response.models);
        setModelPreference(
          restoreWorkspaceModelPreference(ownerId, response.models),
        );
        setModelError(undefined);
      }
    } catch (error) {
      if (!signal?.aborted) {
        setModels([]);
        setModelError(describeError(error));
      }
    } finally {
      if (!signal?.aborted) setModelLoading(false);
    }
  }
  async function loadConversation(id: string, signal?: AbortSignal) {
    const epoch = ++conversationEpoch.current;
    setConversationLoading(true);
    setConversationError(undefined);
    try {
      const response = await api(
        `/me/conversations/${id}`,
        signal ? { signal } : {},
        conversationDetailSchema,
      );
      if (
        !signal?.aborted &&
        epoch === conversationEpoch.current &&
        activeRef.current === id
      ) {
        setDetail(response);
        const last = response.messages.findLast(
          (item) => item.role === 'assistant' && item.taskId !== null,
        );
        setTaskId(last?.taskId ?? null);
        const draft = drafts.current.get(id);
        restoreDraftTarget(id, draft);
        if (draft) {
          setContent(draft.content);
          setReferences(draft.references);
        } else {
          setContent('');
          setReferences([]);
        }
      }
    } catch (error) {
      if (!signal?.aborted && epoch === conversationEpoch.current) {
        setDetail(null);
        setTaskId(null);
        setConversationError(describeError(error));
      }
    } finally {
      if (!signal?.aborted && epoch === conversationEpoch.current)
        setConversationLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    groupEpoch.current += 1;
    setSidebar(null);
    setRestoreOpen(false);
    setAssociateOpen(false);
    setGroupCandidates([]);
    setGroupError(undefined);
    setGroupLoading(false);
    void loadSidebar(controller.signal);
    return () => controller.abort();
  }, [project?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setModels([]);
    setModelPreference(null);
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [me.user.id]);
  useEffect(
    () =>
      onPersonalContentChanged((change) => {
        void loadSidebar();
        if (change.type === 'conversationDeleted') {
          drafts.current.delete(change.conversationId);
          uncertainSends.current.delete(change.conversationId);
          if (activeRef.current === change.conversationId) {
            conversationNavigation.current += 1;
            conversationEpoch.current += 1;
            activeRef.current = null;
            setActiveId(null);
            setDetail(null);
            setTaskId(null);
            setContent('');
            setReferences([]);
            setUncertain(null);
            setConversationError(undefined);
            setSendError(undefined);
            window.location.hash = 'workspace';
          }
        } else if (change.type === 'conversationRestored') {
          if (activeRef.current === change.conversationId)
            void loadConversation(change.conversationId);
        } else if (change.type === 'resourceDeleted') {
          const mark = (items: PreparedReference[]) =>
            items.map((reference) =>
              reference.reference.kind === 'resource' &&
              reference.reference.resourceId === change.resourceId
                ? {
                    ...reference,
                    label: '已删除的个人资源（占位）',
                    note: '原资源已永久删除，不能再次读取；请明确重新选择有效资料。',
                  }
                : reference,
            );
          for (const [key, draft] of drafts.current)
            drafts.current.set(key, {
              ...draft,
              references: mark(draft.references),
            });
          setReferences(mark);
          if (activeRef.current) void loadConversation(activeRef.current);
        }
      }),
    [me.user.id],
  );
  useEffect(() => {
    activeRef.current = activeId;
    setProjectPickerOpen(false);
    setAssociateOpen(false);
    candidateInsertion.current = null;
    setDismissedCandidate(null);
    setReferenceOpen(false);
    setUncertain(
      activeId ? (uncertainSends.current.get(activeId) ?? null) : null,
    );
    if (!activeId) {
      conversationEpoch.current += 1;
      setDetail(null);
      setTaskId(null);
      setConversationError(undefined);
      const draft = drafts.current.get(newDraftKey(browseRef.current));
      restoreDraftTarget(newDraftKey(browseRef.current), draft);
      setContent(draft?.content ?? '');
      setReferences(draft?.references ?? []);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setTaskId(null);
    setSendError(undefined);
    void loadConversation(activeId, controller.signal);
    return () => controller.abort();
  }, [activeId]);
  useEffect(() => {
    const changed = () => {
      if (
        window.location.hash.replace(/^#\/?/, '').split('?')[0] !== 'workspace'
      )
        return;
      const id = conversationFromUrl();
      if (id !== activeRef.current) {
        conversationNavigation.current += 1;
        saveDraft();
        activeRef.current = id;
        setActiveId(id);
      }
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [content, references, draftTarget, composerSkills]);
  useEffect(() => {
    if (currentIdentityOwner() !== me.user.id) return;
    if (
      activeId &&
      detail?.conversation.id === activeId &&
      !conversationLoading
    )
      saveWorkspaceDraft(drafts.current, activeId, composerDraft());
    else if (!activeId) {
      const timer = window.setTimeout(() => {
        if (!activeRef.current && browseRef.current === targetProjectId)
          saveWorkspaceDraft(
            drafts.current,
            newDraftKey(targetProjectId),
            composerDraft(),
          );
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [
    activeId,
    content,
    references,
    detail?.conversation.id,
    conversationLoading,
    targetProjectId,
    draftTarget,
    composerSkills,
  ]);

  function composerDraft(): Draft {
    return {
      content,
      references,
      ...(restoredTarget ? { operationTarget: restoredTarget.value } : {}),
      ...(composerSkills.length ? { skillIds: composerSkills } : {}),
    };
  }
  function restoreDraftTarget(scope: string, draft: Draft | undefined) {
    setComposerSkills(draft?.skillIds ?? []);
    setDraftTarget(
      draft && 'operationTarget' in draft
        ? { ownerId: me.user.id, scope, value: draft.operationTarget ?? null }
        : null,
    );
  }
  function replaceDraftGeneration(scope: string) {
    selectedReferenceHistory.current.delete(scope);
    draftGenerations.current.set(
      scope,
      (draftGenerations.current.get(scope) ?? 0) + 1,
    );
  }
  function promoteCreatedDraft(conversationId: string, draft: Draft) {
    for (const scope of promoteWorkspaceDraft(
      drafts.current,
      conversationId,
      draft,
    ))
      replaceDraftGeneration(scope);
  }
  function saveDraft() {
    if (currentIdentityOwner() !== me.user.id) return;
    saveWorkspaceDraft(
      drafts.current,
      activeRef.current ?? newDraftKey(browseRef.current),
      composerDraft(),
    );
  }
  function changeProject(id: string | null) {
    setDraftTarget(null);
    if (!activeRef.current) {
      saveDraft();
      const next = drafts.current.get(newDraftKey(id));
      restoreDraftTarget(newDraftKey(id), next);
      setContent(next?.content ?? '');
      setReferences(next?.references ?? []);
      candidateInsertion.current = null;
    }
    onProjectChange(id);
  }
  function openConversation(id: string) {
    conversationNavigation.current += 1;
    saveDraft();
    candidateInsertion.current = null;
    activeRef.current = id;
    setActiveId(id);
    window.location.hash = `workspace?conversationId=${id}`;
  }
  function currentConversationIsEmpty() {
    return Boolean(
      !conversationLoading &&
      detail?.conversation.id === activeRef.current &&
      detail.messages.length === 0 &&
      !detail.conversation.activeTaskStatus &&
      !taskIdentity.current &&
      !(
        sendPreview?.conversationId === activeRef.current &&
        sendPreview.userMessageId
      ),
    );
  }
  function openNewDraft() {
    if (!activeRef.current || currentConversationIsEmpty()) return;
    if (detail?.conversation.id === activeRef.current && !conversationLoading)
      saveDraft();
    conversationNavigation.current += 1;
    conversationEpoch.current += 1;
    activeRef.current = null;
    setActiveId(null);
    setDetail(null);
    setTaskId(null);
    setConversationLoading(false);
    setConversationError(undefined);
    setSendError(undefined);
    setUncertain(null);
    setSendPreview(null);
    candidateInsertion.current = null;
    setDismissedCandidate(null);
    setReferenceOpen(false);
    setActiveCandidateId(undefined);
    const scope = newDraftKey(browseRef.current);
    const draft = drafts.current.get(scope);
    setContent(draft?.content ?? '');
    setReferences(draft?.references ?? []);
    restoreDraftTarget(scope, draft);
    setCaret(draft?.content.length ?? 0);
    window.location.hash = 'workspace';
  }
  function openReferences(tab: ReferenceTab) {
    if (accessMode === 'restricted') return;
    setReferenceTab(tab);
    setReferenceOpen(true);
    insertCandidateSymbol('@');
  }
  function insertCandidateSymbol(symbol: '@' | '/') {
    const start = input.current?.selectionStart ?? content.length;
    const before = content.slice(0, start),
      after = content.slice(input.current?.selectionEnd ?? start);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const value = `${before}${prefix}${symbol}${after}`,
      cursor = before.length + prefix.length + 1;
    updateComposerContent(value);
    candidateInsertion.current = {
      start,
      end: cursor,
      text: `${prefix}${symbol}`,
      restoreText: content.slice(start, input.current?.selectionEnd ?? start),
    };
    setCaret(cursor);
    setDismissedCandidate(null);
    window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(cursor, cursor);
    });
  }
  function openSkills() {
    setReferenceOpen(false);
    insertCandidateSymbol('/');
  }
  function closeCandidates(selected = false) {
    const insertion = candidateInsertion.current;
    candidateInsertion.current = null;
    if (
      !selected &&
      insertion &&
      content.slice(insertion.start, insertion.end) === insertion.text
    ) {
      const value =
        content.slice(0, insertion.start) +
        (insertion.restoreText ?? '') +
        content.slice(insertion.end);
      updateComposerContent(value);
      setCaret(insertion.start);
    }
    setDismissedCandidate(mentionKey);
    setReferenceOpen(false);
    setActiveCandidateId(undefined);
  }
  function selectReference(reference: PreparedReference) {
    if (references.length >= 30) return;
    const start =
      mention?.start ?? input.current?.selectionStart ?? content.length;
    const end = mention?.end ?? input.current?.selectionEnd ?? start;
    const marker = inlineReferenceMarker(reference.label, reference.reference);
    const prepared = {
      ...reference,
      insertions: [{ start, end: start + marker.length, text: marker }],
    };
    if (mention) {
      const text = content.slice(0, start) + marker + ' ' + content.slice(end);
      const nextCaret = start + marker.length + 1;
      updateComposerContent(text);
      setCaret(nextCaret);
      window.requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(nextCaret, nextCaret);
      });
    } else {
      updateComposerContent(
        content.slice(0, start) + marker + ' ' + content.slice(end),
      );
      setCaret(start + marker.length + 1);
      window.requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(
          start + marker.length + 1,
          start + marker.length + 1,
        );
      });
    }
    setReferences((previous) => {
      const old = previous.find(
        (item) =>
          JSON.stringify(item.reference) === JSON.stringify(prepared.reference),
      );
      return old
        ? previous.map((item) =>
            item.id === old.id
              ? {
                  ...item,
                  insertions: [
                    ...(item.insertions ?? []),
                    ...(prepared.insertions ?? []),
                  ],
                }
              : item,
          )
        : [...previous, prepared];
    });
    closeCandidates(true);
  }
  function selectSkill(skillId: PlatformGuidanceSkillId) {
    if (!mention || mention.symbol !== '/') return;
    const marker = inlineSkillMarker(skillId) + ' ';
    const text =
      content.slice(0, mention.start) + marker + content.slice(mention.end);
    const nextCaret = mention.start + marker.length;
    updateComposerContent(text);
    setCaret(nextCaret);
    window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(nextCaret, nextCaret);
    });
    closeCandidates(true);
  }
  function updateComposerContent(value: string) {
    const before = composerContent.current;
    composerContent.current = value;
    candidateInsertion.current = candidateInsertion.current
      ? moveInsertion(before, value, candidateInsertion.current)
      : null;
    setReferences((previous) => {
      const tokens = parseInlineComposerTokens(value);
      const nextReferences = previous.flatMap((reference) => {
        const next = {
          ...reference,
          insertions: (reference.insertions ?? []).flatMap((insertion) => {
            const updated = moveInsertion(before, value, insertion);
            return updated ? [updated] : [];
          }),
        };
        return reference.reference.kind !== 'resource' &&
          reference.insertions?.length &&
          !tokens.some(
            (token) =>
              token.referenceKey === inlineReferenceKey(reference.reference),
          )
          ? []
          : [next];
      });
      // Undo restores only references explicitly selected in this draft scope.
      // The server still freezes them using the current actor and permissions.
      const prior = selectedReferenceHistory.current.get(composerScope);
      for (const token of tokens) {
        if (
          !token.referenceKey ||
          nextReferences.some(
            (item) => inlineReferenceKey(item.reference) === token.referenceKey,
          )
        )
          continue;
        const remembered = prior?.get(token.referenceKey);
        if (remembered && nextReferences.length < 30)
          nextReferences.push({
            ...remembered,
            insertions: [
              { start: token.start, end: token.end, text: token.raw },
            ],
          });
      }
      return nextReferences;
    });
    setContent(value);
  }
  function removeReference(reference: PreparedReference) {
    const removed = removeInsertions(content, reference.insertions ?? []);
    updateComposerContent(removed.text);
    setReferences((previous) =>
      previous.filter((entry) => entry.id !== reference.id),
    );
  }
  async function prepareReferenceCode(text: string) {
    if (accessMode === 'restricted') return;
    const codes = [
      ...new Set(text.match(/\bATHC1-[a-f0-9]{32}\b/gi) ?? []),
    ].slice(0, 30 - references.length);
    const draftId = activeRef.current ?? newDraftKey(browseRef.current),
      epoch = identityContextEpoch(),
      generation = draftGenerations.current.get(draftId) ?? 0;
    for (const code of codes) {
      const decoded = decodeConversationReference(code);
      if (!decoded || decoded.conversationId === activeRef.current) continue;
      const key = `${draftId}:${generation}:${code.toLowerCase()}`;
      if (codeReads.current.has(key)) continue;
      codeReads.current.add(key);
      try {
        const response = await api(
          `/me/conversations/${decoded.conversationId}/reference`,
          {},
          conversationMutationSchema,
        );
        if (
          epoch !== identityContextEpoch() ||
          generation !== (draftGenerations.current.get(draftId) ?? 0)
        )
          return;
        const prepared: PreparedReference = {
          id: crypto.randomUUID(),
          label: response.conversation.alias ?? response.conversation.title,
          reference: { ...decoded, dataScope },
          note: '已准备完整会话引用；发送时按当前权限读取，编码不授予访问权限。',
        };
        if (
          mounted.current &&
          (activeRef.current ?? newDraftKey(browseRef.current)) === draftId
        ) {
          const materialized = replaceConversationReferenceCode(
            composerContent.current,
            code,
            inlineReferenceMarker(prepared.label, prepared.reference),
          );
          if (!materialized.insertions.length) continue;
          prepared.insertions = materialized.insertions;
          updateComposerContent(materialized.text);
          setReferences((previous) =>
            previous.some(
              (item) =>
                item.reference.kind === 'conversation' &&
                item.reference.conversationId === decoded.conversationId,
            ) || previous.length >= 30
              ? previous
              : [...previous, prepared],
          );
          const trigger = composerTrigger(text, text.length);
          if (
            trigger?.symbol === '@' &&
            trigger.query.toLowerCase() === code.toLowerCase()
          ) {
            setDismissedCandidate(
              `@:${trigger.start}:${trigger.end}:${trigger.query}`,
            );
            setReferenceOpen(false);
            setActiveCandidateId(undefined);
          }
        } else {
          const old = drafts.current.get(draftId) ?? {
            content: '',
            references: [],
            targetProjectId: null,
          };
          if (old.references.length < 30) {
            const materialized = replaceConversationReferenceCode(
              old.content,
              code,
              inlineReferenceMarker(prepared.label, prepared.reference),
            );
            if (!materialized.insertions.length) continue;
            drafts.current.set(draftId, {
              ...old,
              content: materialized.text,
              references: [
                ...old.references,
                { ...prepared, insertions: materialized.insertions },
              ],
            });
          }
        }
      } catch (error) {
        if (
          epoch === identityContextEpoch() &&
          generation === (draftGenerations.current.get(draftId) ?? 0)
        )
          setSendError(`会话引用未准备：${describeError(error)}`);
      }
    }
  }
  function attachFiles(files: readonly File[]) {
    if (references.length + uploading.length + files.length > 30) {
      setSendError('每条消息最多30个引用，请减少文件后再选择。');
      return;
    }
    for (const file of files) void attach(file);
  }
  async function createConversation(
    group?: Pick<RequirementGroup, 'projectId' | 'requirementId'>,
  ): Promise<Conversation | null> {
    if (creatingRef.current) return null;
    creatingRef.current = true;
    const epoch = identityContextEpoch(),
      navigation = conversationNavigation.current,
      browsing = browseGeneration.current,
      previousId = activeRef.current;
    const current = () =>
      mounted.current &&
      epoch === identityContextEpoch() &&
      currentIdentityOwner() === me.user.id;
    const currentView = () =>
      current() &&
      navigation === conversationNavigation.current &&
      browsing === browseGeneration.current &&
      previousId === activeRef.current;
    setCreating(true);
    setPending(true);
    setSideError(undefined);
    let attempt: ConversationCreateAttempt | undefined;
    try {
      attempt = prepareConversationCreate(me.user.id);
      if (!previousId)
        creationDrafts.current.set(
          attempt.commandId,
          saveWorkspaceDraft(
            drafts.current,
            newDraftKey(browseRef.current),
            composerDraft(),
          ),
        );
      const response = await dispatchConversationCreate(attempt, {
        useDefaultTarget: !group,
        ...(group
          ? { projectId: group.projectId, requirementId: group.requirementId }
          : {}),
      });
      const draft = creationDrafts.current.get(attempt.commandId);
      if (current() && draft && !drafts.current.has(response.conversation.id))
        drafts.current.set(response.conversation.id, draft);
      creationDrafts.current.delete(attempt.commandId);
      if (!currentView()) {
        if (current() && draft)
          promoteCreatedDraft(response.conversation.id, draft);
        return null;
      }
      if (response.notice)
        void message.info(
          '最近使用的需求已不可用，已建立个人对话；请重新核对归属和操作目标。',
        );
      openConversation(response.conversation.id);
      if (draft) promoteCreatedDraft(response.conversation.id, draft);
      const openedNavigation = conversationNavigation.current;
      await loadSidebar();
      if (
        !current() ||
        activeRef.current !== response.conversation.id ||
        conversationNavigation.current !== openedNavigation ||
        browsing !== browseGeneration.current
      )
        return null;
      return response.conversation;
    } catch (error) {
      if (attempt && !isUncertainMutationError(error))
        creationDrafts.current.delete(attempt.commandId);
      if (currentView()) setSendError(describeError(error));
      return null;
    } finally {
      creatingRef.current = false;
      setCreating(false);
      setPending(false);
      if (current()) refreshCreateAttempts();
    }
  }
  async function recoverCreatedConversation(
    attempt: ConversationCreateAttempt,
  ) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    const epoch = identityContextEpoch(),
      navigation = conversationNavigation.current,
      browsing = browseGeneration.current;
    try {
      const response = await recoverConversationCreate(attempt);
      if (
        !mounted.current ||
        epoch !== identityContextEpoch() ||
        currentIdentityOwner() !== me.user.id
      )
        return;
      const draft = creationDrafts.current.get(attempt.commandId);
      if (draft && !drafts.current.has(response.conversation.id))
        drafts.current.set(response.conversation.id, draft);
      creationDrafts.current.delete(attempt.commandId);
      if (
        navigation === conversationNavigation.current &&
        browsing === browseGeneration.current
      ) {
        openConversation(response.conversation.id);
        if (draft) promoteCreatedDraft(response.conversation.id, draft);
        setSendError('原对话已找回；本条消息尚未发送，请重新检查并确认发送。');
      }
      await loadSidebar();
    } catch (error) {
      if (
        epoch === identityContextEpoch() &&
        currentIdentityOwner() === me.user.id
      )
        setCreateRecoveryError(
          error instanceof ApiError && error.status === 404
            ? '当前尚未查到原创建回执，不代表没有创建。请保留原标识继续只读查询，不换标识重复创建。'
            : describeError(error),
        );
    } finally {
      creatingRef.current = false;
      setCreating(false);
      if (
        epoch === identityContextEpoch() &&
        currentIdentityOwner() === me.user.id
      ) {
        try {
          setCreateAttempts(pendingConversationCreates(me.user.id));
        } catch (error) {
          setCreateRecoveryError(describeError(error));
        }
      }
    }
  }
  async function updateConversation(
    conversation: Conversation,
    change: { pinned?: boolean; archived?: boolean; alias?: string | null },
  ) {
    const result = await api(
      `/me/conversations/${conversation.id}`,
      {
        method: 'PUT',
        body: {
          commandId: crypto.randomUUID(),
          rowVersion: conversation.rowVersion,
          ...change,
        },
      },
      conversationMutationSchema,
    );
    if (activeRef.current === conversation.id)
      setDetail((previous) =>
        previous?.conversation.id === conversation.id
          ? { ...previous, conversation: result.conversation }
          : previous,
      );
    await loadSidebar();
  }
  async function updateGroup(
    group: Pick<RequirementGroup, 'projectId' | 'requirementId' | 'rowVersion'>,
    change: {
      pinned?: boolean;
      alias?: string | null;
      archived?: boolean;
      hidden?: boolean;
      expanded?: boolean;
      sortOrder?: number;
    },
    refresh = true,
  ) {
    await api(
      `/me/requirement-groups/${group.projectId}/${group.requirementId}`,
      {
        method: 'PUT',
        body: {
          commandId: crypto.randomUUID(),
          rowVersion: group.rowVersion,
          ...change,
        },
      },
      requirementGroupMutationSchema,
    );
    if (refresh) await loadSidebar();
  }
  async function conversationAction(
    conversation: Conversation,
    action: ConversationAction,
    trigger?: HTMLElement,
  ) {
    if (action === 'copyReference' || action === 'exportMarkdown') {
      setPending(true);
      const epoch = identityContextEpoch();
      try {
        if (action === 'copyReference') {
          const result = await api(
            `/me/conversations/${conversation.id}/reference`,
            {},
            conversationMutationSchema,
          );
          const code = encodeConversationReference(result.conversation.id);
          if (identityContextEpoch() !== epoch) return;
          try {
            await navigator.clipboard.writeText(code);
          } catch {
            if (identityContextEpoch() === epoch)
              modal.info({
                title: '复制深度链接',
                className: 'workspace-code-copy',
                width: 520,
                centered: true,
                icon: null,
                content: (
                  <Input
                    readOnly
                    value={code}
                    aria-label="会话引用编码"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                ),
                okText: '关闭',
              });
            return;
          }
          if (identityContextEpoch() === epoch)
            void message.success('已复制会话引用编码，可粘贴到其他本人对话。');
        } else await downloadConversationMarkdown(conversation.id);
      } catch (error) {
        if (identityContextEpoch() === epoch)
          void message.error(describeError(error));
      } finally {
        setPending(false);
      }
      return;
    }
    if (action === 'edit') {
      const selector = `${trigger?.closest('.conversation-header') ? '.conversation-header' : '.workspace-sidebar'} [data-conversation-menu="${conversation.id}"]`;
      aliasReturnFocus.current = () => {
        const destination = trigger?.isConnected
          ? trigger
          : document.querySelector<HTMLElement>(selector);
        destination?.focus();
      };
      aliasForm.setFieldsValue({
        alias: conversation.alias ?? conversation.title,
      });
      setAliasError(undefined);
      setAliasTarget({ type: 'conversation', conversation });
      return;
    }
    setPending(true);
    try {
      await updateConversation(
        conversation,
        action === 'pin'
          ? { pinned: !conversation.pinnedAt }
          : { archived: true },
      );
      if (
        action === 'pin' &&
        conversation.pinnedAt &&
        conversation.requirementId
      )
        void message.info(
          '已取消置顶，归属保持；可通过需求栏添加入口找回隐藏或归档分组。',
        );
    } catch (error) {
      setSideError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  async function groupAction(
    group: RequirementGroup,
    action: GroupAction,
    trigger?: HTMLElement,
  ) {
    if (action === 'edit') {
      aliasReturnFocus.current = () => {
        const destination = trigger?.isConnected
          ? trigger
          : document.querySelector<HTMLElement>(
              `[data-requirement-menu="${group.requirementId}"]`,
            );
        destination?.focus();
      };
      aliasForm.setFieldsValue({
        alias: group.alias ?? group.generatedName ?? group.formalTitle,
      });
      setAliasError(undefined);
      setAliasTarget({ type: 'group', group });
      return;
    }
    setPending(true);
    try {
      await updateGroup(
        group,
        action === 'pin'
          ? { pinned: !group.pinnedAt }
          : action === 'archive'
            ? { archived: true }
            : { hidden: true },
      );
    } catch (error) {
      setSideError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  async function toggleGroup(group: RequirementGroup) {
    setPending(true);
    try {
      await updateGroup(group, { expanded: !group.expanded });
    } catch (error) {
      setSideError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  async function moveGroup(
    group: RequirementGroup,
    destination: RequirementGroup,
  ) {
    const ordered = sidebar?.groups.filter((entry) => !entry.pinnedAt) ?? [];
    const from = ordered.findIndex(
      (entry) => entry.requirementId === group.requirementId,
    );
    const to = ordered.findIndex(
      (entry) => entry.requirementId === destination.requirementId,
    );
    if (from < 0 || to < 0) return;
    const [moving] = ordered.splice(from, 1);
    if (!moving) return;
    ordered.splice(to, 0, moving);
    setPending(true);
    const results = await Promise.allSettled(
      ordered.map((entry, index) =>
        updateGroup(entry, { sortOrder: (index + 1) * 100 }, false),
      ),
    );
    const failures = results.filter((entry) => entry.status === 'rejected');
    await loadSidebar();
    if (failures.length)
      setSideError(
        `排序部分保存：${results.length - failures.length} 项成功，${failures.length} 项冲突或未完成，请刷新后重试受影响项。`,
      );
    setPending(false);
  }
  async function restoreCandidates(showRestore = true) {
    const epoch = ++groupEpoch.current;
    if (showRestore) setRestoreOpen(true);
    const requestedProjectId = browseRef.current;
    setGroupCandidates([]);
    setGroupError(undefined);
    setGroupLoading(true);
    if (!requestedProjectId) {
      setGroupError('先在输入框上方选择这个项目。');
      setGroupLoading(false);
      return;
    }
    try {
      const response = await api(
        `/me/requirement-groups/candidates?projectId=${requestedProjectId}`,
        {},
        requirementGroupCandidatesSchema,
      );
      if (
        epoch === groupEpoch.current &&
        requestedProjectId === browseRef.current
      )
        setGroupCandidates(response.groups);
    } catch (error) {
      if (
        epoch === groupEpoch.current &&
        requestedProjectId === browseRef.current
      )
        setGroupError(describeError(error));
    } finally {
      if (
        epoch === groupEpoch.current &&
        requestedProjectId === browseRef.current
      )
        setGroupLoading(false);
    }
  }
  async function saveAlias(values: { alias: string }) {
    if (!aliasTarget) return;
    setPending(true);
    setAliasError(undefined);
    try {
      if (aliasTarget.type === 'conversation')
        await updateConversation(aliasTarget.conversation, {
          alias: values.alias,
        });
      else await updateGroup(aliasTarget.group, { alias: values.alias });
      setAliasTarget(null);
    } catch (error) {
      setAliasError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  async function restoreDefaultAlias() {
    if (!aliasTarget || pending) return;
    setPending(true);
    setAliasError(undefined);
    try {
      if (aliasTarget.type === 'conversation')
        await updateConversation(aliasTarget.conversation, { alias: null });
      else await updateGroup(aliasTarget.group, { alias: null });
      setAliasTarget(null);
    } catch (error) {
      setAliasError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  async function loadOlder() {
    if (!activeId || !detail?.nextMessageCursor) return;
    const id = activeId;
    try {
      const response = await api(
        `/me/conversations/${id}?before=${detail.nextMessageCursor}&limit=50`,
        {},
        conversationDetailSchema,
      );
      if (activeRef.current === id)
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                messages: [
                  ...response.messages.filter(
                    (entry) =>
                      !previous.messages.some(
                        (current) => current.id === entry.id,
                      ),
                  ),
                  ...previous.messages,
                ],
                nextMessageCursor: response.nextMessageCursor,
              }
            : previous,
        );
    } catch (error) {
      setConversationError(describeError(error));
    }
  }
  async function attach(file: File) {
    if (accessMode === 'restricted') {
      void message.info('切换完全访问后可添加文件或引用。');
      return;
    }
    const draftId = activeRef.current ?? newDraftKey(browseRef.current);
    const attachmentEpoch = identityContextEpoch();
    const id = crypto.randomUUID();
    setUploading((previous) => [
      ...previous,
      { id, name: file.name, state: '完整上传/校验中' },
    ]);
    try {
      const resource = await uploadPersonalFile(file, id);
      if (
        attachmentEpoch !== identityContextEpoch() ||
        currentIdentityOwner() !== me.user.id
      )
        return;
      const prepared: PreparedReference = {
        id,
        label: resource.originalName,
        reference: {
          kind: 'resource',
          resourceId: resource.id,
          dataScope: 'syntheticPublicOnly',
        },
        note: '字节已验证；正文尚未读取，解析以平台回执为准',
      };
      if (
        mounted.current &&
        (activeRef.current ?? newDraftKey(browseRef.current)) === draftId
      )
        setReferences((previous) => [...previous, prepared]);
      else {
        const previous = drafts.current.get(draftId) ?? {
          content: '',
          references: [],
          targetProjectId: null,
        };
        drafts.current.set(draftId, {
          ...previous,
          references: [...previous.references, prepared],
        });
        if (mounted.current)
          void message.info('附件已上传，引用保留在原草稿。');
      }
      setUploading((previous) => previous.filter((entry) => entry.id !== id));
    } catch (error) {
      setUploading((previous) =>
        previous.map((entry) =>
          entry.id === id
            ? { ...entry, state: '上传未完成', error: describeError(error) }
            : entry,
        ),
      );
    }
  }
  useEffect(() => {
    const accepted = (event: Event) => {
      const parsed = z
        .object({
          ownerId: z.string(),
          conversationId: z.string(),
          receipt: z.object({ taskId: z.string() }),
        })
        .safeParse(event instanceof CustomEvent ? event.detail : undefined);
      if (
        !parsed.success ||
        parsed.data.ownerId !== me.user.id ||
        currentIdentityOwner() !== me.user.id ||
        activeRef.current !== parsed.data.conversationId
      )
        return;
      const id = parsed.data.conversationId;
      setTaskId(parsed.data.receipt.taskId);
      void api(`/me/conversations/${id}`, {}, conversationDetailSchema)
        .then((result) => {
          if (
            mounted.current &&
            activeRef.current === id &&
            currentIdentityOwner() === me.user.id
          )
            setDetail(result);
        })
        .catch((error) => {
          if (mounted.current) setSendError(describeError(error));
        });
      void loadSidebar(undefined, true);
    };
    window.addEventListener('aitesthub:queued-message-accepted', accepted);
    return () =>
      window.removeEventListener('aitesthub:queued-message-accepted', accepted);
  }, [me.user.id]);
  async function submitMessage(
    destination?: Conversation,
    intent: 'normal' | 'interrupt' = sendMode === 'steer'
      ? 'interrupt'
      : 'normal',
  ) {
    const sendEpoch = identityContextEpoch();
    if (currentIdentityOwner() !== me.user.id) return;
    if (
      Boolean(targetProjectId && !targetProject) ||
      (!content.trim() && !composerSkills.length) ||
      sending ||
      uncertain ||
      creatingRef.current ||
      sendDispatchInProgress.current ||
      pending
    )
      return;
    if (model && effort && !model.effortValues.includes(effort)) {
      setSendError('所选模型不支持当前参数，请重新选择。');
      setModelPickerOpen(true);
      return;
    }
    const resolved = await resolveComposerDestination({
      activeId: destination?.id ?? activeRef.current,
      conversation:
        destination ??
        (detail?.conversation.id === activeRef.current
          ? detail.conversation
          : null),
      model,
      selectionCurrent,
      create: () => createConversation(),
    });
    if (resolved.state !== 'ready') {
      setSendError(resolved.reason);
      if (resolved.state === 'needsModel') setModelPickerOpen(true);
      return;
    }
    const active = resolved.conversation;
    if (
      !mounted.current ||
      sendEpoch !== identityContextEpoch() ||
      currentIdentityOwner() !== me.user.id ||
      !model ||
      active.id !== activeRef.current
    )
      return;
    if (sendDispatchInProgress.current) return;
    sendDispatchInProgress.current = true;
    setSending(true);
    setSendError(undefined);
    const commandId = crypto.randomUUID();
    const submittedDraft = composerDraft();
    drafts.current.set(active.id, submittedDraft);
    try {
      const payload = sendMessageInputSchema.parse({
        commandId,
        content: serializeComposerSkills(composerSkills, content),
        modelSelection: {
          modelServiceId: model.modelServiceId,
          modelEntryId: model.modelEntryId,
          serviceRevision: model.serviceRevision,
          ...(effort !== null ? { effort } : {}),
        },
        dataScope,
        accessMode,
        references: (accessMode === 'full' ? references : []).map((entry) => ({
          ...entry.reference,
          dataScope,
        })),
        operationTarget: resolveWorkspaceDraftTarget(
          submittedDraft,
          accessMode,
          operationTargetFor(targetProjectId, active),
        ),
      });
      if (inFlight || (pendingMessages.state?.items.length ?? 0) > 0) {
        if (!pendingMessages.controller)
          throw new Error(pendingMessages.error ?? '待发队列暂时不可用。');
        const blockingTaskId =
          taskIdentity.current ??
          detail?.messages.find(
            (entry) =>
              entry.taskId &&
              entry.taskStatus &&
              ['accepted', 'running', 'cancelling'].includes(entry.taskStatus),
          )?.taskId ??
          null;
        if (inFlight && !blockingTaskId)
          throw new Error(
            '正在核对当前回复的任务标识，草稿已保留，请稍后加入队列。',
          );
        pendingMessages.controller.enqueue(
          active.id,
          payload,
          (targetProject?.name ?? '个人对话') +
            ' · ' +
            modelDisplayLabel(model) +
            ' · ' +
            (accessMode === 'full' ? '完全访问' : '受限访问'),
          blockingTaskId,
          intent === 'interrupt',
          { references: accessMode === 'full' ? references : [] },
        );
        const clearComposer = clearSubmittedDraft(
          drafts.current,
          active.id,
          submittedDraft,
        );
        if (clearComposer) replaceDraftGeneration(active.id);
        if (clearComposer && activeRef.current === active.id) {
          setDraftTarget(null);
          setContent('');
          setReferences([]);
          setComposerSkills([]);
        }
        return;
      }
      setSendPreview({
        conversationId: active.id,
        content: payload.content,
        references: payload.references.map((reference) => ({ reference })),
        userMessageId: null,
        createdAt: new Date().toISOString(),
      });
      const unresolved: UncertainSend = {
        conversationId: active.id,
        commandId,
        input: payload,
        draft: submittedDraft,
      };
      try {
        const submittedAt = performance.now();
        const result = await api(
          `/me/conversations/${active.id}/messages`,
          { method: 'POST', body: payload },
          taskAcceptedSchema,
        );
        if (
          sendEpoch === identityContextEpoch() &&
          currentIdentityOwner() === me.user.id
        )
          rememberWorkspaceModelSelection(me.user.id, payload.modelSelection);
        sendTimings.current.set(result.taskId, {
          submittedAt,
          acceptedAt: performance.now(),
        });
        const clearComposer = clearSubmittedDraft(
          drafts.current,
          active.id,
          submittedDraft,
        );
        if (clearComposer) replaceDraftGeneration(active.id);
        uncertainSends.current.delete(active.id);
        if (mounted.current && activeRef.current === active.id) {
          if (clearComposer) {
            setDraftTarget(null);
            setContent('');
            setReferences([]);
            setComposerSkills([]);
          }
          setTaskId(result.taskId);
          setSendPreview({
            conversationId: active.id,
            content: payload.content,
            references: payload.references.map((reference) => ({ reference })),
            userMessageId: result.userMessageId,
            createdAt: new Date().toISOString(),
          });
        }
        try {
          const response = await api(
            `/me/conversations/${active.id}`,
            {},
            conversationDetailSchema,
          );
          if (activeRef.current === active.id) {
            setDetail(response);
            setUncertain(null);
            setSendPreview(null);
          }
        } catch (error) {
          if (activeRef.current === active.id)
            setConversationError(
              `消息已受理，当前历史读取未完成：${describeError(error)}`,
            );
        }
        await loadSidebar();
      } catch (error) {
        if (isUncertainMutationError(error)) {
          uncertainSends.current.set(active.id, unresolved);
          if (activeRef.current === active.id) setUncertain(unresolved);
        } else if (activeRef.current === active.id) setSendPreview(null);
        throw error;
      }
    } catch (error) {
      if (activeRef.current === active.id)
        setSendError(
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join('；')
            : describeError(error),
        );
    } finally {
      sendDispatchInProgress.current = false;
      setSending(false);
    }
  }
  function changeSendMode(mode: WorkspaceSendMode) {
    try {
      saveWorkspaceSendMode(me.user.id, mode);
      setSendModePreference({ ownerId: me.user.id, mode });
      setSendModeError(undefined);
    } catch {
      setSendModeError('发送偏好未能保存，原发送模式保持不变。');
    }
  }
  function editQueuedMessage(item: WorkspaceQueuedMessage) {
    const conversationId = activeRef.current;
    const epoch = identityContextEpoch();
    const restore = () => {
      if (
        !conversationId ||
        activeRef.current !== conversationId ||
        currentIdentityOwner() !== me.user.id ||
        identityContextEpoch() !== epoch ||
        creatingRef.current ||
        sendDispatchInProgress.current ||
        sending ||
        uncertain ||
        uploading.some((entry) => !entry.error)
      )
        throw new Error('当前草稿或身份已变化，请保留原队列并稍后重试。');
      const originalTarget = item.input.operationTarget?.projectId ?? null;
      if (
        originalTarget &&
        !me.projects.some((entry) => entry.id === originalTarget)
      )
        throw new Error('原消息的目标项目已不可访问，队列和当前草稿已保留。');
      const restored = pendingMessages.controller?.takeForEditing(
        conversationId,
        item.input.commandId,
      );
      if (!restored)
        throw new Error('这条消息已开始受理或不在队列中，请核对原回执。');
      const restoredReferences =
        restored.display?.references ??
        restored.input.references.map((reference, index) => ({
          id: `queued:${restored.input.commandId}:${index}`,
          label: reference.kind === 'resource' ? '已选附件' : '已选引用',
          note: '从排队消息恢复，发送时重新校验当前权限。',
          reference,
        }));
      const draft = {
        content: restored.input.content,
        references: restoredReferences,
        operationTarget: restored.input.operationTarget,
      };
      replaceDraftGeneration(conversationId);
      saveWorkspaceDraft(drafts.current, conversationId, draft);
      restoreDraftTarget(conversationId, draft);
      setContent(draft.content);
      setReferences(draft.references);
      const restoredAccess = restored.input.accessMode ?? 'restricted';
      setAccessMode(restoredAccess);
      saveWorkspaceAccess(me.user.id, restoredAccess);
      setModelPreference({
        schemaVersion: 'ath.workspace-model-preference.v1',
        ownerId: me.user.id,
        ...restored.input.modelSelection,
        effort: restored.input.modelSelection.effort ?? null,
      });
      if (restoredAccess === 'full') onProjectChange(originalTarget);
      candidateInsertion.current = null;
      closeCandidates();
      setCaret(draft.content.length);
      setSendError(undefined);
      requestAnimationFrame(() => {
        if (
          activeRef.current === conversationId &&
          currentIdentityOwner() === me.user.id &&
          identityContextEpoch() === epoch
        )
          input.current?.focus();
      });
    };
    if (
      content ||
      composerSkills.length ||
      references.length ||
      uploading.length
    ) {
      modal.confirm({
        className: 'workspace-queue-edit-confirm',
        title: '替换当前输入并编辑排队消息？',
        content:
          '输入框中已有未发送草稿。确认后会用这条排队消息的文字、附件和发送设置替换；取消将保留当前草稿和原队列。',
        okText: '替换并编辑',
        cancelText: '保留当前草稿',
        zIndex: uiLayers.confirmation,
        onOk: () => {
          try {
            restore();
          } catch (error) {
            void message.warning(describeError(error));
            return Promise.reject(error);
          }
        },
      });
    } else restore();
  }
  async function recoverSend() {
    if (!uncertain) return;
    const sendEpoch = identityContextEpoch();
    setSending(true);
    try {
      const receipt = await readWorkspaceSendReceipt(
        me.user.id,
        uncertain.conversationId,
        uncertain.commandId,
      );
      if (
        sendEpoch === identityContextEpoch() &&
        currentIdentityOwner() === me.user.id
      )
        rememberWorkspaceModelSelection(
          me.user.id,
          uncertain.input.modelSelection,
        );
      const clearComposer = clearSubmittedDraft(
        drafts.current,
        uncertain.conversationId,
        uncertain.draft,
      );
      if (clearComposer) replaceDraftGeneration(uncertain.conversationId);
      uncertainSends.current.delete(uncertain.conversationId);
      if (activeRef.current === uncertain.conversationId) {
        setTaskId(receipt.receipt.taskId);
        if (clearComposer) {
          setDraftTarget(null);
          setContent('');
          setReferences([]);
          setComposerSkills([]);
        }
        setUncertain(null);
        const result = await api(
          `/me/conversations/${uncertain.conversationId}`,
          {},
          conversationDetailSchema,
        );
        if (activeRef.current === uncertain.conversationId) {
          setDetail(result);
          setSendError(undefined);
        }
      }
    } catch (error) {
      setSendError(
        error instanceof ApiError && error.status === 404
          ? '当前尚未查到本次回执，不代表消息未受理。请保留本次标识继续查询，不能换新标识重复发送。'
          : describeError(error),
      );
    } finally {
      setSending(false);
    }
  }
  async function stopReply() {
    if (!taskId) return;
    setSending(true);
    try {
      await api(
        `/me/ai-tasks/${taskId}/cancel`,
        { method: 'POST', body: { commandId: crypto.randomUUID() } },
        cancelReceiptSchema,
      );
      stream.reconnect();
    } catch (error) {
      setSendError(describeError(error));
    } finally {
      setSending(false);
    }
  }
  async function associate(associationId: string) {
    if (
      !active ||
      active.id !== activeRef.current ||
      conversationLoading ||
      active.requirementId ||
      !project ||
      !associationId
    )
      return;
    const epoch = conversationEpoch.current;
    const isCurrentConversation = () =>
      activeRef.current === active.id && conversationEpoch.current === epoch;
    const isCurrentPicker = () =>
      isCurrentConversation() && browseRef.current === project.id;
    setPending(true);
    setAssociationError(undefined);
    try {
      const response = await api(
        `/me/conversations/${active.id}/associate`,
        {
          method: 'POST',
          body: {
            commandId: crypto.randomUUID(),
            rowVersion: active.rowVersion,
            projectId: project.id,
            requirementId: associationId,
          },
        },
        conversationMutationSchema,
      );
      if (isCurrentConversation()) {
        setDraftTarget(null);
        setDetail((previous) =>
          previous?.conversation.id === active.id
            ? { ...previous, conversation: response.conversation }
            : previous,
        );
      }
      if (isCurrentPicker()) setAssociateOpen(false);
      await loadSidebar();
    } catch (error) {
      if (isCurrentPicker()) setAssociationError(describeError(error));
    } finally {
      setPending(false);
    }
  }
  function prepareContinuation() {
    const request =
      '请继续上次未完成的回答，不要重复执行已经完成或结果未知的业务操作。';
    const value = content.trim() ? `${content}\n${request}` : request;
    updateComposerContent(value);
    window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(value.length, value.length);
    });
  }
  function prepareScenes() {
    const template =
      '请根据我明确引用的资料梳理测试场景，区分 UI 与接口范围，并说明证据缺口。';
    const value = content.trim()
      ? `${content}${content.endsWith('\n') ? '' : '\n'}${template}`
      : template;
    updateComposerContent(value);
    window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(value.length, value.length);
    });
  }
  function keyboardCard(
    event: { key: string; preventDefault: () => void },
    action: () => void,
  ) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  }

  const sidebarNavigation = (
    <WorkspaceSidebar
      projects={me.projects}
      projectName={project?.name ?? null}
      notificationBell={notificationBell}
      restorePicker={{
        open: restoreOpen,
        onOpenChange: (value) => {
          if (value) void restoreCandidates();
          else setRestoreOpen(false);
        },
        candidates: groupCandidates,
        loading: groupLoading,
        ...(groupError ? { error: groupError } : {}),
        onRestore: (group) => {
          setPending(true);
          void updateGroup(group, { hidden: false, archived: false })
            .then(() => setRestoreOpen(false))
            .catch((error) => setGroupError(describeError(error)))
            .finally(() => setPending(false));
        },
      }}
      displayName={me.user.displayName}
      sidebar={sidebar}
      loading={sideLoading}
      error={sideError}
      pending={pending}
      selectedId={activeId}
      onCreate={(group) => {
        setNavigationOpen(false);
        if (!group) openNewDraft();
        else if (!(
          currentConversationIsEmpty() &&
          active?.requirementId === group.requirementId &&
          active.projectId === group.projectId
        ))
          void createConversation(group);
      }}
      onOpen={(id) => {
        setNavigationOpen(false);
        openConversation(id);
      }}
      onConversationAction={(conversation, action, trigger) =>
        void conversationAction(conversation, action, trigger)
      }
      onGroupAction={(group, action, trigger) =>
        void groupAction(group, action, trigger)
      }
      onToggleGroup={(group) => void toggleGroup(group)}
      onMoveGroup={(group, destination) => void moveGroup(group, destination)}
      onRestoreGroups={() => void restoreCandidates()}
      onSettings={onSettings}
    />
  );
  return (
    <div className="workspace-shell">
      {compactNavigation ? (
        <Drawer
          title="本人对话与项目"
          placement="left"
          className="workspace-mobile-drawer"
          width={272}
          zIndex={uiLayers.drawer}
          open={navigationOpen}
          onClose={() => setNavigationOpen(false)}
          destroyOnHidden
          styles={{ body: { padding: 0 } }}
        >
          {sidebarNavigation}
        </Drawer>
      ) : (
        sidebarNavigation
      )}
      <section className="workspace-chat-main">
        <header className="conversation-header">
          {compactNavigation && (
            <Button
              type="text"
              className="iconbtn"
              aria-label="打开对话列表"
              aria-expanded={navigationOpen}
              icon={<AppIcon name="panel" />}
              onClick={() => setNavigationOpen(true)}
            />
          )}
          <div className="chat-title-context">
            <div className="row wrap">
              <h2>{active ? (active.alias ?? active.title) : '新对话'}</h2>
              {active?.archivedAt && <Tag>已归档，新增消息需先恢复</Tag>}
            </div>
          </div>
          <Space className="chat-head-actions">
            {active ? (
              <AgentWorkspace key={active.id} conversationId={active.id} />
            ) : (
              <Button
                icon={<FileSearchOutlined />}
                aria-label="文件中心"
                onClick={() => setFileCenterOpen(true)}
              />
            )}
            <FileCenter
              key={me.user.id}
              open={fileCenterOpen}
              onClose={() => setFileCenterOpen(false)}
            />
            <AppearanceToggle
              dark={dark}
              pending={appearancePending}
              onToggle={onAppearance}
            />
            {active ? (
              <ConversationMenu
                conversation={active}
                onAction={(conversation, action, trigger) =>
                  void conversationAction(conversation, action, trigger)
                }
                disabled={pending}
                label="当前对话更多"
              />
            ) : (
              <Dropdown
                trigger={['click']}
                classNames={{ root: 'user-workspace-sidebar-menu' }}
                menu={{
                  items: [
                    { key: 'new', label: '新聊天' },
                    {
                      key: 'preferences',
                      label: '个人设置',
                      icon: <AppIcon name="settings" />,
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'new') openNewDraft();
                    else onSettings();
                  },
                }}
              >
                <Button
                  type="text"
                  className="iconbtn"
                  icon={<AppIcon name="more" />}
                  aria-label="新对话更多"
                />
              </Dropdown>
            )}
          </Space>
        </header>
        <div className="conversation-scroll" ref={scroll.viewport} tabIndex={0}>
          <div ref={scroll.content} className="conversation-content">
            {conversationLoading && <Skeleton active paragraph={{ rows: 5 }} />}
            {conversationError && (
              <Alert type="error" title={conversationError} showIcon />
            )}
            {(!active || detail?.messages.length === 0) &&
              !conversationLoading &&
              !conversationError && (
                <div className="welcome-content welcome">
                  <img
                    src="/brand-f-mono.png"
                    className="welcome-brand brand-mono"
                    alt="AITestHub F 标志"
                  />
                  <h1>
                    {welcomeRequirement ? (
                      <>
                        你想让我们在{' '}
                        <span className="welcome-requirement-name">
                          {welcomeRequirement}
                        </span>{' '}
                        中构建什么？
                      </>
                    ) : (
                      '我们要构建什么？'
                    )}
                  </h1>
                  <p>从一个问题开始，让测试的下一步更清晰。</p>
                  <div className="welcome-cards">
                    <button
                      type="button"
                      className="welcome-card"
                      aria-label="梳理测试场景，准备任务"
                      onKeyDown={(event) => keyboardCard(event, prepareScenes)}
                      onClick={prepareScenes}
                    >
                      <AppIcon name="check" />
                      <span>梳理测试场景</span>
                    </button>
                    <button
                      type="button"
                      className="welcome-card"
                      aria-label="用Skill开始任务，查看候选"
                      onKeyDown={(event) => keyboardCard(event, openSkills)}
                      onClick={openSkills}
                    >
                      <AppIcon name="spark" />
                      <span>用 Skill 开始任务</span>
                    </button>
                    <button
                      type="button"
                      className="welcome-card"
                      aria-label="引用已有知识，选择候选"
                      onKeyDown={(event) =>
                        keyboardCard(event, () => openReferences('knowledge'))
                      }
                      onClick={() => openReferences('knowledge')}
                    >
                      <AppIcon name="book" />
                      <span>引用已有知识</span>
                    </button>
                  </div>
                </div>
              )}
            {detail?.nextMessageCursor && (
              <Button onClick={() => void loadOlder()}>
                加载更早的本人消息
              </Button>
            )}
            {detail?.messages.map((entry) => {
              const sendTiming = entry.taskId
                ? sendTimings.current.get(entry.taskId)
                : undefined;
              if (entry.role === 'assistant' && entry.taskId)
                return (
                  <Fragment key={entry.id}>
                    <WorkspaceTurn
                      key={entry.id}
                      taskId={entry.taskId}
                      current={entry.taskId === taskId}
                      stream={stream}
                      fallbackText={entry.content}
                      messageStatus={entry.status}
                      {...(entry.taskStatus !== undefined
                        ? { taskStatus: entry.taskStatus }
                        : {})}
                      {...(entry.taskNotices
                        ? { taskNotices: entry.taskNotices }
                        : {})}
                      caption={<ModelCaption message={entry} />}
                      {...(sendTiming ? { sendTiming } : {})}
                      onProposals={() => setProposalTaskId(entry.taskId)}
                      {...(entry.taskId === taskId && inFlight
                        ? { onStop: () => void stopReply() }
                        : {})}
                      {...(entry.taskId === taskId
                        ? { onContinue: prepareContinuation }
                        : {})}
                    />
                    {activeId ? (
                      <ConversationActionCards
                        conversationId={activeId}
                        taskId={entry.taskId}
                        messageId={entry.id}
                        refreshKey={pendingRefreshCount}
                        onResolved={stream.reconnect}
                      />
                    ) : null}
                    {activeId ? (
                      <ExternalMcpInvocationsPanel
                        inline
                        taskId={entry.taskId}
                        conversationId={activeId}
                        hideEmpty
                        refreshKey={`${entry.taskId}:${pendingRefreshCount}`}
                        onResolved={stream.reconnect}
                      />
                    ) : null}
                  </Fragment>
                );
              return (
                <article
                  className={`chat-message ${entry.role}`}
                  key={entry.id}
                >
                  <header className="workspace-message-sender">
                    <img src="/brand-f-color.png" alt="" />
                    <strong>
                      {entry.role === 'user' ? me.user.displayName : 'AI 回复'}
                    </strong>
                    <time
                      dateTime={entry.createdAt}
                      title={new Date(entry.createdAt).toLocaleString('zh-CN')}
                    >
                      {new Date(entry.createdAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </time>
                  </header>
                  <WorkspaceMessageReferences
                    references={entry.references.filter(
                      (item) =>
                        !isInlineMessageReference(
                          entry.content,
                          item.reference,
                        ),
                    )}
                  />
                  <MessageText
                    text={entry.content}
                    references={entry.references}
                  />
                </article>
              );
            })}
            {sendPreview &&
              sendPreview.conversationId === activeId &&
              !detail?.messages.some(
                (entry) => entry.id === sendPreview.userMessageId,
              ) && (
                <article className="chat-message user pending-user-message">
                  <header className="workspace-message-sender">
                    <img src="/brand-f-color.png" alt="" />
                    <strong>{me.user.displayName}</strong>
                    <time dateTime={sendPreview.createdAt}>
                      {new Date(sendPreview.createdAt).toLocaleTimeString(
                        'zh-CN',
                        { hour: '2-digit', minute: '2-digit', hour12: false },
                      )}
                    </time>
                  </header>
                  <WorkspaceMessageReferences
                    references={sendPreview.references.filter(
                      (item) =>
                        !isInlineMessageReference(
                          sendPreview.content,
                          item.reference,
                        ),
                    )}
                  />
                  <MessageText
                    text={sendPreview.content}
                    references={sendPreview.references}
                  />
                  <p className="caption" role="status">
                    {sendPreview.userMessageId
                      ? '消息已受理，正在读取记录'
                      : uncertain
                        ? '发送回执待核对'
                        : '正在发送'}
                  </p>
                </article>
              )}
            {taskId &&
              !detail?.messages.some((entry) => entry.taskId === taskId) && (
                <Fragment>
                  <WorkspaceTurn
                    taskId={taskId}
                    current
                    stream={stream}
                    fallbackText=""
                    messageStatus={stream.task?.messageStatus ?? 'queued'}
                    {...(currentSendTiming
                      ? { sendTiming: currentSendTiming }
                      : {})}
                    onProposals={() => setProposalTaskId(taskId)}
                    {...(inFlight ? { onStop: () => void stopReply() } : {})}
                    onContinue={prepareContinuation}
                  />
                  {activeId ? (
                    <ConversationActionCards
                      conversationId={activeId}
                      taskId={taskId}
                      refreshKey={pendingRefreshCount}
                      onResolved={stream.reconnect}
                    />
                  ) : null}
                  {activeId ? (
                    <ExternalMcpInvocationsPanel
                      inline
                      taskId={taskId}
                      conversationId={activeId}
                      hideEmpty
                      refreshKey={`${taskId}:${pendingRefreshCount}`}
                      onResolved={stream.reconnect}
                    />
                  ) : null}
                </Fragment>
              )}
            <AutomaticAuxiliaryPanel
              projectId={project?.id ?? null}
              refreshKey={
                sidebar?.groups.map((group) => group.requirementId).join('|') ??
                ''
              }
              onNamesChanged={() => void loadSidebar(undefined, true)}
            />
          </div>
          {scroll.away && (
            <WorkspaceJumpLatest mode={jumpMode} onJump={scroll.jump} />
          )}
        </div>
        <div
          className="workspace-composer composer-wrap user-composer"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files'))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              attachFiles([...event.dataTransfer.files]);
            }
          }}
        >
          <WorkspaceContextDrawer expanded={!contextCollapsible}>
            <div className="composer-context-bar">
              <WorkspaceContextPicker
                open={projectPickerOpen}
                onOpenChange={setProjectPickerOpen}
                selectedId={project?.id ?? ''}
                placeholder="搜索项目"
                options={[
                  { id: '', label: '不在项目中工作' },
                  ...me.projects.map((entry) => ({
                    id: entry.id,
                    label: entry.name,
                  })),
                ]}
                onChoose={(id) => {
                  changeProject(id || null);
                  setProjectPickerOpen(false);
                }}
              >
                <Button
                  type="text"
                  className="composer-project-context"
                  disabled={creating || sending || Boolean(uncertain)}
                  title={project?.name ?? '不在项目'}
                  aria-label={'切换全站项目：' + (project?.name ?? '不在项目')}
                >
                  <ProjectOutlined />
                  <span className="composer-project-name">
                    {project?.name ?? '不在项目'}
                  </span>
                  <AppIcon name="down" />
                </Button>
              </WorkspaceContextPicker>
              <WorkspaceContextPicker
                open={associateOpen}
                onOpenChange={(value) => {
                  setAssociateOpen(value);
                  if (value) {
                    setAssociationError(undefined);
                    void restoreCandidates(false);
                  }
                }}
                selectedId={active?.requirementId ?? ''}
                placeholder="搜索需求"
                loading={groupLoading}
                error={associationError ?? groupError}
                emptyText={
                  project ? '当前没有本人参与的需求' : '先选择这个项目'
                }
                caption={
                  active?.requirementId
                    ? '当前对话已关联，既有归属保持不变。'
                    : '选择后关联本对话；不会改动已发任务。'
                }
                options={[
                  {
                    id: '',
                    label: '不关联需求',
                    disabled: Boolean(active?.requirementId),
                  },
                  ...(active?.requirementId &&
                  !groupCandidates.some(
                    (group) => group.requirementId === active.requirementId,
                  )
                    ? [
                        {
                          id: active.requirementId,
                          label: active.requirementTitle ?? '当前需求',
                        },
                      ]
                    : []),
                  ...groupCandidates.map((group) => ({
                    id: group.requirementId,
                    label:
                      group.alias ?? group.generatedName ?? group.formalTitle,
                    description: group.formalTitle,
                    disabled: Boolean(
                      active?.requirementId &&
                      active.requirementId !== group.requirementId,
                    ),
                  })),
                ]}
                onChoose={(id) => {
                  if (!id || id === active?.requirementId) {
                    setAssociateOpen(false);
                    return;
                  }
                  const selected = groupCandidates.find(
                    (group) => group.requirementId === id,
                  );
                  if (!selected) return;
                  if (!active) {
                    void createConversation(selected).then((created) => {
                      if (created) setAssociateOpen(false);
                    });
                  } else void associate(id);
                }}
              >
                <Button
                  type="text"
                  className="composer-requirement-context"
                  icon={<AppIcon name="folder-closed" />}
                  disabled={pending || sending || conversationLoading}
                  title={
                    currentGroup?.formalTitle ??
                    active?.requirementTitle ??
                    '选择需求'
                  }
                  aria-label="选择当前对话需求"
                >
                  {currentGroup?.alias ??
                    currentGroup?.generatedName ??
                    currentGroup?.formalTitle ??
                    active?.requirementTitle ??
                    '未关联需求'}
                  <AppIcon name="down" />
                </Button>
              </WorkspaceContextPicker>
            </div>
          </WorkspaceContextDrawer>
          <WorkspacePendingMessages
            state={pendingMessages.state}
            queue={pendingMessages.controller}
            taskId={taskId}
            mode={sendMode}
            onModeChange={changeSendMode}
            onEdit={editQueuedMessage}
          />
          <div className="composer user-composer-anchor">
            {pendingMessages.error && (
              <Alert type="warning" showIcon title={pendingMessages.error} />
            )}
            {sendModeError && (
              <Alert type="warning" showIcon title={sendModeError} />
            )}
            {hasRestoredTargetDifference && (
              <p className="caption composer-restored-target" role="status">
                本条消息沿用排队时的项目与需求范围。
                <Button
                  type="link"
                  size="small"
                  onClick={() => setDraftTarget(null)}
                >
                  使用当前项目与需求
                </Button>
              </p>
            )}
            {candidateOpen &&
              mention &&
              (accessMode === 'full' || mention.symbol === '/') && (
                <WorkspaceInlineCandidates
                  ref={candidatesControl}
                  trigger={mention.symbol}
                  query={mention.query}
                  projectId={project?.id ?? null}
                  projects={me.projects}
                  remaining={30 - references.length}
                  dataScope={dataScope}
                  {...(activeId ? { currentConversationId: activeId } : {})}
                  {...(referenceOpen ? { filter: referenceTab } : {})}
                  onAdd={selectReference}
                  onSkill={selectSkill}
                  onClose={closeCandidates}
                  onActiveDescendantChange={setActiveCandidateId}
                />
              )}
            {sendError && (
              <Alert
                type="error"
                showIcon
                title={sendError}
                className="section-alert"
              />
            )}
            {(createRecoveryError || unresolvedCreates.length > 0) && (
              <Alert
                type="warning"
                showIcon
                className="section-alert"
                title="本人对话创建回执待核对；本条消息尚未发送"
                description={
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {createRecoveryError && <span>{createRecoveryError}</span>}
                    <span>
                      只读查询原创建，不换标识再建。找回后请重新检查草稿并确认发送。
                    </span>
                    {unresolvedCreates.map((attempt) => (
                      <Button
                        key={attempt.commandId}
                        size="small"
                        loading={creating}
                        onClick={() => void recoverCreatedConversation(attempt)}
                      >
                        只读找回原对话 · {attempt.commandId}
                      </Button>
                    ))}
                  </Space>
                }
              />
            )}
            {uncertain && (
              <Alert
                type="warning"
                showIcon
                title={`本次发送回执尚未确认：${uncertain.commandId}`}
                action={
                  <Button loading={sending} onClick={() => void recoverSend()}>
                    查询同一次发送
                  </Button>
                }
              />
            )}
            {modelError && <Alert type="error" title={modelError} showIcon />}
            {selectedModelId && !selectionCurrent && (
              <Alert
                type="warning"
                title="模型配置已变化，请重新选择本条消息的模型。"
                showIcon
              />
            )}
            <WorkspaceComposerReferences
              refs={references.filter(
                (reference) =>
                  reference.reference.kind === 'resource' ||
                  !parseInlineComposerTokens(content).some(
                    (token) =>
                      token.referenceKey ===
                      inlineReferenceKey(reference.reference),
                  ),
              )}
              uploading={uploading}
              disabled={creating || sending}
              accessMode={accessMode}
              onRemove={removeReference}
            />

            <InlineComposer
              key={composerScope}
              ref={input}
              value={content}
              allowedReferences={inlineAllowedReferences}
              disabled={conversationLoading || creating || sending}
              maxLength={100000}
              placeholder={
                active
                  ? '输入消息，@ 引用，/ 选择 Skill'
                  : '输入消息，选择模型后开始新对话'
              }
              aria-controls={
                candidateOpen ? 'workspace-inline-candidates' : undefined
              }
              aria-expanded={candidateOpen}
              aria-activedescendant={
                candidateOpen ? activeCandidateId : undefined
              }
              onChange={(value, selection) => {
                updateComposerContent(value);
                setCaret(selection.start);
                void prepareReferenceCode(value);
              }}
              onSelect={(selection) => setCaret(selection.start)}
              onFocus={() => setDismissedCandidate(null)}
              onBlur={(event) => {
                if (
                  !event.relatedTarget?.closest('.workspace-inline-candidates')
                )
                  closeCandidates();
              }}
              onCompositionStart={() => {
                composition.current = true;
                setComposing(true);
              }}
              onCompositionEnd={() => {
                composition.current = false;
                setComposing(false);
              }}
              onPaste={(event) => {
                if (event.clipboardData.files.length) {
                  event.preventDefault();
                  attachFiles([...event.clipboardData.files]);
                  return;
                }
                void prepareReferenceCode(event.clipboardData.getData('text'));
              }}
              onKeyDown={(event) => {
                if (
                  composition.current ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                if (
                  candidateOpen &&
                  candidatesControl.current?.handleKeyDown(event)
                )
                  return;
                if (
                  candidateOpen &&
                  !candidatesControl.current &&
                  event.key === 'Enter' &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  void submitMessage(
                    undefined,
                    event.ctrlKey || event.metaKey || sendMode === 'steer'
                      ? 'interrupt'
                      : 'normal',
                  );
                }
                if (event.key === '@' || event.key === '/') {
                  setReferenceOpen(false);
                  setDismissedCandidate(null);
                }
              }}
            />
            <input
              hidden
              type="file"
              multiple
              ref={uploadInput}
              aria-label="选择附件文件"
              onChange={(event) => {
                attachFiles([...(event.target.files ?? [])]);
                event.currentTarget.value = '';
              }}
            />
            <div className="composer-toolbar">
              <Space className="composer-primary-controls">
                <Dropdown
                  trigger={['click']}
                  placement="topLeft"
                  classNames={{
                    root: 'user-composer-add-menu user-workspace-sidebar-menu',
                  }}
                  menu={{
                    items: [
                      {
                        key: 'upload',
                        label: '添加文件',
                        icon: <PaperClipOutlined />,
                        disabled: references.length + uploading.length >= 30,
                      },
                      { type: 'divider' },
                      {
                        key: 'history',
                        label: '引用本人对话',
                        icon: <CommentOutlined />,
                      },
                      {
                        key: 'resources',
                        label: '引用已有附件',
                        icon: <FileSearchOutlined />,
                      },
                      {
                        key: 'requirements',
                        label: '引用需求版本',
                        icon: <AppIcon name="file" />,
                      },
                      {
                        key: 'knowledge',
                        label: '引用项目知识',
                        icon: <AppIcon name="book" />,
                      },
                      {
                        key: 'external',
                        label: '引用外部 MCP',
                        icon: <ApiOutlined />,
                      },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'upload') uploadInput.current?.click();
                      else if (
                        key === 'history' ||
                        key === 'resources' ||
                        key === 'requirements' ||
                        key === 'knowledge' ||
                        key === 'external'
                      )
                        openReferences(key);
                    },
                  }}
                >
                  <Button
                    type="text"
                    icon={<PlusOutlined />}
                    aria-label="添加附件或引用"
                    disabled={
                      creating || sending || accessMode === 'restricted'
                    }
                  />
                </Dropdown>
                <WorkspaceAccessPicker
                  mode={accessMode}
                  disabled={creating || sending || Boolean(uncertain)}
                  onChange={(mode) => {
                    setDraftTarget(null);
                    setAccessMode(mode);
                    saveWorkspaceAccess(me.user.id, mode);
                    setSendError(undefined);
                    closeCandidates();
                  }}
                />
              </Space>
              <Space className="composer-model-controls">
                <WorkspaceModelPicker
                  models={models}
                  model={model}
                  effort={effort}
                  open={modelPickerOpen}
                  onOpenChange={setModelPickerOpen}
                  loading={modelLoading}
                  disabled={creating || sending || Boolean(uncertain)}
                  onModel={(selected) => {
                    if (currentIdentityOwner() !== me.user.id) return;
                    setModelPreference((previous) =>
                      chooseWorkspaceModel(me.user.id, selected, previous),
                    );
                  }}
                  onEffort={(next) => {
                    if (currentIdentityOwner() !== me.user.id) return;
                    setModelPreference((previous) =>
                      previous?.ownerId === me.user.id
                        ? { ...previous, effort: next }
                        : previous,
                    );
                  }}
                />
                <WorkspaceSendButton
                  generating={inFlight}
                  hasContent={Boolean(content.trim() || composerSkills.length)}
                  stopping={taskMatches && stream.task?.status === 'cancelling'}
                  mode={sendMode}
                  loading={creating || sending}
                  stopDisabled={
                    sending ||
                    (taskMatches && stream.task?.status === 'cancelling')
                  }
                  sendDisabled={
                    pending ||
                    creating ||
                    sending ||
                    conversationLoading ||
                    Boolean(activeId && !active) ||
                    Boolean(targetProjectId && !targetProject) ||
                    (!content.trim() && !composerSkills.length) ||
                    Boolean(active?.archivedAt) ||
                    Boolean(uncertain) ||
                    Boolean(
                      !activeId &&
                      (unresolvedCreates.length || createRecoveryError),
                    ) ||
                    uploading.some((entry) => !entry.error) ||
                    !model ||
                    !selectionCurrent ||
                    Boolean(
                      (inFlight || pendingMessages.state?.items.length) &&
                      pendingMessages.error,
                    ) ||
                    Boolean(
                      model && effort && !model.effortValues.includes(effort),
                    )
                  }
                  onSend={() => void submitMessage()}
                  onStop={() => void stopReply()}
                />
              </Space>
            </div>
          </div>
        </div>
      </section>
      <Modal
        title="编辑个人显示名称"
        zIndex={uiLayers.dialog}
        afterClose={() => aliasReturnFocus.current?.()}
        open={aliasTarget !== null}
        onCancel={() => setAliasTarget(null)}
        onOk={() => aliasForm.submit()}
        confirmLoading={pending}
        width={610}
        okText="保存名称"
        cancelText="取消"
        destroyOnHidden
      >
        {aliasError && <Alert type="error" title={aliasError} showIcon />}
        {aliasTarget && (
          <Button
            type="link"
            disabled={pending}
            onClick={() => void restoreDefaultAlias()}
          >
            恢复默认名称
          </Button>
        )}
        <Form
          form={aliasForm}
          layout="vertical"
          onFinish={(values: { alias: string }) => void saveAlias(values)}
        >
          <Form.Item
            name="alias"
            label="个人显示名称"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input autoFocus maxLength={200} disabled={pending} />
          </Form.Item>
          {aliasTarget && (
            <AuxiliaryAction
              label="AI 生成精简名"
              source={() =>
                aliasTarget.type === 'conversation'
                  ? {
                      purpose: 'alias',
                      conversationId: aliasTarget.conversation.id,
                      baseRowVersion: aliasTarget.conversation.rowVersion,
                      text: aliasTarget.conversation.title,
                    }
                  : {
                      purpose: 'alias',
                      projectId: aliasTarget.group.projectId,
                      requirementId: aliasTarget.group.requirementId,
                      baseRowVersion: aliasTarget.group.rowVersion,
                      text: aliasTarget.group.formalTitle,
                    }
              }
              onUse={(result) => {
                if (result.purpose === 'alias')
                  aliasForm.setFieldValue('alias', result.suggestedName);
              }}
            />
          )}
        </Form>
        <Typography.Text type="secondary">
          只改本人侧栏显示，不改正式需求名称。
        </Typography.Text>
      </Modal>
      <Modal
        title="本人模型过程与工具回执"
        zIndex={uiLayers.dialog}
        open={proposalTaskId !== null}
        onCancel={() => setProposalTaskId(null)}
        footer={null}
        width={800}
        destroyOnHidden
      >
        {proposalTaskId && (
          <>
            <HistoricalModelTask
              key={`model:${proposalTaskId}`}
              taskId={proposalTaskId}
            />
          </>
        )}
      </Modal>
    </div>
  );
}

function HistoricalModelTask({ taskId }: { taskId: string }) {
  const stream = useAiTask(taskId);
  return (
    <section className="mb">
      <h3>原任务模型过程</h3>
      {stream.error && !stream.retry && (
        <Alert
          type="warning"
          className="section-alert"
          showIcon
          title={stream.error}
        />
      )}
      {stream.retry && (
        <AiRetryStatus
          state={stream.retry}
          onCancel={stream.pause}
          onReconnect={stream.reconnect}
        />
      )}
      {stream.task ? (
        <>
          <p className="caption">
            {taskStateLabels[stream.task.status]} · 原任务 {stream.task.id}
          </p>
          <ModelAttemptFragments task={stream.task} />
          <ModelRetryStatus task={stream.task} />
          {!stream.task.modelAttempts.length && (
            <p className="caption">
              该任务未记录模型尝试分段；不推断旧内容是否发生过重试。
            </p>
          )}
        </>
      ) : (
        !stream.error && <Skeleton active paragraph={{ rows: 2 }} />
      )}
      <Button size="small" onClick={stream.reconnect}>
        只读查询原任务
      </Button>
    </section>
  );
}
