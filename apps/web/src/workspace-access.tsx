import { Button, Dropdown } from 'antd';
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import {
  workspaceAccessModeSchema,
  type WorkspaceAccessMode,
} from '../../../packages/contracts/src/workspace-access';

export function readWorkspaceAccess(ownerId: string): WorkspaceAccessMode {
  try {
    const saved = workspaceAccessModeSchema.safeParse(
      window.localStorage.getItem(`aitesthub:workspace-access:${ownerId}`),
    );
    return saved.success ? saved.data : 'restricted';
  } catch {
    return 'restricted';
  }
}

export function saveWorkspaceAccess(
  ownerId: string,
  mode: WorkspaceAccessMode,
) {
  try {
    window.localStorage.setItem(`aitesthub:workspace-access:${ownerId}`, mode);
  } catch {
    // The visible selection still applies to the next message in this session.
  }
}

export function WorkspaceAccessPicker({
  mode,
  disabled,
  onChange,
}: {
  mode: WorkspaceAccessMode;
  disabled: boolean;
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
      >
        {mode === 'full' ? '完全访问' : '受限访问'}
      </Button>
    </Dropdown>
  );
}
