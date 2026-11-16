import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import {
  App as AntApp,
  Avatar,
  Button,
  Card,
  ConfigProvider,
  Dropdown,
  Empty,
  Layout,
  Menu,
  Result,
  Select,
  Skeleton,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  ControlOutlined,
  LogoutOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { meSchema } from '../../../packages/contracts/src/identity';
import { idSchema } from '../../../packages/contracts/src/base';
import {
  api,
  describeError,
  isSessionDenial,
  sessionDenialReason,
} from './api';
import {
  announceIdentityChange,
  subscribeIdentityChanges,
  setIdentityOwner,
  lastIdentityChangeReason,
  identityChangeNotice,
} from './identity-context';
import { useSessionRenewal } from './session-renewal';
import { AuthPage } from './auth';
import { IdentityCommandRecovery } from './identity-command-recovery';
import { roleLabels } from './types';
import type { Me, Project } from './types';
import type { CaseScope } from './requirements';
import { NotificationBell, NotificationPanel } from './notifications';
import { AppIcon } from './app-icon';
import { AppearanceToggle } from './appearance-toggle';
import { v3Theme } from './v3-theme';
import { hasNavigationBlocker, requestNavigation } from './navigation-guard';

const PersonalSettings = lazy(() =>
  import('./personal-settings').then((module) => ({
    default: module.PersonalSettings,
  })),
);
const ProjectConfigurationPage = lazy(() =>
  import('./test-configuration').then((module) => ({
    default: module.ProjectConfigurationPage,
  })),
);
const PlatformProjects = lazy(() =>
  import('./project-settings').then((module) => ({
    default: module.PlatformProjects,
  })),
);
const PlatformUsers = lazy(() =>
  import('./platform-users').then((module) => ({
    default: module.PlatformUsers,
  })),
);
const RequirementsPage = lazy(() =>
  import('./requirements').then((module) => ({
    default: module.RequirementsPage,
  })),
);
const PlatformModelSettings = lazy(() =>
  import('./model-settings').then((module) => ({
    default: module.PlatformModelSettings,
  })),
);
const AssetsPage = lazy(() =>
  import('./assets').then((module) => ({ default: module.AssetsPage })),
);
const PlansPage = lazy(() =>
  import('./plans').then((module) => ({ default: module.PlansPage })),
);
const ResultsPage = lazy(() =>
  import('./results').then((module) => ({ default: module.ResultsPage })),
);
const IssuesPage = lazy(() =>
  import('./issues').then((module) => ({ default: module.IssuesPage })),
);
const KnowledgePage = lazy(() =>
  import('./knowledge').then((module) => ({ default: module.KnowledgePage })),
);
const OverviewPage = lazy(() =>
  import('./overview').then((module) => ({ default: module.OverviewPage })),
);
const ExternalMcpDecisionsPage = lazy(() =>
  import('./external-mcp-settings').then((module) => ({
    default: module.ExternalMcpDecisionsPage,
  })),
);
const ApiWorkbenchPage = lazy(() =>
  import('./api-workbench').then((module) => ({
    default: module.ApiWorkbenchPage,
  })),
);
const PlatformUsagePanel = lazy(() =>
  import('./usage').then((module) => ({ default: module.PlatformUsagePanel })),
);
const BusinessConfirmationPage = lazy(() =>
  import('./business-confirmations').then((module) => ({
    default: module.BusinessConfirmationPage,
  })),
);

const pages = [
  { key: 'workspace', label: 'AI 工作台', icon: <AppIcon name="spark" /> },
  { key: 'overview', label: '项目概览', icon: <AppIcon name="grid" /> },
  { key: 'requirements', label: '需求管理', icon: <AppIcon name="file" /> },
  { key: 'cases', label: '用例中心', icon: <AppIcon name="check" /> },
  {
    key: 'api-regression',
    label: '接口回归工作台',
    icon: <AppIcon name="api" />,
  },
  { key: 'plans', label: '测试计划', icon: <AppIcon name="calendar" /> },
  { key: 'reports', label: '执行与报告', icon: <AppIcon name="play" /> },
  { key: 'issues', label: '缺陷管理', icon: <AppIcon name="bug" /> },
  { key: 'knowledge', label: '项目知识', icon: <AppIcon name="book" /> },
  {
    key: 'settings',
    label: '项目与设置',
    icon: <ControlOutlined aria-hidden />,
  },
];
const pageKeys = new Set([
  ...pages.map(({ key }) => key),
  'platform-projects',
  'platform-users',
  'platform-models',
  'usage',
  'business-confirmations',
  'external-mcp',
  'personal-settings',
]);

const personalSettingsTabs = new Set([
  'profile',
  'security',
  'appearance',
  'usage',
  'archive',
  'resources',
  'keys',
  'models',
]);

function readSettingsTab() {
  const tab = new URLSearchParams(window.location.hash.split('?')[1]).get(
    'tab',
  );
  return tab && personalSettingsTabs.has(tab) ? tab : 'profile';
}

function workspaceReturnHash(value: string | null) {
  const hash = value?.replace(/^#\/?/, '') ?? 'workspace';
  if (hash.split('?')[0] !== 'workspace') return '#workspace';
  const query = new URLSearchParams(hash.split('?')[1]);
  const result = new URLSearchParams();
  for (const key of ['conversationId', 'projectId']) {
    const id = idSchema.safeParse(query.get(key));
    if (id.success) result.set(key, id.data);
  }
  return `#workspace${result.size ? '?' + result.toString() : ''}`;
}

function readPage() {
  const candidate =
    window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return pageKeys.has(candidate) ? candidate : 'workspace';
}
function readLinkedProjectId() {
  const parsed = idSchema.safeParse(
    new URLSearchParams(window.location.hash.split('?')[1]).get('projectId'),
  );
  return parsed.success ? parsed.data : null;
}

function readCaseScope(): CaseScope | null {
  if (readPage() !== 'cases') return null;
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  const projectId = idSchema.safeParse(query.get('projectId'));
  const requirementId = idSchema.safeParse(query.get('requirementId'));
  const requirementVersionId = idSchema.safeParse(query.get('versionId'));
  const versionNo = Number(query.get('versionNo'));
  const kind = query.get('kind');
  const title = query.get('title');
  if (
    !projectId.success ||
    !requirementId.success ||
    !requirementVersionId.success ||
    !Number.isSafeInteger(versionNo) ||
    versionNo < 1 ||
    (kind !== 'UI' && kind !== 'API') ||
    !title ||
    title.length > 200
  )
    return null;
  return {
    projectId: projectId.data,
    requirementId: requirementId.data,
    requirementVersionId: requirementVersionId.data,
    versionNo,
    kind,
    title,
  };
}

function Placeholder({
  label,
  project,
}: {
  label: string;
  project: Project | null;
}) {
  if (!project)
    return (
      <Card>
        <Empty description="当前没有可访问的项目。请联系项目管理员添加成员，再访问项目功能。" />
      </Card>
    );
  return (
    <Card>
      <Result
        status="info"
        title={`${label}正在开发`}
        subTitle="此模块的业务服务与页面尚未接线。当前状态不代表功能已完成或自测通过。"
      />
    </Card>
  );
}

const Workspace = lazy(() =>
  import('./workspace').then((module) => ({ default: module.Workspace })),
);

function SignedIn({
  dark,
  me,
  onRefresh,
  onLogout,
  onPasswordChanged,
}: {
  dark: boolean;
  me: Me;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
  onPasswordChanged: () => void;
}) {
  const [page, setPage] = useState(readPage);
  const currentHash = useRef(window.location.hash);
  const workspaceMounted = useRef(readPage() === 'workspace');
  const navigationGranted = useRef(false);
  const [projectId, setProjectId] = useState<string | null>(() => {
    const scope = readCaseScope();
    const linked = scope?.projectId ?? readLinkedProjectId();
    return linked && me.projects.some((project) => project.id === linked)
      ? linked
      : (me.projects[0]?.id ?? null);
  });
  const [businessCollapsed, setBusinessCollapsed] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState(readSettingsTab);
  const lastWorkspaceHash = useRef(
    readPage() === 'workspace'
      ? workspaceReturnHash(window.location.hash)
      : workspaceReturnHash(
          new URLSearchParams(window.location.hash.split('?')[1]).get(
            'returnTo',
          ),
        ),
  );
  const restoreWorkspaceFocus = useRef(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationUnread, setNotificationUnread] = useState<number | null>(
    null,
  );
  const [loggingOut, setLoggingOut] = useState(false);
  const [appearancePending, setAppearancePending] = useState(false);
  const appearanceSaving = useRef(false);
  const [caseScope, setCaseScope] = useState<CaseScope | null>(readCaseScope);
  const { message } = AntApp.useApp();
  const isWorkspace = page === 'workspace';
  const isPersonalSettings = page === 'personal-settings';
  const isPersonalToolPage =
    page === 'business-confirmations' || page === 'external-mcp';
  const collapsed =
    isWorkspace || isPersonalSettings ? !workspaceExpanded : businessCollapsed;
  const selectedProject =
    me.projects.find((project) => project.id === projectId) ?? null;
  const isPlatformPage =
    page === 'platform-projects' ||
    page === 'platform-users' ||
    page === 'platform-models' ||
    page === 'usage';
  const currentLabel =
    pages.find(({ key }) => key === page)?.label ??
    {
      'platform-projects': '平台项目管理',
      'platform-users': '平台账号管理',
      'platform-models': '平台模型设置',
      usage: 'AI 使用监控',
      'business-confirmations': '本人业务提案',
      'external-mcp': '外部工具调用',
      'personal-settings': '个人设置',
    }[page] ??
    'AITestHub';

  useEffect(() => {
    const listener = () => {
      const nextHash = window.location.hash;
      if (
        !navigationGranted.current &&
        nextHash !== currentHash.current &&
        hasNavigationBlocker()
      ) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${currentHash.current}`,
        );
        requestNavigation(() => {
          navigationGranted.current = true;
          window.location.hash = nextHash;
        });
        return;
      }
      navigationGranted.current = false;
      currentHash.current = nextHash;
      const nextPage = readPage();
      setPage(nextPage);
      if (nextPage === 'workspace') workspaceMounted.current = true;
      else if (nextPage !== 'personal-settings')
        workspaceMounted.current = false;
      if (nextPage === 'workspace')
        lastWorkspaceHash.current = workspaceReturnHash(nextHash);
      if (nextPage === 'personal-settings') {
        setSettingsInitialTab(readSettingsTab());
        lastWorkspaceHash.current = workspaceReturnHash(
          new URLSearchParams(nextHash.split('?')[1]).get('returnTo'),
        );
      }
      const scope = readCaseScope();
      if (
        scope &&
        me.projects.some((project) => project.id === scope.projectId)
      ) {
        setProjectId(scope.projectId);
        setCaseScope(scope);
      } else setCaseScope(null);
      const linked = readLinkedProjectId();
      if (linked && me.projects.some((project) => project.id === linked))
        setProjectId(linked);
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [me.projects]);
  useEffect(() => {
    function followPersonalTarget() {
      const query = new URLSearchParams(window.location.hash.split('?')[1]);
      if (readPage() === 'workspace' && query.get('panel') === 'resources') {
        openSettings('resources');
      }
    }
    followPersonalTarget();
    window.addEventListener('hashchange', followPersonalTarget);
    return () => window.removeEventListener('hashchange', followPersonalTarget);
  }, []);
  useEffect(() => {
    if (!isWorkspace || !restoreWorkspaceFocus.current) return;
    restoreWorkspaceFocus.current = false;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-workspace-account]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isWorkspace]);
  useEffect(() => {
    if (projectId && !me.projects.some((project) => project.id === projectId))
      setProjectId(me.projects[0]?.id ?? null);
  }, [me.projects, projectId]);
  useEffect(() => {
    setCaseScope((scope) => (scope?.projectId === projectId ? scope : null));
  }, [projectId]);

  function navigate(key: string, scope?: CaseScope | null) {
    const selectedScope =
      scope === undefined ? (key === 'cases' ? caseScope : null) : scope;
    requestNavigation(() => {
      const nextHash =
        key === 'cases' && selectedScope
          ? `${key}?${new URLSearchParams({ projectId: selectedScope.projectId, requirementId: selectedScope.requirementId, versionId: selectedScope.requirementVersionId, title: selectedScope.title, versionNo: String(selectedScope.versionNo), kind: selectedScope.kind }).toString()}`
          : key;
      if (window.location.hash === `#${nextHash}`) return;
      navigationGranted.current = true;
      window.location.hash = nextHash;
    });
  }
  function openSettings(tab = 'profile') {
    requestNavigation(() => {
      const selectedTab = personalSettingsTabs.has(tab) ? tab : 'profile';
      if (readPage() === 'workspace')
        lastWorkspaceHash.current = workspaceReturnHash(window.location.hash);
      setSettingsInitialTab(selectedTab);
      const query = new URLSearchParams({
        tab: selectedTab,
        returnTo: lastWorkspaceHash.current.slice(1),
      });
      const hash = `#personal-settings?${query.toString()}`;
      if (window.location.hash === hash) return;
      navigationGranted.current = true;
      window.location.hash = hash;
    });
  }
  async function toggleAppearance() {
    if (appearanceSaving.current) return;
    appearanceSaving.current = true;
    setAppearancePending(true);
    try {
      await api('/me', {
        method: 'PUT',
        body: {
          displayName: me.user.displayName,
          theme: dark ? 'light' : 'dark',
          rowVersion: me.user.rowVersion,
        },
      });
      await onRefresh();
    } catch (error) {
      void message.error(describeError(error));
    } finally {
      appearanceSaving.current = false;
      setAppearancePending(false);
    }
  }
  function closeSettings() {
    requestNavigation(() => {
      restoreWorkspaceFocus.current = true;
      navigationGranted.current = true;
      window.location.hash = lastWorkspaceHash.current;
    });
  }
  function changeSettingsTab(tab: string) {
    if (!personalSettingsTabs.has(tab)) return;
    setSettingsInitialTab(tab);
    const query = new URLSearchParams({
      tab,
      returnTo: lastWorkspaceHash.current.slice(1),
    });
    const hash = `#personal-settings?${query.toString()}`;
    currentHash.current = hash;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  }
  function changeProject(value: string | null) {
    if (value !== null && !me.projects.some((project) => project.id === value))
      return;
    requestNavigation(() => {
      setProjectId(value);
      if (page === 'cases') {
        setCaseScope(null);
        window.location.hash = 'cases';
      }
    });
  }
  const projectSelect = (
    <Select
      aria-label="当前项目"
      className="project-select"
      variant="borderless"
      suffixIcon={<AppIcon name="down" />}
      value={projectId ?? (isWorkspace ? '' : null)}
      options={[
        ...(isWorkspace ? [{ value: '', label: '无项目 · 个人工作台' }] : []),
        ...me.projects.map((project) => ({
          value: project.id,
          label: project.name,
        })),
      ]}
      placeholder={me.projects.length ? '未选择项目' : '暂无项目权限'}
      onChange={(value: string) => changeProject(value || null)}
      disabled={!isWorkspace && me.projects.length === 0}
    />
  );

  const accountMenu = [
    { key: 'settings', label: '个人设置', icon: <SettingOutlined /> },
    {
      key: 'logout',
      label: '退出登录',
      icon: <LogoutOutlined />,
      disabled: loggingOut,
    },
  ];

  let content: ReactNode;
  const notificationBell = (
    <NotificationBell
      unreadCount={notificationUnread}
      onClick={() => setNotificationsOpen(true)}
    />
  );
  if (page === 'workspace') content = null;
  else if (isPersonalSettings)
    content = (
      <PersonalSettings
        initialTab={settingsInitialTab}
        onTabChange={changeSettingsTab}
        user={me.user}
        onClose={closeSettings}
        onRefresh={onRefresh}
        onPasswordChanged={() => {
          navigationGranted.current = true;
          window.location.hash = lastWorkspaceHash.current;
          onPasswordChanged();
        }}
        onLogout={onLogout}
        projects={me.projects}
      />
    );
  else if (page === 'requirements')
    content = (
      <RequirementsPage
        key={selectedProject?.id ?? 'none'}
        me={me}
        project={selectedProject}
        onOpenCases={(scope) => {
          setCaseScope(scope);
          navigate('cases', scope);
        }}
      />
    );
  else if (page === 'cases')
    content = (
      <AssetsPage
        key={selectedProject?.id ?? 'none'}
        userId={me.user.id}
        project={selectedProject}
        scope={caseScope}
        onScopeChange={(scope) => {
          setCaseScope(scope);
          navigate('cases', scope);
        }}
      />
    );
  else if (page === 'plans')
    content = (
      <PlansPage
        key={selectedProject?.id ?? 'none'}
        userId={me.user.id}
        project={selectedProject}
      />
    );
  else if (page === 'knowledge')
    content = (
      <KnowledgePage
        key={selectedProject?.id ?? 'none'}
        project={selectedProject}
      />
    );
  else if (page === 'issues')
    content = (
      <IssuesPage
        key={selectedProject?.id ?? 'none'}
        me={me}
        project={selectedProject}
      />
    );
  else if (page === 'reports')
    content = (
      <ResultsPage
        key={selectedProject?.id ?? 'none'}
        userId={me.user.id}
        project={selectedProject}
      />
    );
  else if (page === 'api-regression')
    content = (
      <ApiWorkbenchPage
        key={selectedProject?.id ?? 'none'}
        userId={me.user.id}
        project={selectedProject}
      />
    );
  else if (page === 'settings')
    content = (
      <ProjectConfigurationPage
        key={selectedProject?.id ?? 'none'}
        project={selectedProject}
        me={me}
        onPersonalSettings={openSettings}
        onMembershipChanged={onRefresh}
      />
    );
  else if (page === 'platform-projects' && me.user.isPlatformAdmin)
    content = <PlatformProjects onRefresh={onRefresh} />;
  else if (page === 'platform-users' && me.user.isPlatformAdmin)
    content = <PlatformUsers onRefresh={onRefresh} />;
  else if (page === 'platform-models' && me.user.isPlatformAdmin)
    content = <PlatformModelSettings />;
  else if (page === 'usage' && me.user.isPlatformAdmin)
    content = <PlatformUsagePanel />;
  else if (page === 'business-confirmations')
    content = <BusinessConfirmationPage />;
  else if (page === 'external-mcp') content = <ExternalMcpDecisionsPage />;
  else if (isPlatformPage && !me.user.isPlatformAdmin)
    content = (
      <Result
        status="403"
        title="无权限访问此页面"
        subTitle="此入口需要当前平台管理员权限。"
      />
    );
  else if (page === 'overview')
    content = (
      <OverviewPage
        key={selectedProject?.id ?? 'none'}
        project={selectedProject}
      />
    );
  else content = <Placeholder label={currentLabel} project={selectedProject} />;

  return (
    <Layout className="app-shell">
      <Layout.Sider
        width={224}
        collapsedWidth={56}
        collapsed={collapsed}
        theme="light"
        className={`main-sidebar mainnav ${collapsed ? 'rail' : ''}`}
      >
        <div className={`brand-slot brand ${collapsed ? 'collapsed' : ''}`}>
          <img
            className="brand-lockup"
            src="/brand-f-horizontal.png"
            alt="AITestHub"
          />
          <img
            className="brand-icon"
            src="/brand-f-color.png"
            alt="AITestHub"
          />
        </div>
        <div className="nav-label">工作空间</div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          items={[
            ...pages.map((item) => ({ ...item, 'aria-label': item.label })),
            ...(me.user.isPlatformAdmin
              ? [
                  { type: 'divider' as const },
                  {
                    key: 'platform-projects',
                    label: '平台项目管理',
                    'aria-label': '平台项目管理',
                    icon: <ProjectOutlined />,
                  },
                  {
                    key: 'platform-users',
                    label: '平台账号管理',
                    'aria-label': '平台账号管理',
                    icon: <TeamOutlined />,
                  },
                  {
                    key: 'usage',
                    label: 'AI 使用监控',
                    'aria-label': 'AI 使用监控',
                    icon: <AppIcon name="settings" />,
                  },
                  {
                    key: 'platform-models',
                    label: '平台模型设置',
                    'aria-label': '平台模型设置',
                    icon: <AppIcon name="chart" />,
                  },
                ]
              : []),
          ]}
          onClick={({ key }) => navigate(key)}
        />
        <div className="sidebar-bottom navbottom">
          <Tooltip title={collapsed ? '展开导航' : '收起导航'}>
            <Button
              type="text"
              aria-label={collapsed ? '展开导航' : '收起导航'}
              className="iconbtn"
              icon={<AppIcon name="panel" />}
              onClick={() =>
                isWorkspace || isPersonalSettings
                  ? setWorkspaceExpanded((value) => !value)
                  : setBusinessCollapsed((value) => !value)
              }
            />
          </Tooltip>
          <p>
            AI 探索 · 人工判断
            <br />
            可追溯的测试协作
          </p>
        </div>
      </Layout.Sider>
      <Layout>
        {!isWorkspace && !isPersonalSettings && (
          <Layout.Header className="topbar globalbar" aria-label={currentLabel}>
            <div className="global-project-context">
              {!isPlatformPage && !isPersonalToolPage && (
                <div className="project-label">当前项目</div>
              )}
              {!isPlatformPage && !isPersonalToolPage && projectSelect}
              {(isPlatformPage || isPersonalToolPage) && (
                <Typography.Text strong>{currentLabel}</Typography.Text>
              )}
            </div>
            <Space>
              <AppearanceToggle
                dark={dark}
                pending={appearancePending}
                onToggle={() => void toggleAppearance()}
              />
              {notificationBell}
              <Dropdown
                menu={{
                  items: accountMenu,
                  onClick: ({ key }) => {
                    if (key === 'settings') openSettings();
                    else if (key === 'logout') {
                      setLoggingOut(true);
                      void onLogout()
                        .catch((err: unknown) =>
                          message.error(describeError(err)),
                        )
                        .finally(() => setLoggingOut(false));
                    }
                  },
                }}
                trigger={['click']}
              >
                <Button
                  type="text"
                  className="profile-button"
                  data-account-menu
                  aria-label="打开个人设置菜单"
                >
                  <Avatar size={32}>{me.user.displayName.slice(0, 2)}</Avatar>
                  <span className="profile-caption">
                    <b>{me.user.displayName}</b>
                    <small>
                      {me.user.isPlatformAdmin
                        ? '平台管理员'
                        : [
                            selectedProject?.isAdmin ? '项目管理员' : '',
                            ...(selectedProject?.roles.map(
                              (role) => roleLabels[role],
                            ) ?? []),
                          ]
                            .filter(Boolean)
                            .join(' · ') || '个人账号'}
                    </small>
                  </span>
                  <AppIcon name="down" />
                </Button>
              </Dropdown>
            </Space>
          </Layout.Header>
        )}
        <IdentityCommandRecovery userId={me.user.id} />
        <Layout.Content
          className={
            isWorkspace
              ? 'workspace-container'
              : isPersonalSettings
                ? 'personal-settings-container'
                : 'page-content'
          }
        >
          {(isWorkspace ||
            (isPersonalSettings && workspaceMounted.current)) && (
            <div hidden={!isWorkspace} className="workspace-route">
              <Suspense fallback={<Skeleton active />}>
                <Workspace
                  dark={dark}
                  onAppearance={() => void toggleAppearance()}
                  appearancePending={appearancePending}
                  notificationBell={notificationBell}
                  me={me}
                  project={selectedProject}
                  onProjectChange={changeProject}
                  onSettings={() => openSettings()}
                />
              </Suspense>
            </div>
          )}
          {!isWorkspace && (
            <Suspense fallback={<Skeleton active />}>{content}</Suspense>
          )}
        </Layout.Content>
      </Layout>
      <NotificationPanel
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        onUnreadCount={setNotificationUnread}
        onNavigate={(targetProjectId, path) => {
          if (
            targetProjectId &&
            !me.projects.some((project) => project.id === targetProjectId)
          ) {
            void message.error(
              '此通知的原项目当前不可访问，请刷新本人权限后核对。',
            );
            return;
          }
          if (targetProjectId) setProjectId(targetProjectId);
          setNotificationsOpen(false);
          const target = new URL(path, window.location.origin);
          window.location.hash = target.hash;
          if (
            target.hash.split('?')[0] === '#workspace' &&
            new URLSearchParams(target.hash.split('?')[1]).get('panel') ===
              'resources'
          )
            openSettings('resources');
        }}
      />
      {isWorkspace && (
        <div className="workspace-session-actions">
          <Tooltip title="退出登录">
            <Button
              type="text"
              icon={<LogoutOutlined />}
              aria-label="退出登录"
              loading={loggingOut}
              onClick={() => {
                setLoggingOut(true);
                void onLogout()
                  .catch((err: unknown) => message.error(describeError(err)))
                  .finally(() => setLoggingOut(false));
              }}
            />
          </Tooltip>
        </div>
      )}
    </Layout>
  );
}

class RenderBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not persist private page state in client logs. */
  }
  render() {
    return this.state.failed ? (
      <Result
        status="error"
        title="页面未能正常显示"
        subTitle="重新加载会读取当前服务状态。未收到回执的操作请先核对记录。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => window.location.reload()}
          >
            重新加载
          </Button>
        }
      />
    ) : (
      this.props.children
    );
  }
}

