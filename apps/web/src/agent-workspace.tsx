import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  List,
  Modal,
  Segmented,
  Space,
  Typography,
  Upload,
} from 'antd';
import { FileOutlined, UploadOutlined } from '@ant-design/icons';
import {
  workspaceCommandReceiptSchema,
  workspaceHistorySchema,
  workspaceManifestSchema,
  workspaceReceiptSchema,
  type WorkspaceEntry,
} from '../../../packages/contracts/src/agent-workspace';
import type { z } from 'zod';
import { api, describeError, isUncertainMutationError } from './api';
import {
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import { uploadPersonalFile } from './file-channel';
import { FileCenter, FileListing, fileKindLabels } from './file-center';
import {
  FilePreview,
  downloadFileCenterEntry,
  type PreviewEntry,
} from './file-preview';
import { humanFileSize } from './file-preview-data';
import { uiLayers } from './ui-layers';

/** Current conversation shortcut over the same records used by the full file center. */
export function AgentWorkspace({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false),
    [center, setCenter] = useState(false),
    [entries, setEntries] = useState<WorkspaceEntry[]>([]),
    [kind, setKind] = useState('all'),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [selected, setSelected] = useState<PreviewEntry | null>(null),
    [history, setHistory] = useState<z.infer<typeof workspaceHistorySchema>>(),
    [pendingCommand, setPendingCommand] = useState<string>();
  const serial = useRef(0),
    abort = useRef<AbortController | undefined>(undefined);
  const base = `/me/conversations/${conversationId}/workspace`;
  const closePreview = useCallback(() => setSelected(null), []);
  const load = useCallback(async () => {
    const generation = ++serial.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    try {
      const result = await api(
        base,
        { signal: controller.signal },
        workspaceManifestSchema,
      );
      if (generation === serial.current) {
        setEntries(result.entries);
        setError(undefined);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(describeError(err));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }, [base]);
  useEffect(() => {
    if (open) void load();
    return () => abort.current?.abort();
  }, [open, load]);
  useEffect(
    () =>
      subscribeIdentityChanges(() => {
        serial.current++;
        abort.current?.abort();
        setEntries([]);
        setSelected(null);
        setHistory(undefined);
        setPendingCommand(undefined);
        setOpen(false);
        setCenter(false);
      }),
    [],
  );
  async function command(suffix: string, body: Record<string, unknown>) {
    const commandId = crypto.randomUUID();
    setPendingCommand(commandId);
    try {
      const result = await api(
        `${base}/${suffix}`,
        { method: 'POST', body: { ...body, commandId } },
        workspaceReceiptSchema,
      );
      setPendingCommand(undefined);
      await load();
      return result;
    } catch (err) {
      if (!isUncertainMutationError(err)) setPendingCommand(undefined);
      throw err;
    }
  }
  async function upload(file: File) {
    const epoch = identityContextEpoch();
    setPending(true);
    setError(undefined);
    try {
      const resource = await uploadPersonalFile(file, crypto.randomUUID(), {
        isCurrent: () => epoch === identityContextEpoch(),
      });
      if (epoch !== identityContextEpoch()) return;
      const path = `uploads/${resource.id}/${file.name}`;
      await command('import', {
        path,
        expectedRowVersion: 0,
        resourceId: resource.id,
      });
    } catch (err) {
      if (epoch === identityContextEpoch()) setError(describeError(err));
    } finally {
      if (epoch === identityContextEpoch()) setPending(false);
    }
  }
  async function versions(entry: PreviewEntry) {
    try {
      setHistory(
        await api(
          `${base}/entries/${entry.id}/versions`,
          {},
          workspaceHistorySchema,
        ),
      );
    } catch (err) {
      setError(describeError(err));
    }
  }
  const visible = entries
    .filter(
      (entry) => !entry.deletedAt && (kind === 'all' || entry.kind === kind),
    )
    .map((entry) => ({ ...entry, conversationId }));
  return (
    <>
      <Button
        type="text"
        aria-label="会话文件"
        icon={<FileOutlined />}
        onClick={() => setOpen(true)}
      />
      <Drawer
        title="当前对话文件"
        size="large"
        open={open}
        onClose={() => setOpen(false)}
        destroyOnHidden
      >
        <Space orientation="vertical" className="fullwidth">
          <div className="file-workspace-actions">
            <Typography.Text type="secondary">
              消息附件与 AI 成果统一展示；原始资料保持只读。
            </Typography.Text>
            <Button onClick={() => setCenter(true)}>打开文件中心</Button>
          </div>
          <Space wrap>
            <Upload
              showUploadList={false}
              beforeUpload={(file) => {
                void upload(file);
                return false;
              }}
              disabled={pending || Boolean(pendingCommand)}
            >
              <Button
                icon={<UploadOutlined />}
                disabled={pending || Boolean(pendingCommand)}
              >
                上传原始资料
              </Button>
            </Upload>
            <Button disabled={pending} onClick={() => void load()}>
              刷新列表
            </Button>
          </Space>
          {error ? <Alert type="error" showIcon title={error} /> : null}
          {pendingCommand ? (
            <Alert
              type="warning"
              title="原文件提交待核对，暂不发送新变更"
              action={
                <Button
                  onClick={() => {
                    void api(
                      `${base}/commands/${pendingCommand}`,
                      {},
                      workspaceCommandReceiptSchema,
                    )
                      .then((result) => {
                        if (result.found) {
                          setPendingCommand(undefined);
                          void load();
                        } else
                          setError('暂未读到原回执，请继续核对，不自动重传。');
                      })
                      .catch((err) => setError(describeError(err)));
                  }}
                >
                  核对原回执
                </Button>
              }
            />
          ) : null}
          <Segmented
            value={kind}
            onChange={(value) => setKind(String(value))}
            options={[
              { value: 'all', label: '全部' },
              ...Object.entries(fileKindLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <FileListing
            entries={visible}
            view="list"
            onPreview={setSelected}
            onVersions={(entry) => void versions(entry)}
            onChanged={() => void load()}
          />
        </Space>
      </Drawer>
      <FileCenter
        open={center}
        onClose={() => setCenter(false)}
        initialConversationId={conversationId}
      />
      <FilePreview
        entry={selected}
        entries={visible}
        onSelect={setSelected}
        onClose={closePreview}
      />
      <Modal
        title={`${history?.entry.originalName ?? history?.entry.path ?? ''} · 版本记录`}
        open={Boolean(history)}
        footer={null}
        zIndex={uiLayers.dialog}
        onCancel={() => setHistory(undefined)}
        destroyOnHidden
      >
        <List
          dataSource={history?.versions ?? []}
          renderItem={(version) => (
            <List.Item>
              <Space orientation="vertical" className="fullwidth">
                <Typography.Text strong>
                  版本 {version.revision}
                  {history?.entry.revision === version.revision
                    ? ' · 当前版本'
                    : ''}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {new Date(version.createdAt).toLocaleString()} ·{' '}
                  {humanFileSize(version.bytes)} ·{' '}
                  {version.provenance.createdByName ?? '历史主体未记录'}
                </Typography.Text>
                {version.provenance.baseRevision ? (
                  <span>基于版本 {version.provenance.baseRevision}</span>
                ) : null}
                {version.provenance.messageId ? (
                  <a href={`#workspace?conversationId=${conversationId}`}>
                    查看对应对话消息 {version.provenance.messageId}
                  </a>
                ) : null}
                <Space>
                  <Button
                    disabled={!version.available}
                    onClick={() => {
                      if (history) {
                        setSelected({
                          ...history.entry,
                          ...version,
                          conversationId,
                          rowVersion: history.entry.rowVersion,
                          updatedAt: version.createdAt,
                        });
                        setHistory(undefined);
                      }
                    }}
                  >
                    预览此版本
                  </Button>
                  <Button
                    disabled={!version.available}
                    onClick={() => {
                      if (history)
                        void downloadFileCenterEntry(
                          { ...history.entry, conversationId },
                          version.revision,
                        ).catch((err) => setError(describeError(err)));
                    }}
                  >
                    下载
                  </Button>
                  {history?.entry.kind !== 'original' ? (
                    <Button
                      disabled={pending || Boolean(pendingCommand)}
                      onClick={() => {
                        if (history)
                          void command(`entries/${history.entry.id}`, {
                            action: 'restore',
                            revision: version.revision,
                            expectedRowVersion: history.entry.rowVersion,
                          })
                            .then(() => setHistory(undefined))
                            .catch((err) => setError(describeError(err)));
                      }}
                    >
                      恢复为新版本
                    </Button>
                  ) : null}
                </Space>
              </Space>
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
}
