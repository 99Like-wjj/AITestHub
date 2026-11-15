import { useEffect, useRef, useState } from 'react';
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
  ReloadOutlined,
  CommentOutlined,
  ProjectOutlined,
  ApiOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
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
import { BusinessConfirmationsPanel } from './business-confirmations';
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
import {
  composerTrigger,
  insertComposerReference,
  insertComposerSkill,
} from './workspace-trigger';
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
  saveWorkspaceDraft,
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
function MessageText({ text }: { text: string }) {
  return <WorkspaceMarkdown text={text} />;
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
  notificationBell,
  me,
  project,
  onProjectChange,
  onSettings,
}: {
  dark: boolean;
  onAppearance: () => void;
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
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendPreview, setSendPreview] = useState<{
    conversationId: string;
    content: string;
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
  const input = useRef<HTMLTextAreaElement | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const candidatesControl = useRef<WorkspaceInlineCandidatesHandle | null>(
    null,
  );
  const codeReads = useRef(new Set<string>());
  const stream = useAiTask(taskId);
  const sendTimings = useRef(
    new Map<string, { submittedAt: number; acceptedAt: number }>(),
  );
  const currentSendTiming = taskId
    ? sendTimings.current.get(taskId)
    : undefined;
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
  const selectionCurrent = Boolean(
    model?.available && model.serviceRevision === selectedRevision,
  );
  const targetProject = me.projects.find(
    (entry) => entry.id === targetProjectId,
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
  }, [content, references]);
  useEffect(() => {
    if (currentIdentityOwner() !== me.user.id) return;
    if (
      activeId &&
      detail?.conversation.id === activeId &&
      !conversationLoading
    )
      saveWorkspaceDraft(drafts.current, activeId, { content, references });
    else if (!activeId) {
      const timer = window.setTimeout(() => {
        if (!activeRef.current && browseRef.current === targetProjectId)
          saveWorkspaceDraft(drafts.current, newDraftKey(targetProjectId), {
            content,
            references,
          });
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
  ]);

  function saveDraft() {
    if (currentIdentityOwner() !== me.user.id) return;
    saveWorkspaceDraft(
      drafts.current,
      activeRef.current ?? newDraftKey(browseRef.current),
      {
        content,
        references,
      },
    );
  }
  function changeProject(id: string | null) {
    if (!activeRef.current) {
      saveDraft();
      const next = drafts.current.get(newDraftKey(id));
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
    let prepared = reference;
    if (mention) {
      const inserted = insertComposerReference(
        content,
        mention,
        reference.label,
      );
      updateComposerContent(inserted.text);
      prepared = {
        ...reference,
        insertions: [
          {
            start: mention.start,
            end: inserted.caret,
            text: inserted.text.slice(mention.start, inserted.caret),
          },
        ],
      };
      setCaret(inserted.caret);
      window.requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(inserted.caret, inserted.caret);
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
    const inserted = insertComposerSkill(content, mention, skillId);
    updateComposerContent(inserted.text);
    setCaret(inserted.caret);
    window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
    closeCandidates(true);
  }
  function updateComposerContent(value: string) {
    candidateInsertion.current = candidateInsertion.current
      ? moveInsertion(content, value, candidateInsertion.current)
      : null;
    setReferences((previous) =>
      previous.map((reference) => ({
        ...reference,
        insertions: (reference.insertions ?? []).flatMap((insertion) => {
          const updated = moveInsertion(content, value, insertion);
          return updated ? [updated] : [];
        }),
      })),
    );
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
      epoch = identityContextEpoch();
    for (const code of codes) {
      const decoded = decodeConversationReference(code);
      if (!decoded || decoded.conversationId === activeRef.current) continue;
      const key = `${draftId}:${code.toLowerCase()}`;
      if (codeReads.current.has(key)) continue;
      codeReads.current.add(key);
      try {
        const response = await api(
          `/me/conversations/${decoded.conversationId}/reference`,
          {},
          conversationMutationSchema,
        );
        if (epoch !== identityContextEpoch()) return;
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
          if (old.references.length < 30)
            drafts.current.set(draftId, {
              ...old,
              references: [...old.references, prepared],
            });
        }
      } catch (error) {
        if (epoch === identityContextEpoch())
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
        creationDrafts.current.set(attempt.commandId, { content, references });
      const response = await dispatchConversationCreate(attempt, {
        useDefaultTarget: !group,
        ...(group
          ? { projectId: group.projectId, requirementId: group.requirementId }
          : {}),
      });
      const draft = creationDrafts.current.get(attempt.commandId);
      if (current() && draft)
        drafts.current.set(response.conversation.id, draft);
      creationDrafts.current.delete(attempt.commandId);
      if (!currentView()) return null;
      if (response.notice)
        void message.info(
          '最近使用的需求已不可用，已建立个人对话；请重新核对归属和操作目标。',
        );
      openConversation(response.conversation.id);
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
      if (draft) drafts.current.set(response.conversation.id, draft);
      creationDrafts.current.delete(attempt.commandId);
      if (
        navigation === conversationNavigation.current &&
        browsing === browseGeneration.current
      ) {
        openConversation(response.conversation.id);
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
    intent: 'normal' | 'interrupt' = 'normal',
  ) {
    const sendEpoch = identityContextEpoch();
    if (currentIdentityOwner() !== me.user.id) return;
    if (
      Boolean(targetProjectId && !targetProject) ||
      !content.trim() ||
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
    const submittedDraft = { content, references };
    drafts.current.set(active.id, submittedDraft);
    try {
      const payload = sendMessageInputSchema.parse({
        commandId,
        content,
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
        operationTarget:
          accessMode === 'full' && targetProjectId
            ? {
                projectId: targetProjectId,
                ...(targetProjectId === active.projectId && active.requirementId
                  ? { requirementId: active.requirementId }
                  : {}),
              }
            : null,
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
        );
        const clearComposer = clearSubmittedDraft(
          drafts.current,
          active.id,
          submittedDraft,
        );
        if (clearComposer && activeRef.current === active.id) {
          setContent('');
          setReferences([]);
        }
        return;
      }
      setSendPreview({
        conversationId: active.id,
        content,
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
        uncertainSends.current.delete(active.id);
        if (mounted.current && activeRef.current === active.id) {
          if (clearComposer) {
            setContent('');
            setReferences([]);
          }
          setTaskId(result.taskId);
          setSendPreview({
            conversationId: active.id,
            content: payload.content,
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
      uncertainSends.current.delete(uncertain.conversationId);
      if (activeRef.current === uncertain.conversationId) {
        setTaskId(receipt.receipt.taskId);
        if (clearComposer) {
          setContent('');
          setReferences([]);
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
      if (isCurrentConversation())
        setDetail((previous) =>
          previous?.conversation.id === active.id
            ? { ...previous, conversation: response.conversation }
            : previous,
        );
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
            <Button
              type="text"
              className="iconbtn"
              aria-label="全平台外观"
              icon={<AppIcon name={dark ? 'moon' : 'sun'} />}
              onClick={onAppearance}
            />
            {active ? (
              <>
                <Button
                  type="text"
                  className="iconbtn"
                  icon={<ReloadOutlined />}
                  aria-label="刷新当前对话"
                  onClick={() => {
                    saveDraft();
                    void loadConversation(active.id);
                    stream.reconnect();
                  }}
                />
                <ConversationMenu
                  conversation={active}
                  onAction={(conversation, action, trigger) =>
                    void conversationAction(conversation, action, trigger)
                  }
                  disabled={pending}
                  label="当前对话更多"
                />
              </>
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
                    if (key === 'new') void createConversation();
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
        <div
          className="conversation-scroll"
          ref={scroll.viewport}
          onScroll={scroll.onScroll}
        >
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
                  <MessageText text={entry.content} />
                  {!!entry.references.length && (
                    <details className="message-metadata">
                      <summary>发送时引用</summary>
                      <Space wrap>
                        {entry.references.map((reference, index) => (
                          <Tag key={index}>
                            {reference.reference.kind === 'projectAccess'
                              ? '工具来源项目'
                              : reference.reference.kind}
                          </Tag>
                        ))}
                      </Space>
                    </details>
                  )}
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
                  <MessageText text={sendPreview.content} />
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
              )}
            {activeId && (
              <BusinessConfirmationsPanel
                key={`business-pending:${activeId}`}
                conversationId={activeId}
                pendingOnly
                hideEmpty
                refreshKey={pendingRefreshCount}
                onResolved={stream.reconnect}
              />
            )}
            {activeId && (
              <ExternalMcpInvocationsPanel
                key={`external-pending:${activeId}`}
                conversationId={activeId}
                pendingOnly
                hideEmpty
                refreshKey={`${taskId ?? ''}:${pendingRefreshCount}`}
                onResolved={stream.reconnect}
              />
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
            <button
              className="jump-latest"
              type="button"
              onClick={scroll.jump}
              aria-label="回到最新回复"
            >
              ↓ 最新回复
            </button>
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
              emptyText={project ? '当前没有本人参与的需求' : '先选择这个项目'}
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
          <div className="composer user-composer-anchor">
            {pendingMessages.error && (
              <Alert type="warning" showIcon title={pendingMessages.error} />
            )}
            <WorkspacePendingMessages
              state={pendingMessages.state}
              queue={pendingMessages.controller}
              taskId={taskId}
            />
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
            {(references.length > 0 || uploading.length > 0) && (
              <Space wrap className="prepared-references">
                {references.map((reference) => (
                  <Tag key={reference.id} title={reference.note}>
                    {reference.label} ·{' '}
                    {accessMode === 'restricted'
                      ? '受限访问不发送'
                      : '待解析/权限校验'}
                    <button
                      type="button"
                      className="reference-remove"
                      aria-label={`移除引用：${reference.label}`}
                      title={`移除引用：${reference.label}`}
                      disabled={creating || sending}
                      onClick={() => removeReference(reference)}
                    >
                      ×
                    </button>
                  </Tag>
                ))}
                {uploading.map((upload) => (
                  <Tag
                    key={upload.id}
                    color={upload.error ? 'red' : 'default'}
                    title={upload.error}
                  >
                    {upload.name} · {upload.state}
                  </Tag>
                ))}
              </Space>
            )}
            <Input.TextArea
              ref={(value) => {
                input.current = value?.resizableTextArea?.textArea ?? null;
              }}
              aria-label="聊天消息"
              aria-autocomplete="list"
              aria-controls={
                candidateOpen ? 'workspace-inline-candidates' : undefined
              }
              aria-expanded={candidateOpen}
              aria-activedescendant={
                candidateOpen ? activeCandidateId : undefined
              }
              disabled={conversationLoading || creating || sending}
              value={content}
              onChange={(event) => {
                const value = event.target.value;
                updateComposerContent(value);
                setCaret(event.target.selectionStart);
                void prepareReferenceCode(value);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onFocus={(event) => {
                setCaret(event.currentTarget.selectionStart);
                setDismissedCandidate(null);
              }}
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
              onCompositionEnd={(event) => {
                composition.current = false;
                setComposing(false);
                setCaret(event.currentTarget.selectionStart);
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
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  void submitMessage();
                }
                if (event.key === '@' || event.key === '/') {
                  setReferenceOpen(false);
                  setDismissedCandidate(null);
                }
              }}
              autoSize={{ minRows: 3, maxRows: 8 }}
              maxLength={100000}
              placeholder={
                active
                  ? '输入消息，@ 引用，/ 选择 Skill'
                  : '输入消息，选择模型后开始新对话'
              }
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
                {inFlight ? (
                  <>
                    <Button
                      type="text"
                      className="workspace-interrupt-send"
                      disabled={
                        sending ||
                        !content.trim() ||
                        !model ||
                        !selectionCurrent ||
                        Boolean(uncertain) ||
                        Boolean(pendingMessages.error)
                      }
                      onClick={() => void submitMessage(undefined, 'interrupt')}
                    >
                      插队发送
                    </Button>
                    <Button
                      shape="circle"
                      aria-label="加入消息队列"
                      title="加入消息队列"
                      icon={<AppIcon name="send" />}
                      disabled={
                        sending ||
                        !content.trim() ||
                        !model ||
                        !selectionCurrent ||
                        Boolean(uncertain) ||
                        Boolean(pendingMessages.error)
                      }
                      onClick={() => void submitMessage()}
                    />
                    <Button
                      className="send-message-button stop-message-button"
                      shape="circle"
                      type="primary"
                      aria-label={
                        taskMatches && stream.task?.status === 'cancelling'
                          ? '正在停止回复'
                          : '停止回复'
                      }
                      aria-disabled={
                        sending ||
                        (taskMatches && stream.task?.status === 'cancelling')
                      }
                      aria-busy={sending}
                      icon={
                        <span
                          className="composer-stop-square"
                          aria-hidden="true"
                        />
                      }
                      onClick={() => {
                        if (
                          !sending &&
                          !(taskMatches && stream.task?.status === 'cancelling')
                        )
                          void stopReply();
                      }}
                    />
                  </>
                ) : (
                  <Button
                    className="send-message-button"
                    shape="circle"
                    aria-label="发送消息"
                    type="primary"
                    icon={<AppIcon name="send" />}
                    loading={creating || sending}
                    disabled={
                      pending ||
                      conversationLoading ||
                      Boolean(activeId && !active) ||
                      Boolean(targetProjectId && !targetProject) ||
                      !content.trim() ||
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
                        model && effort && !model.effortValues.includes(effort),
                      )
                    }
                    onClick={() => void submitMessage()}
                  />
                )}
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
            <BusinessConfirmationsPanel
              key={`business:${proposalTaskId}`}
              taskId={proposalTaskId}
            />
            <ExternalMcpInvocationsPanel
              key={`external:${proposalTaskId}`}
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
