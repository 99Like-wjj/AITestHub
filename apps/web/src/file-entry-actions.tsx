import { useState } from 'react';
import { App, Button, Input, Modal, Space } from 'antd';
import {
  workspaceCommandReceiptSchema,
  workspacePathSchema,
  workspaceReceiptSchema,
} from '../../../packages/contracts/src/agent-workspace';
import type { PreviewEntry } from './file-preview';
import { api, describeError, isUncertainMutationError } from './api';
import { uiLayers } from './ui-layers';

/** Metadata management applies only to AI artifacts and unclassified historical files. */
export function FileEntryActions({
  entry,
  onChanged,
}: {
  entry: PreviewEntry;
  onChanged?: () => void;
}) {
  const { modal, message } = App.useApp();
  const [rename, setRename] = useState(false),
    [path, setPath] = useState(entry.path),
    [pending, setPending] = useState(false),
    [commandId, setCommandId] = useState<string>();
  if (entry.kind === 'original') return null;
  async function mutate(action: 'rename' | 'remove') {
    const id = crypto.randomUUID();
    setPending(true);
    setCommandId(id);
    try {
      await api(
        `/me/conversations/${entry.conversationId}/workspace/entries/${entry.id}`,
        {
          method: 'POST',
          body: {
            action,
            commandId: id,
            expectedRowVersion: entry.rowVersion,
            ...(action === 'rename'
              ? { path: workspacePathSchema.parse(path) }
              : {}),
          },
        },
        workspaceReceiptSchema,
      );
      setCommandId(undefined);
      setRename(false);
      onChanged?.();
    } catch (error) {
      if (!isUncertainMutationError(error)) setCommandId(undefined);
      void message.error(describeError(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Space>
        <Button
          size="small"
          disabled={pending || Boolean(commandId)}
          onClick={() => {
            setPath(entry.path);
            setRename(true);
          }}
        >
          重命名
        </Button>
        <Button
          size="small"
          danger
          disabled={pending || Boolean(commandId)}
          onClick={() =>
            modal.confirm({
              title: '移除此成果？',
              content:
                '仅关闭该成果的当前文件入口；原件保持不变，个人内容清理仍按既有规则处理。',
              okText: '移除',
              cancelText: '取消',
              zIndex: uiLayers.confirmation,
              onOk: () => mutate('remove'),
            })
          }
        >
          移除
        </Button>
        {commandId ? (
          <Button
            size="small"
            onClick={() => {
              void api(
                `/me/conversations/${entry.conversationId}/workspace/commands/${commandId}`,
                {},
                workspaceCommandReceiptSchema,
              )
                .then((result) => {
                  if (result.found) {
                    setCommandId(undefined);
                    setRename(false);
                    onChanged?.();
                  } else void message.warning('原回执尚未读到，未自动重发。');
                })
                .catch((error) => message.error(describeError(error)));
            }}
          >
            核对原回执
          </Button>
        ) : null}
      </Space>
      <Modal
        open={rename}
        title="重命名成果"
        okText="保存名称"
        cancelText="取消"
        zIndex={uiLayers.nestedDialog}
        onCancel={() => {
          if (!pending) setRename(false);
        }}
        onOk={() => void mutate('rename')}
        confirmLoading={pending}
        okButtonProps={{ disabled: Boolean(commandId) }}
      >
        <Input
          aria-label="成果文件路径"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          maxLength={512}
        />
      </Modal>
    </>
  );
}
