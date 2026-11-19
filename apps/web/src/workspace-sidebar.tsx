import {
  Alert,
  Avatar,
  Button,
  Dropdown,
  Popover,
  Skeleton,
  Tooltip,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  PushpinOutlined,
  PushpinFilled,
  EditOutlined,
  InboxOutlined,
  MinusCircleOutlined,
  CopyOutlined,
  LinkOutlined,
  FileMarkdownOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useWorkspaceEscapeFocus } from './workspace-escape-focus';
import { AppIcon } from './app-icon';
import { RequirementRestorePicker } from './workspace-requirement-picker';
import type { RequirementRestorePickerProps } from './workspace-requirement-picker';
export { RequirementRestorePicker } from './workspace-requirement-picker';
export type { RequirementRestorePickerProps } from './workspace-requirement-picker';
import type {
  Conversation,
  ConversationSidebar,
} from '../../../packages/contracts/src/conversations';

export type RequirementGroup = ConversationSidebar['groups'][number];
export type ConversationAction =
  'pin' | 'edit' | 'archive' | 'copyReference' | 'exportMarkdown';
export type GroupAction = 'pin' | 'edit' | 'archive' | 'hide';

export function conversationActionFromMenuKey(
  key: string,
): ConversationAction | null {
  return key === 'pin' ||
    key === 'edit' ||
    key === 'archive' ||
    key === 'copyReference' ||
    key === 'exportMarkdown'
    ? key
    : null;
}
export function conversationIsRunning(conversation: Conversation) {
  return (
    'activeTaskStatus' in conversation &&
    conversation.activeTaskStatus === 'running'
  );
}
export function conversationPreviewMetadata(
  conversation: Conversation,
  projects: readonly { id: string; name: string }[],
) {
  return {
    name: conversation.alias ?? conversation.title,
    project:
      conversation.projectId === null
        ? '个人会话'
        : (projects.find((project) => project.id === conversation.projectId)
            ?.name ?? '原项目（当前不可用）'),
    requirement:
      conversation.requirementId === null
        ? '未关联需求'
        : (conversation.requirementTitle ?? '原关联需求（当前名称未取得）'),
    updatedAt: conversation.updatedAt,
  };
}
export function conversationMenuItems(
  conversation: Conversation,
): NonNullable<MenuProps['items']> {
  return [
    {
      key: 'pin',
      icon: conversation.pinnedAt ? <PushpinFilled /> : <PushpinOutlined />,
      label: conversation.pinnedAt ? '取消置顶' : '置顶',
    },
    { key: 'edit', icon: <EditOutlined />, label: '编辑' },
    {
      key: 'copy',
      icon: <CopyOutlined />,
      label: '复制',
      popupClassName:
        'user-workspace-sidebar-menu user-workspace-sidebar-submenu',
      children: [
        { key: 'copyReference', icon: <LinkOutlined />, label: '复制深度链接' },
        {
          key: 'exportMarkdown',
          icon: <FileMarkdownOutlined />,
          label: '复制为 Markdown',
          title: '下载 .md 文件',
        },
      ],
    },
    { key: 'archive', icon: <InboxOutlined />, label: '归档' },
  ];
}
export function ConversationMenu({
  conversation,
  onAction,
  disabled = false,
  label = '对话更多',
  onMenuOpenChange,
}: {
  conversation: Conversation;
  onAction: (
    conversation: Conversation,
    action: ConversationAction,
    trigger?: HTMLElement,
  ) => void;
  disabled?: boolean;
  label?: string;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  useWorkspaceEscapeFocus(
    open,
    () => {
      setOpen(false);
      onMenuOpenChange?.(false);
    },
    trigger,
  );
  return (
    <Dropdown
      trigger={['click']}
      placement="rightTop"
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        onMenuOpenChange?.(value);
      }}
      autoFocus
      autoAdjustOverflow
      classNames={{ root: 'user-workspace-sidebar-menu' }}
      styles={{
        root: { width: 216, maxWidth: 'calc(100vw - 24px)', minWidth: 0 },
      }}
      menu={{
        items: conversationMenuItems(conversation),
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          const action = conversationActionFromMenuKey(key);
          if (action) {
            setOpen(false);
            onMenuOpenChange?.(false);
            onAction(conversation, action, trigger.current ?? undefined);
          }
        },
      }}
    >
      <Button
        className="iconbtn"
        ref={trigger}
        data-conversation-menu={conversation.id}
        data-sidebar-menu-open={open || undefined}
        type="text"
        icon={<AppIcon name="more" />}
        aria-label={label}
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
      />
    </Dropdown>
  );
}

