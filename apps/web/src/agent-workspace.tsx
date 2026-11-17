import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  List,
  Modal,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { FileOutlined, UploadOutlined } from '@ant-design/icons';
import {
  workspaceCommandReceiptSchema,
  workspaceHistorySchema,
  workspaceManifestSchema,
  workspaceMaximumTextBytes,
  workspacePathSchema,
  workspaceReceiptSchema,
  type WorkspaceEntry,
} from '../../../packages/contracts/src/agent-workspace';
import { api, ApiError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';
import { uploadPersonalFile } from './file-channel';

const { Text } = Typography;
const textTypes = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
]);

async function workspaceBlob(
  conversationId: string,
  entryId: string,
  revision?: number,
) {
  const epoch = identityContextEpoch();
  const response = await fetch(
    `/api/v1/me/conversations/${encodeURIComponent(conversationId)}/workspace/entries/${encodeURIComponent(entryId)}/content${revision === undefined ? '' : `?revision=${revision}`}`,
    {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok)
    throw new ApiError(
      `文件读取失败（HTTP ${response.status}）。`,
      response.status,
      'FILE_READ_FAILED',
    );
  const blob = await response.blob();
  if (epoch !== identityContextEpoch())
    throw new ApiError(
      '当前身份已变化，旧文件读取已停止。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  return blob;
}

/** A conversation owns this component; callers should key it by conversation identity. */
export function AgentWorkspace({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    entry: WorkspaceEntry | null;
    path: string;
    text: string;
    mediaType: string;
  } | null>(null);
  const [rename, setRename] = useState<{
    entry: WorkspaceEntry;
    path: string;
  } | null>(null);
  const [history, setHistory] = useState<Awaited<
    ReturnType<typeof readHistory>
  > | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const manifestRequest = useRef(0);
  const base = `/me/conversations/${encodeURIComponent(conversationId)}/workspace`;

  function guard() {
    const selected = generation.current,
      epoch = identityContextEpoch(),
      owner = currentIdentityOwner();
    return () =>
      selected === generation.current &&
      epoch === identityContextEpoch() &&
      owner === currentIdentityOwner();
  }
  async function readHistory(entryId: string) {
    return api(
      `${base}/entries/${entryId}/versions`,
      {},
      workspaceHistorySchema,
    );
  }
  async function refresh() {
    const current = guard();
    const request = ++manifestRequest.current;
    const result = await api(
      `${base}?includeDeleted=${includeDeleted}`,
      {},
      workspaceManifestSchema,
    );
    if (current() && request === manifestRequest.current)
      setEntries(result.entries);
  }
  useEffect(() => {
    generation.current += 1;
    setEntries([]);
    setEditor(null);
    setRename(null);
    setHistory(null);
    setPendingCommand(null);
    setError('');
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [conversationId]);
  useEffect(() => {
    if (!open) return;
    const current = guard();
    void refresh().catch((failure: unknown) => {
      if (current())
        setError(
          failure instanceof Error ? failure.message : '无法读取工作区。',
        );
    });
  }, [open, includeDeleted, conversationId]);

  async function run(work: (current: () => boolean) => Promise<void>) {
    if (inFlight.current || pendingCommand) return;
    inFlight.current = true;
    const current = guard();
    setBusy(true);
    setError('');
    try {
      await work(current);
    } catch (failure: unknown) {
      if (current())
        setError(
          failure instanceof Error
            ? failure.message
            : '操作未完成，请查询原回执。',
        );
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }
  async function command(
    path: string,
    body: Record<string, unknown>,
    current: () => boolean,
  ) {
    const commandId = crypto.randomUUID();
    try {
      const receipt = await api(
        `${base}/${path}`,
        { method: 'POST', body: { ...body, commandId } },
        workspaceReceiptSchema,
      );
      if (current()) {
        setEditor(null);
        setRename(null);
        setHistory(null);
        await refresh();
      }
      return receipt;
    } catch (failure: unknown) {
      if (current() && isUncertainMutationError(failure))
        setPendingCommand(commandId);
      throw failure;
    }
  }
  async function download(entry: WorkspaceEntry, revision?: number) {
    const current = guard();
    const blob = await workspaceBlob(conversationId, entry.id, revision);
    if (!current()) return;
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = entry.path.split('/').at(-1) ?? 'download';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <Button
        icon={<FileOutlined />}
        aria-label="会话文件"
        onClick={() => setOpen(true)}
      />
      <Drawer
        title="会话文件"
        open={open}
        onClose={() => setOpen(false)}
        size={600}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Text type="secondary">
            文件只属于当前会话。修改保留历史版本，下载需要当前访问权限。
          </Text>
          {error && <Alert type="error" title={error} />}
          {pendingCommand && (
            <Alert
              type="warning"
              title="原操作结果待核对，已暂停新写入。"
              description={
                <Button
                  onClick={() => {
                    const current = guard();
                    void api(
                      `${base}/commands/${encodeURIComponent(pendingCommand)}`,
                      {},
                      workspaceCommandReceiptSchema,
                    )
                      .then(async (result) => {
                        if (!current()) return;
                        if (result.found) {
                          setPendingCommand(null);
                          setError('');
                          await refresh();
                        } else
                          setError(
                            '尚未找到原回执，请稍后继续核对；不会自动重发。',
                          );
                      })
                      .catch((failure: unknown) => {
                        if (current())
                          setError(
                            failure instanceof Error
                              ? failure.message
                              : '核对未完成。',
                          );
                      });
                  }}
                >
                  查询原回执
                </Button>
              }
            />
          )}
          <Space wrap>
            <Upload
              showUploadList={false}
              disabled={busy || Boolean(pendingCommand)}
              beforeUpload={(file) => {
                void run(async (current) => {
                  const path = workspacePathSchema.parse(file.name);
                  const previous = entries.find((entry) => entry.path === path);
                  if (previous)
                    throw new Error(
                      '同名文件已存在，请先重命名已有文件或使用文本编辑。',
                    );
                  const uploaded = await uploadPersonalFile(
                    file,
                    crypto.randomUUID(),
                    { isCurrent: current },
                  );
                  if (current())
                    await command(
                      'import',
                      { path, resourceId: uploaded.id, expectedRowVersion: 0 },
                      current,
                    );
                });
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>上传文件</Button>
            </Upload>
            <Button
              disabled={busy || Boolean(pendingCommand)}
              onClick={() =>
                setEditor({
                  entry: null,
                  path: '',
                  text: '',
                  mediaType: 'text/plain',
                })
              }
            >
              新建文本
            </Button>
            <Checkbox
              checked={includeDeleted}
              onChange={(event) => setIncludeDeleted(event.target.checked)}
            >
              显示已移除
            </Checkbox>
          </Space>
          <List
            dataSource={entries}
            locale={{ emptyText: '当前会话还没有文件' }}
            renderItem={(entry) => (
              <List.Item>
                <Space orientation="vertical" style={{ width: '100%' }}>
                  <Space wrap>
                    <Text strong>{entry.path}</Text>
                    <Tag>版本 {entry.revision}</Tag>
                    {entry.deletedAt && <Tag>已移除</Tag>}
                    {!entry.available && <Tag color="warning">原件不可用</Tag>}
                  </Space>
                  <Text type="secondary">
                    {entry.bytes} 字节 · {entry.mediaType}
                  </Text>
                  <Space wrap>
                    <Button
                      size="small"
                      disabled={!entry.available || Boolean(entry.deletedAt)}
                      onClick={() => {
                        void run(async () => download(entry));
                      }}
                    >
                      下载
                    </Button>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => {
                        void run(async (current) => {
                          const result = await readHistory(entry.id);
                          if (current()) setHistory(result);
                        });
                      }}
                    >
                      历史版本
                    </Button>
                    {!entry.deletedAt && (
                      <>
                        <Button
                          size="small"
                          disabled={busy || Boolean(pendingCommand)}
                          onClick={() => setRename({ entry, path: entry.path })}
                        >
                          重命名
                        </Button>
                        {entry.available &&
                          textTypes.has(entry.mediaType) &&
                          BigInt(entry.bytes) <=
                            BigInt(workspaceMaximumTextBytes) && (
                            <Button
                              size="small"
                              disabled={busy || Boolean(pendingCommand)}
                              onClick={() => {
                                void run(async (current) => {
                                  const blob = await workspaceBlob(
                                    conversationId,
                                    entry.id,
                                  );
                                  const text = new TextDecoder('utf-8', {
                                    fatal: true,
                                  }).decode(await blob.arrayBuffer());
                                  if (current())
                                    setEditor({
                                      entry,
                                      path: entry.path,
                                      text,
                                      mediaType: entry.mediaType,
                                    });
                                });
                              }}
                            >
                              编辑文本
                            </Button>
                          )}
                        <Button
                          size="small"
                          danger
                          disabled={busy || Boolean(pendingCommand)}
                          onClick={() => {
                            void run(async (current) => {
                              await command(
                                `entries/${entry.id}`,
                                {
                                  action: 'remove',
                                  expectedRowVersion: entry.rowVersion,
                                },
                                current,
                              );
                            });
                          }}
                        >
                          移除
                        </Button>
                      </>
                    )}
                  </Space>
                </Space>
              </List.Item>
            )}
          />
        </Space>
      </Drawer>
      <Modal
        title={editor?.entry ? '编辑文本' : '新建文本'}
        open={Boolean(editor)}
        destroyOnHidden
        confirmLoading={busy}
        onCancel={() => setEditor(null)}
        onOk={() => {
          if (editor)
            void run(async (current) => {
              await command(
                'text',
                {
                  path: workspacePathSchema.parse(editor.path),
                  text: editor.text,
                  mediaType: editor.mediaType,
                  expectedRowVersion: editor.entry?.rowVersion ?? 0,
                },
                current,
              );
            });
        }}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            aria-label="文件路径"
            placeholder="例如 notes/计划.txt"
            value={editor?.path}
            disabled={Boolean(editor?.entry)}
            onChange={(event) =>
              setEditor((value) =>
                value ? { ...value, path: event.target.value } : null,
              )
            }
          />
          <Input.TextArea
            aria-label="文件正文"
            rows={16}
            value={editor?.text}
            onChange={(event) =>
              setEditor((value) =>
                value ? { ...value, text: event.target.value } : null,
              )
            }
          />
        </Space>
      </Modal>
      <Modal
        title="重命名"
        open={Boolean(rename)}
        confirmLoading={busy}
        onCancel={() => setRename(null)}
        onOk={() => {
          if (rename)
            void run(async (current) => {
              await command(
                `entries/${rename.entry.id}`,
                {
                  action: 'rename',
                  path: workspacePathSchema.parse(rename.path),
                  expectedRowVersion: rename.entry.rowVersion,
                },
                current,
              );
            });
        }}
      >
        <Input
          aria-label="新的文件路径"
          value={rename?.path}
          onChange={(event) =>
            setRename((value) =>
              value ? { ...value, path: event.target.value } : null,
            )
          }
        />
      </Modal>
      <Modal
        title={`${history?.entry.path ?? ''} 历史版本`}
        open={Boolean(history)}
        footer={null}
        onCancel={() => setHistory(null)}
      >
        <List
          dataSource={history?.versions ?? []}
          renderItem={(version) => (
            <List.Item>
              <Space wrap>
                <Text>
                  版本 {version.revision} · {version.bytes} 字节
                </Text>
                <Button
                  size="small"
                  disabled={!version.available || busy}
                  onClick={() => {
                    if (history)
                      void run(async () =>
                        download(history.entry, version.revision),
                      );
                  }}
                >
                  下载
                </Button>
                <Button
                  size="small"
                  disabled={
                    !version.available || busy || Boolean(pendingCommand)
                  }
                  onClick={() => {
                    if (history)
                      void run(async (current) => {
                        await command(
                          `entries/${history.entry.id}`,
                          {
                            action: 'restore',
                            expectedRowVersion: history.entry.rowVersion,
                            revision: version.revision,
                          },
                          current,
                        );
                      });
                  }}
                >
                  恢复此版本
                </Button>
              </Space>
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
}
