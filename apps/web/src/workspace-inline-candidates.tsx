import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  BookOutlined,
  FileOutlined,
  HistoryOutlined,
  ApiOutlined,
  FileTextOutlined,
  CodeSandboxOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import {
  historyCandidatesSchema,
  personalResourceListSchema,
} from '../../../packages/contracts/src/conversations';
import { assetNavigationSchema } from '../../../packages/contracts/src/assets';
import { knowledgeIndexResponseSchema } from '../../../packages/contracts/src/knowledge';
import { externalAvailableToolsSchema } from '../../../packages/contracts/src/external-mcp';
import type { ModelDataScope } from '../../../packages/contracts/src/configuration';
import type { PreparedReference, ReferenceTab } from './workspace-references';
import {
  skillGuidanceCatalogSchema,
  platformGuidanceSkillIdSchema,
  type PlatformGuidanceSkillId,
} from '../../../packages/contracts/src/skill-guidance';
import { api, describeError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import {
  inlineCandidateKeyAction,
  moveInlineCandidate,
} from './workspace-inline-keyboard';
import './workspace-inline-candidates.css';
export interface WorkspaceInlineCandidatesHandle {
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
}
export interface WorkspaceInlineCandidatesProps {
  trigger: '@' | '/';
  query: string;
  projectId: string | null;
  currentConversationId?: string;
  projects: readonly { id: string; name: string }[];
  remaining: number;
  dataScope: ModelDataScope;
  filter?: ReferenceTab;
  id?: string;
  onAdd: (reference: PreparedReference) => void;
  onSkill: (skillId: PlatformGuidanceSkillId) => void;
  onClose: () => void;
  onActiveDescendantChange?: (id: string | undefined) => void;
}
interface Candidate {
  skillId?: PlatformGuidanceSkillId;
  id: string;
  label: string;
  description: string;
  sourceLabel?: string;
  icon: ReactNode;
  reference?: PreparedReference['reference'];
  disabled?: boolean;
}
const categories: { id: ReferenceTab; label: string; icon: ReactNode }[] = [
  { id: 'history', label: '本人历史', icon: <HistoryOutlined /> },
  { id: 'resources', label: '附件', icon: <FileOutlined /> },
  { id: 'requirements', label: '需求版本', icon: <FileTextOutlined /> },
  { id: 'knowledge', label: '知识', icon: <BookOutlined /> },
  { id: 'external', label: '外部MCP', icon: <ApiOutlined /> },
];
const normalized = (value: string) => value.trim().toLocaleLowerCase('zh-CN');
export const WorkspaceInlineCandidates = forwardRef<
  WorkspaceInlineCandidatesHandle,
  WorkspaceInlineCandidatesProps
>(function WorkspaceInlineCandidates(
  {
    trigger,
    query,
    projectId,
    currentConversationId,
    projects,
    remaining,
    dataScope,
    filter,
    id = 'workspace-inline-candidates',
    onAdd,
    onSkill,
    onClose,
    onActiveDescendantChange,
  },
  ref,
) {
  const internalId = useId().replace(/:/g, ''),
    listId = id || `workspace-inline-${internalId}`;
  const [tab, setTab] = useState<ReferenceTab>(filter ?? 'history'),
    [sourceProject, setSourceProject] = useState(projectId ?? ''),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState(-1),
    [loadedKey, setLoadedKey] = useState(''),
    [morePending, setMorePending] = useState(false),
    [fullRead, setFullRead] = useState(false),
    [availableHeight, setAvailableHeight] = useState(410);
  const requestGeneration = useRef(0),
    list = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    loadedIdentity = useRef({
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    });
  useLayoutEffect(() => {
    const anchor = panel.current?.parentElement;
    if (!anchor) return;
    const measure = () =>
      setAvailableHeight(
        Math.max(
          80,
          Math.min(410, Math.floor(anchor.getBoundingClientRect().top - 16)),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, []);
  const requestKey = JSON.stringify([
    trigger,
    tab,
    sourceProject,
    currentConversationId,
    query,
    currentIdentityOwner(),
    identityContextEpoch(),
  ]);
  useEffect(() => {
    setTab(filter ?? 'history');
  }, [filter, trigger]);
  useEffect(() => {
    setSourceProject(projectId ?? '');
  }, [projectId]);
  const isCurrent = () =>
    loadedIdentity.current.owner !== null &&
    loadedIdentity.current.owner === currentIdentityOwner() &&
    loadedIdentity.current.epoch === identityContextEpoch();
  useEffect(() => {
    const abort = new AbortController(),
      epoch = ++requestGeneration.current;
    setLoading(true);
    setError('');
    setCursor(null);
    setSelected(-1);
    setCandidates([]);
    setLoadedKey('');
    setMorePending(false);
    loadedIdentity.current = {
      owner: currentIdentityOwner(),
      epoch: identityContextEpoch(),
    };
    if (
      trigger === '@' &&
      (tab === 'requirements' || tab === 'knowledge') &&
      !sourceProject
    ) {
      setLoading(false);
      setLoadedKey(requestKey);
      return () => abort.abort();
    }
    const timer = setTimeout(
      () => {
        const load = async () => {
          let items: Candidate[] = [],
            nextCursor: string | null = null;
          if (trigger === '/') {
            const catalog = await api(
              '/me/skill-guidance',
              { signal: abort.signal },
              skillGuidanceCatalogSchema,
            );
            items = catalog.skills
              .filter((entry) => entry.availability !== 'localOnly')
              .filter(
                (entry) =>
                  !query.trim() ||
                  normalized(`${entry.name} ${entry.skillId}`).includes(
                    normalized(query),
                  ),
              )
              .map((entry) => {
                const skill = platformGuidanceSkillIdSchema.safeParse(
                  entry.skillId,
                );
                return {
                  id: `skill:${entry.skillId}`,
                  label: entry.name,
                  description:
                    entry.availability === 'available'
                      ? '准备使用同版规则；发送后由 AI 按需读取，业务操作仍需当前权限。'
                      : entry.description,
                  sourceLabel:
                    entry.availability === 'available'
                      ? `平台规则 v${entry.version}`
                      : entry.availability === 'deferred'
                        ? '延期'
                        : '规则不可用',
                  icon: <CodeSandboxOutlined />,
                  disabled: entry.availability !== 'available',
                  ...(entry.availability === 'available' && skill.success
                    ? { skillId: skill.data }
                    : {}),
                };
              });
          } else if (tab === 'history') {
            const result = await api(
              `/me/conversations/history-candidates?query=${encodeURIComponent(query)}`,
              { signal: abort.signal },
              historyCandidatesSchema,
            );
            items = result.conversations
              .filter((item) => item.id !== currentConversationId)
              .map((item) => ({
                id: `conversation:${item.id}`,
                label: item.alias ?? item.title,
                description: `正文未读 · 相关片段 · ${new Date(item.updatedAt).toLocaleDateString('zh-CN')}`,
                sourceLabel: '本人历史',
                icon: <HistoryOutlined />,
                reference: {
                  kind: 'conversation',
                  conversationId: item.id,
                  mode: 'relevant',
                  ...(query.trim() ? { query: query.trim() } : {}),
                  dataScope,
                },
              }));
          } else if (tab === 'resources') {
            const result = await api(
              `/me/resources?query=${encodeURIComponent(query)}&limit=30`,
              { signal: abort.signal },
              personalResourceListSchema,
            );
            nextCursor = result.nextCursor;
            items = result.resources.map((item) => ({
              id: `resource:${item.id}`,
              label: item.originalName,
              sourceLabel: '个人附件',
              description:
                item.status !== 'verified'
                  ? '文件字节尚未验证，不可引用'
                  : item.textExtractionSupported
                    ? '字节已验证，尚未读取正文'
                    : '已保留原件，当前格式未支持文本解析',
              icon: <FileOutlined />,
              disabled: item.status !== 'verified',
              reference: { kind: 'resource', resourceId: item.id, dataScope },
            }));
          } else if (tab === 'requirements') {
            const result = await api(
              `/projects/${sourceProject}/assets/navigation?kind=UI`,
              { signal: abort.signal },
              assetNavigationSchema,
            );
            items = result.requirements
              .flatMap((item) =>
                item.versions.map((version) => ({
                  id: `requirementVersion:${version.id}`,
                  label: `${item.title} · v${version.versionNo}`,
                  description: '正文未读 · 固定需求版本',
                  sourceLabel:
                    projects.find((p) => p.id === sourceProject)?.name ??
                    '所选项目',
                  icon: <FileTextOutlined />,
                  reference: {
                    kind: 'requirementVersion' as const,
                    requirementVersionId: version.id,
                    dataScope,
                  },
                })),
              )
              .filter(
                (item) =>
                  !query.trim() ||
                  normalized(item.label).includes(normalized(query)) ||
                  item.id.includes(query.trim()),
              )
              .slice(0, 200);
          } else if (tab === 'knowledge') {
            const params = new URLSearchParams({ query, limit: '30' }),
              result = await api(
                `/projects/${sourceProject}/knowledge/entries?${params}`,
                { signal: abort.signal },
                knowledgeIndexResponseSchema,
              );
            nextCursor = result.nextCursor;
            items = result.entries.map((item) => ({
              id: `knowledge:${item.id}:${item.revisionId}`,
              label: item.title,
              description: `正文未读 · r${item.revisionNo} · ${item.tags.join('、') || '知识索引'}`,
              sourceLabel:
                projects.find((p) => p.id === sourceProject)?.name ??
                '所选项目',
              icon: <BookOutlined />,
              disabled: item.deleted,
              reference: {
                kind: 'knowledge',
                entryId: item.id,
                revisionId: item.revisionId,
                dataScope,
              },
            }));
          } else {
            const result = await api(
              '/external-mcp/available',
              { signal: abort.signal },
              externalAvailableToolsSchema,
            );
            items = result.connections
              .filter(
                (item) =>
                  !query.trim() ||
                  normalized(item.name).includes(normalized(query)),
              )
              .map((item) => ({
                id: `externalMcpConnection:${item.connectionId}`,
                label: item.name,
                description: `${item.tools.filter((tool) => tool.approved).length} 个已批准工具 · 尚未调用`,
                sourceLabel: '外部MCP',
                icon: <ApiOutlined />,
                disabled: !item.tools.some((tool) => tool.approved),
                reference: {
                  kind: 'externalMcpConnection',
                  connectionId: item.connectionId,
                  configRevision: item.configRevision,
                  credentialVersion: item.credentialVersion,
                  catalogDigest: item.catalogDigest,
                  dataScope,
                },
              }));
          }
          if (
            abort.signal.aborted ||
            epoch !== requestGeneration.current ||
            !isCurrent()
          )
            return;
          setCandidates(items);
          setCursor(nextCursor);
          setLoadedKey(requestKey);
          setSelected(
            moveInlineCandidate(
              items.map(
                (item) =>
                  Boolean(item.disabled) || (trigger === '@' && remaining <= 0),
              ),
              -1,
              1,
            ),
          );
        };
        void load()
          .catch((failure) => {
            if (
              !abort.signal.aborted &&
              epoch === requestGeneration.current &&
              isCurrent()
            ) {
              setError(describeError(failure));
              setCandidates([]);
              setLoadedKey(requestKey);
            }
          })
          .finally(() => {
            if (!abort.signal.aborted && epoch === requestGeneration.current)
              setLoading(false);
          });
      },
      tab === 'history' || tab === 'resources' || tab === 'knowledge' ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [requestKey]);
  const shown: Candidate[] = loadedKey === requestKey ? candidates : [];
  const unavailable = shown.map(
    (item) =>
      Boolean(item.disabled) ||
      (trigger === '@' && remaining <= 0) ||
      loading ||
      loadedKey !== requestKey ||
      !isCurrent(),
  );
  function choose(index: number) {
    const item = shown[index];
    if (item?.skillId && !unavailable[index]) {
      onSkill(item.skillId);
      onClose();
      return;
    }
    if (
      !item ||
      unavailable[index] ||
      !item.reference ||
      (item.reference.kind === 'conversation' &&
        item.reference.conversationId === currentConversationId)
    )
      return;
    onAdd({
      id: crypto.randomUUID(),
      reference: {
        ...item.reference,
        ...(item.reference.kind === 'conversation'
          ? { mode: fullRead ? ('full' as const) : ('relevant' as const) }
          : {}),
        dataScope,
      },
      label: item.label,
      note:
        (item.reference.kind === 'conversation' && fullRead
          ? '明确准备通读所选对话，尚未读取正文'
          : item.description) + '；发送时重新检查来源与当前权限',
    });
    onClose();
  }
  useEffect(() => {
    const element =
      selected >= 0 && selected < shown.length && !unavailable[selected]
        ? `${listId}-option-${selected}`
        : undefined;
    onActiveDescendantChange?.(element);
    if (element)
      document.getElementById(element)?.scrollIntoView({ block: 'nearest' });
    return () => onActiveDescendantChange?.(undefined);
  }, [selected, requestKey, shown.length, loading, remaining]);
  useImperativeHandle(ref, () => ({
    handleKeyDown(event) {
      const action = inlineCandidateKeyAction({
        key: event.key,
        composing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        disabled: unavailable,
        selected,
      });
      if (action.kind === 'ignore') return false;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === 'close') onClose();
      else if (action.kind === 'move') setSelected(action.index);
      else if (action.kind === 'choose') choose(action.index);
      return true;
    },
  }));
  async function more() {
    if (
      !cursor ||
      loading ||
      morePending ||
      !isCurrent() ||
      loadedKey !== requestKey ||
      (tab !== 'resources' && tab !== 'knowledge')
    )
      return;
    const epoch = requestGeneration.current;
    setMorePending(true);
    try {
      let items: Candidate[], nextCursor: string | null;
      if (tab === 'resources') {
        const result = await api(
          `/me/resources?query=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}&limit=30`,
          {},
          personalResourceListSchema,
        );
        nextCursor = result.nextCursor;
        items = result.resources.map((item) => ({
          id: `resource:${item.id}`,
          label: item.originalName,
          sourceLabel: '个人附件',
          description:
            item.status !== 'verified'
              ? '字节尚未验证，不可引用'
              : item.textExtractionSupported
                ? '字节已验证，正文未读取'
                : '当前格式未支持文本解析',
          icon: <FileOutlined />,
          disabled: item.status !== 'verified',
          reference: { kind: 'resource', resourceId: item.id, dataScope },
        }));
      } else {
        const params = new URLSearchParams({
            query,
            limit: '30',
            afterId: cursor,
          }),
          result = await api(
            `/projects/${sourceProject}/knowledge/entries?${params}`,
            {},
            knowledgeIndexResponseSchema,
          );
        nextCursor = result.nextCursor;
        items = result.entries.map((item) => ({
          id: `knowledge:${item.id}:${item.revisionId}`,
          label: item.title,
          description: `正文未读 · r${item.revisionNo} · 知识索引`,
          sourceLabel:
            projects.find((p) => p.id === sourceProject)?.name ?? '所选项目',
          icon: <BookOutlined />,
          disabled: item.deleted,
          reference: {
            kind: 'knowledge',
            entryId: item.id,
            revisionId: item.revisionId,
            dataScope,
          },
        }));
      }
      if (epoch !== requestGeneration.current || !isCurrent()) return;
      setCandidates((previous) => [
        ...previous,
        ...items.filter((item) => !previous.some((old) => old.id === item.id)),
      ]);
      setCursor(nextCursor);
    } catch (failure) {
      if (epoch === requestGeneration.current && isCurrent())
        setError(describeError(failure));
    } finally {
      if (epoch === requestGeneration.current) setMorePending(false);
    }
  }
  const projectRequired =
    trigger === '@' && (tab === 'requirements' || tab === 'knowledge');
  return (
    <section
      className="workspace-inline-candidates"
      ref={panel}
      style={{ maxHeight: availableHeight }}
      aria-label={trigger === '/' ? 'Skill候选' : '引用候选'}
    >
      {trigger === '@' && (
        <div className="workspace-inline-toolbar">
          <nav aria-label="引用类别">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={tab === category.id ? 'active' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTab(category.id)}
                aria-pressed={tab === category.id}
              >
                {category.icon}
                <span>{category.label}</span>
              </button>
            ))}
          </nav>
          {projectRequired && (
            <select
              className="workspace-inline-project-select"
              aria-label="候选来源项目"
              title={
                projects.find((project) => project.id === sourceProject)
                  ?.name ?? '选择来源项目'
              }
              value={sourceProject}
              onChange={(event) => setSourceProject(event.target.value)}
            >
              <option value="">选择来源项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div
        ref={list}
        className="workspace-inline-list"
        role="listbox"
        id={listId}
        aria-label={trigger === '/' ? '配套Skill列表' : '可准备的引用'}
        aria-busy={loading}
      >
        {loading && (
          <p className="workspace-inline-empty" role="status">
            <LoadingOutlined /> 正在读取候选元数据…
          </p>
        )}
        {!loading && error && (
          <p className="workspace-inline-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && projectRequired && !sourceProject && (
          <p className="workspace-inline-empty">
            先选择来源项目；不会默认读取整个项目。
          </p>
        )}
        {!loading &&
          !error &&
          !shown.length &&
          (!projectRequired || sourceProject) && (
            <p className="workspace-inline-empty">
              {trigger === '/'
                ? '没有匹配的 Skill，可继续输入名称。'
                : '当前候选没有匹配项，可继续输入关键词。'}
            </p>
          )}
        {shown.map((item, index) => (
          <div
            key={item.id}
            id={`${listId}-option-${index}`}
            role="option"
            aria-selected={selected === index && !unavailable[index]}
            aria-disabled={unavailable[index]}
            className={`workspace-inline-option${selected === index && !unavailable[index] ? ' selected' : ''}${unavailable[index] ? ' disabled' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => {
              if (!unavailable[index]) setSelected(index);
            }}
            onClick={() => choose(index)}
          >
            <span className="workspace-inline-icon">{item.icon}</span>
            <span className="workspace-inline-text">
              <b title={item.label}>{item.label}</b>
              <small>
                {item.reference?.kind === 'conversation' && fullRead
                  ? '正文未读 · 已选通读'
                  : item.description}
              </small>
            </span>
            {item.sourceLabel && (
              <span
                className="workspace-inline-source"
                title={item.sourceLabel}
              >
                {item.sourceLabel}
              </span>
            )}
          </div>
        ))}
      </div>
      <footer>
        {trigger === '@' && tab === 'history' && (
          <label
            className="workspace-inline-history-mode"
            title="明确请求通读所选对话；默认仅引用相关片段"
          >
            <input
              type="checkbox"
              checked={fullRead}
              onChange={(event) => setFullRead(event.target.checked)}
            />
            通读所选对话
          </label>
        )}
        <span className="workspace-inline-hint">
          {trigger === '@' && remaining <= 0
            ? '引用已达30项，请先移除已有选择。'
            : trigger === '/'
              ? '选择只写入输入框；本地 UI 执行由本机 AI + Skill + Ego 完成。'
              : tab === 'external'
                ? '仅准备目录，尚未调用外部工具。'
                : '仅准备引用，正文尚未读取。'}
        </span>
        {cursor && loadedKey === requestKey && (
          <button
            type="button"
            disabled={loading || morePending}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void more()}
          >
            {morePending ? '读取中…' : '更多候选'}
          </button>
        )}
      </footer>
    </section>
  );
});