export function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [authNotice, setAuthNotice] = useState<string>();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const epoch = useRef(0);
  const meRequest = useRef(0),
    ownerScope = useRef<string | null>(null);
  useSessionRenewal(me?.user.id ?? null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestEpoch = epoch.current;
    const serial = ++meRequest.current;
    try {
      const response = await api('/me', signal ? { signal } : {}, meSchema);
      if (
        !signal?.aborted &&
        requestEpoch === epoch.current &&
        serial === meRequest.current
      ) {
        const scope = JSON.stringify([
          response.user.id,
          response.user.isPlatformAdmin,
          response.projects
            .map((project) => [
              project.id,
              project.isAdmin,
              [...project.roles].sort(),
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]);
        if (ownerScope.current !== null && ownerScope.current !== scope) {
          announceIdentityChange('account-security-changed');
          return;
        }
        ownerScope.current = scope;
        setIdentityOwner(response.user.id);
        setMe(response);
        setError(undefined);
        setAuthNotice(undefined);
      }
    } catch (err) {
      if (
        signal?.aborted ||
        requestEpoch !== epoch.current ||
        serial !== meRequest.current
      )
        return;
      if (isSessionDenial(err)) {
        if (ownerScope.current !== null) {
          announceIdentityChange(sessionDenialReason(err));
          return;
        }
        setMe(null);
        ownerScope.current = null;
        setIdentityOwner(null);
        setError(undefined);
      } else {
        setError(describeError(err));
        throw err;
      }
    } finally {
      if (
        !signal?.aborted &&
        requestEpoch === epoch.current &&
        serial === meRequest.current
      )
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  useEffect(() => {
    return subscribeIdentityChanges(() => {
      epoch.current += 1;
      ownerScope.current = null;
      setMe(null);
      setLoading(true);
      setError(undefined);
      setAuthNotice(identityChangeNotice(lastIdentityChangeReason()));
      void refresh().catch(() => undefined);
    });
  }, [refresh]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible')
        void refresh().catch(() => undefined);
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [refresh]);
  useEffect(() => {
    const listener = (event: Event) => {
      const reason: unknown =
        event instanceof CustomEvent ? event.detail?.reason : undefined;
      announceIdentityChange(
        reason === 'session-expired'
          ? 'session-expired'
          : reason === 'session-invalidated'
            ? 'account-security-changed'
            : 'session-unknown',
      );
    };
    window.addEventListener('aitesthub:session-expired', listener);
    return () =>
      window.removeEventListener('aitesthub:session-expired', listener);
  }, []);
  const mode = me?.user.theme ?? 'light';
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    epoch.current += 1;
    ownerScope.current = null;
    setMe(null);
    setLoading(false);
    setAuthNotice(undefined);
    setError(undefined);
  }

  return (
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      drawer={{
        closable: { placement: 'end' },
        closeIcon: <AppIcon name="x" />,
      }}
      modal={{ closeIcon: <AppIcon name="x" /> }}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        ...v3Theme(dark),
      }}
    >
      <AntApp>
        <RenderBoundary>
          {loading ? (
            <main className="loading-screen">
              <img src="/brand-f-color.png" alt="AITestHub" />
              <Skeleton active paragraph={{ rows: 3 }} title />
            </main>
          ) : error && !me ? (
            <Result
              status="error"
              title="无法读取登录状态"
              subTitle={error}
              extra={
                <Button
                  type="primary"
                  onClick={() => {
                    setLoading(true);
                    void refresh().catch(() => undefined);
                  }}
                >
                  重新连接
                </Button>
              }
            />
          ) : me ? (
            <SignedIn
              dark={dark}
              key={me.user.id}
              me={me}
              onRefresh={() => refresh()}
              onLogout={logout}
              onPasswordChanged={() => {
                epoch.current += 1;
                ownerScope.current = null;
                setMe(null);
                setLoading(false);
                setAuthNotice('密码已修改，请重新登录。');
              }}
            />
          ) : (
            <AuthPage
              onLogin={() => refresh()}
              {...(authNotice ? { initialMessage: authNotice } : {})}
            />
          )}
        </RenderBoundary>
      </AntApp>
    </ConfigProvider>
  );
}