function ConversationRow({
  personalBadge = false,
  conversation,
  selected,
  pending,
  onOpen,
  onAction,
  projects,
}: {
  personalBadge?: boolean;
  conversation: Conversation;
  selected: boolean;
  pending: boolean;
  onOpen: (id: string) => void;
  onAction: (
    conversation: Conversation,
    action: ConversationAction,
    trigger?: HTMLElement,
  ) => void;
  projects: readonly { id: string; name: string }[];
}) {
  const [previewOpen, setPreviewOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const metadata = conversationPreviewMetadata(conversation, projects);
  const running = conversationIsRunning(conversation);
  return (
    <div
      className={`conversation-row chat-item sidebar-action-row ${selected ? 'selected active' : ''}`}
      data-conversation-row={conversation.id}
      data-task-running={running || undefined}
    >
      <Popover
        trigger={['hover', 'focus']}
        placement="rightTop"
        arrow={false}
        mouseEnterDelay={0.3}
        open={previewOpen && !menuOpen}
        onOpenChange={(value) => setPreviewOpen(value && !menuOpen)}
        autoAdjustOverflow
        classNames={{ root: 'user-workspace-sidebar-preview' }}
        content={
          <section
            className="sidebar-preview-content"
            aria-label="对话元数据预览"
          >
            <b>{metadata.name}</b>
            <p>项目：{metadata.project}</p>
            <p>需求：{metadata.requirement}</p>
            <time dateTime={metadata.updatedAt}>
              更新于 {new Date(metadata.updatedAt).toLocaleString('zh-CN')}
            </time>
          </section>
        }
      >
        <Button
          type="text"
          className="conversation-title"
          onClick={() => onOpen(conversation.id)}
        >
          <span className="sidebar-conversation-label">
            {conversation.alias ?? conversation.title}
          </span>
          {personalBadge && conversation.projectId === null && (
            <span className="badge">个人</span>
          )}
        </Button>
      </Popover>
      {running && (
        <span
          className="sidebar-task-spinner"
          role="status"
          aria-label="此对话的 AI 任务正在运行"
        >
          <LoadingOutlined spin aria-hidden="true" />
        </span>
      )}
      <span className="sidebar-row-actions">
        <ConversationMenu
          conversation={conversation}
          onAction={onAction}
          disabled={pending}
          label={`对话更多：${conversation.alias ?? conversation.title}`}
          onMenuOpenChange={(value) => {
            setMenuOpen(value);
            if (value) setPreviewOpen(false);
          }}
        />
      </span>
    </div>
  );
}

function RequirementMenu({
  group,
  pending,
  onAction,
}: {
  group: RequirementGroup;
  pending: boolean;
  onAction: (
    group: RequirementGroup,
    action: GroupAction,
    trigger?: HTMLElement,
  ) => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null),
    [open, setOpen] = useState(false);
  useWorkspaceEscapeFocus(open, () => setOpen(false), trigger);
  return (
    <Dropdown
      trigger={['click']}
      placement="rightTop"
      open={open}
      onOpenChange={setOpen}
      autoFocus
      autoAdjustOverflow
      classNames={{ root: 'user-workspace-sidebar-menu' }}
      styles={{
        root: { width: 216, maxWidth: 'calc(100vw - 24px)', minWidth: 0 },
      }}
      menu={{
        items: [
          {
            key: 'pin',
            icon: group.pinnedAt ? <PushpinFilled /> : <PushpinOutlined />,
            label: group.pinnedAt ? '取消置顶' : '置顶',
          },
          { key: 'edit', icon: <EditOutlined />, label: '编辑' },
          { key: 'archive', icon: <InboxOutlined />, label: '归档' },
          { key: 'hide', icon: <MinusCircleOutlined />, label: '移除' },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (
            key === 'pin' ||
            key === 'edit' ||
            key === 'archive' ||
            key === 'hide'
          ) {
            setOpen(false);
            onAction(group, key, trigger.current ?? undefined);
          }
        },
      }}
    >
      <Button
        ref={trigger}
        className="iconbtn"
        data-requirement-menu={group.requirementId}
        data-sidebar-menu-open={open || undefined}
        type="text"
        icon={<AppIcon name="more" />}
        disabled={pending}
        aria-label={`需求更多：${group.alias ?? group.generatedName ?? group.formalTitle}`}
      />
    </Dropdown>
  );
}

export function WorkspaceSidebar({
  projectName,
  projects = [],
  notificationBell,
  displayName,
  sidebar,
  loading,
  error,
  pending,
  selectedId,
  onCreate,
  onOpen,
  onConversationAction,
  onGroupAction,
  onToggleGroup,
  onMoveGroup,
  onRestoreGroups,
  restorePicker,
  onSettings,
}: {
  projectName: string | null;
  projects?: readonly { id: string; name: string }[];
  notificationBell: ReactNode;
  projectSelect?: ReactNode;
  displayName: string;
  sidebar: ConversationSidebar | null;
  loading: boolean;
  error: string | undefined;
  pending: boolean;
  selectedId: string | null;
  onCreate: (group?: RequirementGroup) => void;
  onOpen: (id: string) => void;
  onConversationAction: (
    conversation: Conversation,
    action: ConversationAction,
    trigger?: HTMLElement,
  ) => void;
  onGroupAction: (
    group: RequirementGroup,
    action: GroupAction,
    trigger?: HTMLElement,
  ) => void;
  onToggleGroup: (group: RequirementGroup) => void;
  onMoveGroup: (group: RequirementGroup, target: RequirementGroup) => void;
  onRestoreGroups: () => void;
  restorePicker?: Omit<
    RequirementRestorePickerProps,
    'children' | 'pending' | 'projectName'
  >;
  onSettings: () => void;
}) {
  const normal = sidebar?.groups.filter((group) => !group.pinnedAt) ?? [];
  return (
    <aside className="workspace-sidebar live-sidebar chat-sidebar user-workspace-sidebar">
      <div className="workspace-heading ai-side-head">
        <b>AI 工作台</b>
        {notificationBell}
      </div>
      <Button
        block
        className="newchat"
        aria-label="新建对话"
        icon={<AppIcon name="compose" />}
        onClick={() => onCreate()}
      >
        新聊天
      </Button>
      <div className="workspace-side-scroll chat-groups">
        {loading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : error ? (
          <Alert type="error" showIcon title={error} />
        ) : (
          sidebar && (
            <>
              {!!sidebar.pinned.length && (
                <section aria-label="置顶对话">
                  <div className="group-heading">
                    <span>置顶</span>
                    <small>{sidebar.pinned.length}</small>
                  </div>
                  {sidebar.pinned.map((conversation) => (
                    <ConversationRow
                      personalBadge
                      key={conversation.id}
                      conversation={conversation}
                      projects={projects}
                      selected={selectedId === conversation.id}
                      pending={pending}
                      onOpen={onOpen}
                      onAction={onConversationAction}
                    />
                  ))}
                </section>
              )}
              <section aria-label="本人需求分组">
                <div className="workspace-section-heading group-heading">
                  <span>需求</span>
                  {restorePicker ? (
                    <RequirementRestorePicker
                      {...restorePicker}
                      pending={pending}
                      projectName={projectName}
                    >
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        aria-label="找回本人参与的需求分组"
                        aria-expanded={restorePicker.open}
                        disabled={pending}
                      />
                    </RequirementRestorePicker>
                  ) : (
                    <Tooltip title="找回当前参与的隐藏或归档需求分组">
                      <Button
                        type="text"
                        icon={<PlusOutlined />}
                        aria-label="找回本人参与的需求分组"
                        onClick={onRestoreGroups}
                        disabled={pending}
                      />
                    </Tooltip>
                  )}
                </div>
                {sidebar.groups.map((group) => {
                  const title =
                    group.alias ?? group.generatedName ?? group.formalTitle;
                  return (
                    <div
                      className="requirement-chat-group req-group"
                      key={group.requirementId}
                      draggable={!group.pinnedAt && !pending}
                      onDragStart={(event) =>
                        event.dataTransfer.setData(
                          'application/x-ath-requirement',
                          group.requirementId,
                        )
                      }
                      onDragOver={(event) => {
                        if (!group.pinnedAt) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const id = event.dataTransfer.getData(
                          'application/x-ath-requirement',
                        );
                        const source = normal.find(
                          (item) => item.requirementId === id,
                        );
                        if (
                          source &&
                          source.requirementId !== group.requirementId &&
                          !group.pinnedAt
                        )
                          onMoveGroup(source, group);
                      }}
                    >
                      <div
                        className="requirement-chat-heading req-group-title sidebar-action-row"
                        data-requirement-row={group.requirementId}
                      >
                        <Button
                          type="text"
                          className="requirement-chat-title req-name"
                          aria-expanded={group.expanded}
                          title={`${title}；Alt+上/下可调整非置顶分组顺序`}
                          icon={
                            group.expanded ? (
                              <AppIcon name="folder-open" />
                            ) : (
                              <AppIcon name="folder-closed" />
                            )
                          }
                          disabled={pending}
                          onClick={() => onToggleGroup(group)}
                          onKeyDown={(event) => {
                            if (
                              !event.altKey ||
                              group.pinnedAt ||
                              !['ArrowUp', 'ArrowDown'].includes(event.key)
                            )
                              return;
                            event.preventDefault();
                            const at = normal.findIndex(
                              (item) =>
                                item.requirementId === group.requirementId,
                            );
                            const destination =
                              normal[at + (event.key === 'ArrowUp' ? -1 : 1)];
                            if (destination) onMoveGroup(group, destination);
                          }}
                        >
                          {title}
                        </Button>
                        <span className="sidebar-row-actions">
                          <RequirementMenu
                            group={group}
                            pending={pending}
                            onAction={onGroupAction}
                          />
                          <Tooltip title="在此需求下新建对话">
                            <Button
                              className="iconbtn"
                              type="text"
                              icon={<AppIcon name="compose" />}
                              disabled={pending}
                              aria-label={`在需求 ${title} 新建对话`}
                              onClick={() => onCreate(group)}
                            />
                          </Tooltip>
                        </span>
                      </div>
                      {group.expanded && (
                        <div className="requirement-chat-conversations req-children">
                          {group.conversations.map((conversation) => (
                            <ConversationRow
                              key={conversation.id}
                              conversation={conversation}
                              projects={projects}
                              selected={selectedId === conversation.id}
                              pending={pending}
                              onOpen={onOpen}
                              onAction={onConversationAction}
                            />
                          ))}
                          {!group.conversations.length && (
                            <Typography.Text
                              type="secondary"
                              className="small-empty"
                            >
                              此需求下还没有个人对话
                            </Typography.Text>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!sidebar.groups.length && (
                  <p className="small-empty">
                    {projectName
                      ? '当前项目尚无可显示的本人参与分组'
                      : '个人对话可继续；请在输入框项目选择器选择有效项目。'}
                  </p>
                )}
              </section>
              <section aria-label="个人最近对话">
                <div className="group-heading">最近</div>
                {sidebar.recent.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    projects={projects}
                    selected={selectedId === conversation.id}
                    pending={pending}
                    onOpen={onOpen}
                    onAction={onConversationAction}
                  />
                ))}
                {!sidebar.recent.length && (
                  <Typography.Text type="secondary" className="small-empty">
                    暂无个人最近对话
                  </Typography.Text>
                )}
              </section>
            </>
          )
        )}
      </div>
      <div className="personal-anchor">
        <Button
          type="text"
          className="workspace-account profile-button"
          data-workspace-account
          onClick={onSettings}
        >
          <Avatar size={32}>{displayName.slice(0, 2)}</Avatar>
          <span className="profile-caption">
            <b>{displayName}</b>
            <small>个人资料与设置</small>
          </span>
          <AppIcon name="settings" />
        </Button>
      </div>
    </aside>
  );
}
