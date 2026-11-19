import { Button, Dropdown } from 'antd';
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultWorkspaceAccessMode,
  workspaceAccessModeSchema,
  workspaceAccessPreferenceSchema,
  type WorkspaceAccessMode,
  type WorkspaceAccessPreference,
} from '../../../packages/contracts/src/workspace-access';
import { api, describeError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';

function legacyWorkspaceAccess(ownerId: string): WorkspaceAccessMode | null {
  try {
    const saved = workspaceAccessModeSchema.safeParse(
      window.localStorage.getItem(`aitesthub:workspace-access:${ownerId}`),
    );
    return saved.success ? saved.data : null;
  } catch {
    return null;
  }
}

const accessPreferencePath = '/me/ai-preferences/workspace-access';

interface WorkspaceAccessState {
  ownerId: string;
  preference: WorkspaceAccessPreference | null;
  pending: boolean;
  error?: string;
}

export function useWorkspaceAccessPreference(ownerId: string) {
  const [state, setState] = useState<WorkspaceAccessState>();
  const request = useRef<AbortController | null>(null);
  const sync = useCallback(
    async (change?: { mode: WorkspaceAccessMode; rowVersion: number }) => {
      if (request.current || currentIdentityOwner() !== ownerId) return false;
      const controller = new AbortController();
      request.current = controller;
      const { signal } = controller;
      const epoch = identityContextEpoch();
      const active = () =>
        !signal.aborted &&
        epoch === identityContextEpoch() &&
        currentIdentityOwner() === ownerId;
      const read = () =>
        api(accessPreferencePath, { signal }, workspaceAccessPreferenceSchema);
      setState((previous) => ({
        ownerId,
        preference: previous?.ownerId === ownerId ? previous.preference : null,
        pending: true,
      }));
      try {
        let preference = change ?? (await read());
        if (!active()) return false;
        const desiredMode =
          change?.mode ??
          (preference.mode === null ? legacyWorkspaceAccess(ownerId) : null);
        let error: string | undefined;
        if (desiredMode !== null) {
          try {
            preference = await api(
              accessPreferencePath,
              {
                method: 'PUT',
                signal,
                body: {
                  commandId: crypto.randomUUID(),
                  mode: desiredMode,
                  rowVersion: preference.rowVersion,
                },
              },
              workspaceAccessPreferenceSchema,
            );
          } catch (saveError) {
            if (!active()) return false;
            preference = await read();
            if (!change && preference.mode === null) throw saveError;
            if (change && preference.mode !== desiredMode)
              error = '访问模式未保存，已加载账号当前选择。';
          }
        }
        if (!active()) return false;
        setState({
          ownerId,
          preference,
          pending: false,
          ...(error ? { error } : {}),
        });
        return !error;
      } catch (error) {
        if (active())
          setState({
            ownerId,
            preference: null,
            pending: false,
            error: `暂时无法确认账号访问模式。${describeError(error)}`,
          });
        return false;
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [ownerId],
  );
  useEffect(() => {
    void sync();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [sync]);
  const current = state?.ownerId === ownerId ? state : undefined;
  const preference = current?.preference;
  const ready = Boolean(preference) && !current?.pending;
  const mode: WorkspaceAccessMode = preference
    ? (preference.mode ?? defaultWorkspaceAccessMode)
    : 'restricted';
  return {
    ready,
    pending: current?.pending ?? true,
    error: current?.error,
    mode,
    reload: () => sync(),
    change: (mode: WorkspaceAccessMode) =>
      preference &&
      ready &&
      mode !== (preference.mode ?? defaultWorkspaceAccessMode)
        ? sync({ mode, rowVersion: preference.rowVersion })
        : Promise.resolve(false),
  };
}

export function WorkspaceAccessPicker({
  mode,
  disabled,
  loading,
  onChange,
}: {
  mode: WorkspaceAccessMode;
  disabled: boolean;
  loading: boolean;
  onChange: (mode: WorkspaceAccessMode) => void;
}) {
  return (
    <Dropdown
      trigger={['click']}
      placement="topLeft"
      disabled={disabled}
      classNames={{ root: 'workspace-access-menu' }}
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: [
          { key: 'heading', label: 'AI 可以访问哪些资料？', disabled: true },
          {
            key: 'restricted',
            icon: <LockOutlined />,
            label: (
              <span>
                <strong>受限访问</strong>
                <small>聊天与通用技能，不读取项目资料</small>
              </span>
            ),
          },
          {
            key: 'full',
            icon: <SafetyCertificateOutlined />,
            label: (
              <span>
                <strong>完全访问</strong>
                <small>读取有权访问的项目资料并使用业务工具</small>
              </span>
            ),
          },
        ],
        onClick: ({ key }) => {
          const value = workspaceAccessModeSchema.safeParse(key);
          if (value.success) onChange(value.data);
        },
      }}
    >
      <Button
        type="text"
        className={`workspace-access-trigger access-${mode}`}
        aria-label={`AI 访问模式：${mode === 'full' ? '完全访问' : '受限访问'}`}
        icon={
          mode === 'full' ? <SafetyCertificateOutlined /> : <LockOutlined />
        }
        disabled={disabled}
        loading={loading}
      >
        {mode === 'full' ? '完全访问' : '受限访问'}
      </Button>
    </Dropdown>
  );
}
