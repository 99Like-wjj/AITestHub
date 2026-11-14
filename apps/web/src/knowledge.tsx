import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { App, Modal } from 'antd';
import { z } from 'zod';
import {
  knowledgeSpacesResponseSchema,
  knowledgeSpaceResponseSchema,
  knowledgeIndexResponseSchema,
  knowledgeEntryResponseSchema,
  knowledgeHistoryResponseSchema,
  knowledgeRestorePreviewSchema,
  knowledgeComparisonResponseSchema,
  knowledgeSelectionReceiptSchema,
  knowledgeSelectionHistorySchema,
  knowledgeChoiceSchema,
  knowledgeOperationStatusSchema,
  deleteKnowledgeEntryReceiptSchema,
  type KnowledgeIndexItem,
  type KnowledgeComparisonItem,
} from '../../../packages/contracts/src/knowledge';
import { meSchema } from '../../../packages/contracts/src/identity';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, ApiError, describeError } from './api';
import { useBusinessCommand } from './business-command';
import { uiLayers } from './ui-layers';
import type { Project } from './types';
import type { PreparedReference } from './workspace-references';
import {
  emptyKnowledgeDraft,
  draftFromKnowledge,
  parseKnowledgeDraft,
  parseKnowledgeManifest,
  pinKnowledgeReference,
  type KnowledgeDraft,
} from './knowledge-helpers';

type KSpace = z.infer<typeof knowledgeSpaceResponseSchema>['space'];
type EntryReply = z.infer<typeof knowledgeEntryResponseSchema>;
type History = z.infer<typeof knowledgeHistoryResponseSchema>;
type Comparison = z.infer<
  typeof knowledgeComparisonResponseSchema
>['comparison'];
type SelectionReceipt = z.infer<typeof knowledgeSelectionReceiptSchema>;
type Command = ReturnType<typeof useBusinessCommand>;
type Target = { project: Project; session: string };
const base = (id: string) => `/projects/${id}/knowledge`;
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const spaceLabel = (space: KSpace) => `${space.name} · ${space.id.slice(0, 8)}`;

function Icon({
  name,
}: {
  name: 'plus' | 'upload' | 'download' | 'book' | 'refresh';
}) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
    download: 'M12 3v13M7 11l5 5 5-5M4 17v4h16v-4',
    book: 'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3V4Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5V4Z',
    refresh: 'M20 10a8 8 0 1 0-1 8M20 4v6h-6',
  };
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
function Button({
  kind = '',
  icon,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: string;
  icon?: 'plus' | 'upload' | 'download' | 'book' | 'refresh';
}) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`btn ${kind} ${props.className ?? ''}`}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice mt ${error ? 'red' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

function Dialog({
  open,
  title,
  children,
  footer,
  wide = false,
  busy = false,
  zIndex = uiLayers.dialog,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  busy?: boolean;
  zIndex?: number;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={<h2>{title}</h2>}
      width={wide ? 1030 : 610}
      centered
      zIndex={zIndex}
      rootClassName="knowledge-page knowledge-modal"
      classNames={{
        container: `dialog ${wide ? 'wide' : ''}`,
        header: 'dialog-head',
        body: 'dialog-body',
        footer: 'dialog-foot',
        close: 'iconbtn',
      }}
      styles={{
        container: { padding: 0, maxHeight: '90vh' },
        body: { overflow: 'auto', minHeight: 0 },
        footer: { margin: 0 },
      }}
      destroyOnHidden
      mask={{ closable: !busy }}
      closable={!busy}
      keyboard={!busy}
      onCancel={onClose}
      footer={footer ?? <Button onClick={onClose}>关闭</Button>}
    >
      {children}
    </Modal>
  );
}
function EditDialog({
  title,
  children,
  command,
  dirty,
  onClose,
  onSave,
  wide = false,
  saveLabel = '确认保存知识',
  allowSave = true,
  submitting = command.pending,
  zIndex = uiLayers.dialog,
}: {
  title: string;
  children: ReactNode;
  command: Command;
  dirty: boolean;
  onClose: () => void;
  onSave: () => void;
  wide?: boolean;
  saveLabel?: string;
  allowSave?: boolean;
  submitting?: boolean;
  zIndex?: number;
}) {
  const [discard, setDiscard] = useState(false);
  function close() {
    if (command.pending) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Dialog
        open
        title={title}
        wide={wide}
        busy={command.pending}
        zIndex={zIndex}
        onClose={close}
        footer={
          <>
            <Button disabled={command.pending} onClick={close}>
              取消
            </Button>
            <Button
              kind="primary"
              disabled={command.pending || command.uncertain || !allowSave}
              onClick={onSave}
            >
              {submitting ? '正在提交…' : saveLabel}
            </Button>
          </>
        }
      >
        {command.error && <Notice error>{command.error}</Notice>}
        {command.uncertain && (
          <Notice>
            回执尚未确认，已停止重发。请用原提交标识只读查询；关闭编辑不会撤销可能已受理的操作。
          </Notice>
        )}
        {children}
        <details className="caption mt" open={command.uncertain}>
          <summary>操作标识与核对</summary>
          <p>
            本次提交标识：<code>{command.commandId}</code>
          </p>
        </details>
      </Dialog>
      <Dialog
        open={discard}
        title="有未保存修改"
        zIndex={Math.max(uiLayers.confirmation, zIndex + 100)}
        onClose={() => setDiscard(false)}
        footer={
          <>
            <Button onClick={() => setDiscard(false)}>继续编辑</Button>
            <Button kind="danger" onClick={onClose}>
              放弃本地修改
            </Button>
            <Button
              kind="primary"
              disabled={command.uncertain}
              onClick={() => {
                setDiscard(false);
                onSave();
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <p>放弃只清除本地输入，不撤销已经受理的业务。</p>
      </Dialog>
    </>
  );
}
function Recovery<T>({
  projectId,
  operation,
  command,
  schema,
  onRecovered,
}: {
  projectId: string;
  operation: string;
  command: Command;
  schema: z.ZodType<T>;
  onRecovered: (value: T) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  if (!command.uncertain) return null;
  return (
    <div className="mt">
      <Button
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void api(
            `${base(projectId)}/operation-status?operation=${encodeURIComponent(operation)}&key=${encodeURIComponent(command.commandId)}`,
            {},
            knowledgeOperationStatusSchema,
          )
            .then((result) => {
              if (result.command.status === 'completed') {
                const checked = schema.safeParse(result.command.response);
                if (!checked.success)
                  throw new Error(
                    '原操作已完成，但当前页面无法解析旧回执；请刷新资料，不能视为未发生。',
                  );
                command.confirmRecoveredReceipt();
                onRecovered(checked.data);
              } else
                setStatus(
                  `原操作状态：${result.command.status}。尚不能确定结果，未重复提交。`,
                );
            })
            .catch((error) =>
              setStatus(
                error instanceof ApiError && error.status === 404
                  ? '暂未检索到已提交回执，不代表原操作未发生；请继续只读核对。'
                  : describeError(error),
              ),
            )
            .finally(() => setChecking(false));
        }}
      >
        查询原操作回执
      </Button>
      {status && <p className="caption mt">{status}</p>}
    </div>
  );
}
function DraftFields({
  value,
  onChange,
  between,
}: {
  value: KnowledgeDraft;
  onChange: (value: KnowledgeDraft) => void;
  between?: ReactNode;
}) {
  function set(key: keyof KnowledgeDraft, text: string) {
    onChange({ ...value, [key]: text });
  }
  return (
    <>
      <label className="field-label">
        标题
        <input
          className="field"
          value={value.title}
          maxLength={200}
          onChange={(event) => set('title', event.target.value)}
        />
      </label>
      {between}
      <label className="field-label mt">
        正文
        <textarea
          value={value.body}
          rows={9}
          maxLength={100000}
          onChange={(event) => set('body', event.target.value)}
        />
      </label>
      <details className="mt">
        <summary className="caption">索引摘要、标签与非秘密引用</summary>
        <div className="formgrid mt">
          <label className="field-label full">
            索引摘要
            <textarea
              value={value.summary}
              rows={2}
              maxLength={2000}
              placeholder="未填写时使用正文前100字作为轻索引摘要"
              onChange={(event) => set('summary', event.target.value)}
            />
          </label>
          <label className="field-label full">
            标签（每行一个）
            <textarea
              value={value.tags}
              rows={2}
              onChange={(event) => set('tags', event.target.value)}
            />
          </label>
          <label className="field-label">
            结构化配置引用 JSON
            <textarea
              className="code-input"
              value={value.configurationRefs}
              rows={4}
              onChange={(event) => set('configurationRefs', event.target.value)}
            />
          </label>
          <label className="field-label">
            来源引用 JSON
            <textarea
              className="code-input"
              value={value.sourceRefs}
              rows={4}
              onChange={(event) => set('sourceRefs', event.target.value)}
            />
          </label>
        </div>
        <p className="caption mt">
          配置只填本项目 configurationId 与 description；来源可为
          requirementVersion / file / url，不复制密码、Token、源码或本地目录。
        </p>
      </details>
    </>
  );
}

function SpaceEditor({
  target,
  existing,
  onSaved,
  onClose,
  nested = false,
}: {
  target: Target;
  existing?: KSpace;
  onSaved: (space: KSpace) => void;
  onClose: () => void;
  nested?: boolean;
}) {
  const command = useBusinessCommand(target.session);
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const operation = existing
    ? 'knowledge.spaces.revise'
    : 'knowledge.spaces.create';
  async function save() {
    const result = await command.run((commandId) =>
      api(
        `${base(target.project.id)}/spaces${existing ? `/${existing.id}` : ''}`,
        {
          method: existing ? 'PUT' : 'POST',
          body: {
            commandId,
            name,
            description,
            ...(existing ? { rowVersion: existing.rowVersion } : {}),
          },
        },
        knowledgeSpaceResponseSchema,
      ),
    );
    if (result) onSaved(result.space);
  }
  return (
    <EditDialog
      title={existing ? '编辑子知识库' : '新增子知识库'}
      command={command}
      dirty={
        name !== (existing?.name ?? '') ||
        description !== (existing?.description ?? '')
      }
      onClose={onClose}
      onSave={() => void save()}
      saveLabel="保存子知识库"
      allowSave={Boolean(name.trim())}
      zIndex={nested ? uiLayers.nestedDialog : uiLayers.dialog}
    >
      <p className="caption mb">写入项目：{target.project.name}</p>
      <fieldset
        disabled={command.pending || command.uncertain}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <label className="field-label">
          子知识库名称
          <input
            className="field"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field-label mt">
          说明
          <textarea
            value={description}
            rows={3}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </fieldset>
      <Recovery
        projectId={target.project.id}
        operation={operation}
        command={command}
        schema={knowledgeSpaceResponseSchema}
        onRecovered={(result) => onSaved(result.space)}
      />
    </EditDialog>
  );
}

function EntryEditor({
  target,
  existing,
  initialSpaceId,
  onSaved,
  onCompare,
  onClose,
}: {
  target: Target;
  existing?: EntryReply;
  initialSpaceId: string;
  onSaved: () => void;
  onCompare: (target: Target, spaceId: string, manifest: string) => void;
  onClose: () => void;
}) {
  const command = useBusinessCommand(target.session);
  const initial = existing
    ? draftFromKnowledge(existing.revision.content)
    : emptyKnowledgeDraft();
  const [draft, setDraft] = useState(initial);
  const [spaces, setSpaces] = useState<KSpace[]>([]);
  const [spaceId, setSpaceId] = useState(
    existing?.entry.spaceId ?? initialSpaceId,
  );
  const [stale, setStale] = useState(false);
  const [spaceEditor, setSpaceEditor] = useState<Target>();
  const [loadError, setLoadError] = useState('');
  const baselineSpace = useRef(existing?.entry.spaceId ?? initialSpaceId);
  useEffect(() => {
    const abort = new AbortController();
    void api(
      `${base(target.project.id)}/spaces`,
      { signal: abort.signal },
      knowledgeSpacesResponseSchema,
    )
      .then((result) => {
        setSpaces(result.spaces);
        if (!spaceId && result.spaces[0]) {
          baselineSpace.current = result.spaces[0].id;
          setSpaceId(result.spaces[0].id);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setLoadError(describeError(error));
      });
    return () => abort.abort();
  }, [target.project.id]);
  const operation = existing ? 'knowledge.revise' : 'knowledge.create';
  async function save() {
    const saved = await command.run(async (commandId) => {
      const content = parseKnowledgeDraft(draft);
      if (!spaceId) throw new Error('请选择本次知识所属子库。');
      try {
        return await api(
          `${base(target.project.id)}/entries${existing ? `/${existing.entry.id}` : ''}`,
          {
            method: existing ? 'PUT' : 'POST',
            body: existing
              ? {
                  commandId,
                  ...(spaceId !== existing.entry.spaceId ? { spaceId } : {}),
                  rowVersion: existing.entry.rowVersion,
                  baseRevisionId: existing.entry.revisionId,
                  content,
                }
              : { commandId, spaceId, content },
          },
          knowledgeEntryResponseSchema,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 412) setStale(true);
        throw error;
      }
    });
    if (saved) onSaved();
  }
  return (
    <>
      <EditDialog
        title={existing ? '编辑项目知识' : '新增项目知识'}
        command={command}
        dirty={
          JSON.stringify(draft) !== JSON.stringify(initial) ||
          spaceId !== baselineSpace.current
        }
        onClose={onClose}
        onSave={() => void save()}
        wide
        allowSave={
          Boolean(draft.title.trim()) && Boolean(spaceId) && !loadError
        }
      >
        <p className="caption mb">
          写入项目：{target.project.name}
          {existing ? ` · 当前内容 r${existing.entry.revisionNo}` : ''}
        </p>
        {loadError && <Notice error>{loadError}</Notice>}
        <fieldset
          disabled={command.pending || command.uncertain}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <DraftFields
            value={draft}
            onChange={setDraft}
            between={
              <label className="field-label mt">
                子知识库
                <div className="row">
                  <select
                    className="grow"
                    value={spaceId}
                    onChange={(event) => setSpaceId(event.target.value)}
                  >
                    <option value="">请选择子知识库</option>
                    {spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {spaceLabel(space)}
                      </option>
                    ))}
                  </select>
                  <Button
                    kind="small"
                    onClick={() =>
                      setSpaceEditor({
                        ...target,
                        session: crypto.randomUUID(),
                      })
                    }
                  >
                    新增子库
                  </Button>
                </div>
              </label>
            }
          />
        </fieldset>
        <p className="caption mt">
          不保存秘密。知识维护及同步需明确提交，修改保留历史版本。
        </p>
        {stale && existing && (
          <Notice>
            平台内容已更新，本地正文仍保留。
            <div className="row mt">
              <Button
                onClick={() => {
                  try {
                    onCompare(
                      target,
                      spaceId,
                      JSON.stringify(
                        [
                          {
                            operation: 'upsert',
                            localId: existing.entry.id,
                            entryId: existing.entry.id,
                            baseRevisionId: existing.entry.revisionId,
                            content: parseKnowledgeDraft(draft),
                          },
                        ],
                        null,
                        2,
                      ),
                    );
                  } catch (error) {
                    command.setError(describeError(error));
                  }
                }}
              >
                保留本地草稿并进入比较
              </Button>
            </div>
          </Notice>
        )}
        <Recovery
          projectId={target.project.id}
          operation={operation}
          command={command}
          schema={knowledgeEntryResponseSchema}
          onRecovered={onSaved}
        />
      </EditDialog>
      {spaceEditor && (
        <SpaceEditor
          target={spaceEditor}
          nested
          onClose={() => setSpaceEditor(undefined)}
          onSaved={(space) => {
            setSpaces((rows) => [...rows, space]);
            setSpaceId(space.id);
            setSpaceEditor(undefined);
          }}
        />
      )}
    </>
  );
}

function HistoryDialog({
  target,
  entryId,
  onChanged,
  onClose,
  restoreMode = false,
}: {
  target: Target;
  entryId: string;
  onChanged: () => void;
  onClose: () => void;
  restoreMode?: boolean;
}) {
  const [history, setHistory] = useState<History>();
  const [selected, setSelected] = useState<EntryReply>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restore, setRestore] = useState<{
    session: string;
    preview: z.infer<typeof knowledgeRestorePreviewSchema>;
  }>();
  function reload() {
    setLoading(true);
    setError('');
    setSelected(undefined);
    void api(
      `${base(target.project.id)}/entries/${entryId}/history`,
      {},
      knowledgeHistoryResponseSchema,
    )
      .then(setHistory)
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [target.session, entryId]);
  function read(id: string) {
    setLoading(true);
    setSelected(undefined);
    setError('');
    void api(
      `${base(target.project.id)}/entries/${entryId}/revisions/${id}`,
      {},
      knowledgeEntryResponseSchema,
    )
      .then(setSelected)
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setLoading(false));
  }
  function prepareRestore(revisionId: string) {
    setLoading(true);
    setError('');
    void api(
      `${base(target.project.id)}/entries/${entryId}/restore-preview?revisionId=${revisionId}`,
      {},
      knowledgeRestorePreviewSchema,
    )
      .then((preview) => setRestore({ session: crypto.randomUUID(), preview }))
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setLoading(false));
  }
  return (
    <>
      <Dialog
        open
        title={restoreMode ? '恢复知识条目：选择历史版本' : '知识版本历史'}
        wide
        onClose={onClose}
        zIndex={uiLayers.detail}
      >
        <p className="caption mb">
          {target.project.name} ·
          历史正文固定保存，恢复生成新当前修订，不抹去后来历史。
          {restoreMode &&
            '请选择需要恢复的正文版本，再核对恢复影响；删除标记不可作为恢复正文。'}
        </p>
        {error && <Notice error>{error}</Notice>}
        {loading && <p className="caption">正在读取…</p>}
        <div className="two">
          <div className="card">
            {history?.revisions.map((revision) => (
              <div key={revision.id} className="run-row">
                <div className="between">
                  <strong>
                    r{revision.revisionNo} · {revision.title}
                  </strong>
                  <span className={`badge ${revision.deleted ? 'red' : ''}`}>
                    {revision.deleted ? '删除标记' : '正文修订'}
                  </span>
                </div>
                <p className="caption">{date(revision.createdAt)}</p>
                <div className="row mt">
                  <Button kind="small" onClick={() => read(revision.id)}>
                    查看正文
                  </Button>
                  <Button
                    kind="small"
                    disabled={revision.deleted || loading}
                    onClick={() => prepareRestore(revision.id)}
                  >
                    恢复此版本
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <section className="card pad">
            {selected ? (
              <>
                <div className="between">
                  <h3>{selected.revision.content.title}</h3>
                  <span className="caption">
                    r{selected.revision.revisionNo}
                  </span>
                </div>
                <pre className="code mt">
                  {selected.revision.content.body || '此修订没有正文。'}
                </pre>
                <p className="caption mt">
                  当前条目{selected.entry.deleted ? '已显式删除' : '仍可访问'}
                  ；此处只显示所选固定修订。
                </p>
              </>
            ) : (
              <div className="empty">
                <h2>选择一个修订</h2>
                <p>按需读取正文，不默认加载所有历史全文。</p>
              </div>
            )}
          </section>
        </div>
      </Dialog>
      {restore && (
        <RestoreDialog
          target={{ ...target, session: restore.session }}
          entryId={entryId}
          preview={restore.preview}
          onClose={() => setRestore(undefined)}
          onSaved={() => {
            setRestore(undefined);
            reload();
            setSelected(undefined);
            onChanged();
          }}
        />
      )}
    </>
  );
}
function RestoreDialog({
  target,
  entryId,
  preview,
  onSaved,
  onClose,
}: {
  target: Target;
  entryId: string;
  preview: z.infer<typeof knowledgeRestorePreviewSchema>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const command = useBusinessCommand(target.session);
  async function save() {
    const result = await command.run((commandId) =>
      api(
        `${base(target.project.id)}/entries/${entryId}/restore`,
        {
          method: 'POST',
          body: {
            commandId,
            baseRevisionId: preview.current.revisionId,
            rowVersion: preview.current.rowVersion,
            sourceRevisionId: preview.source.id,
          },
        },
        knowledgeEntryResponseSchema,
      ),
    );
    if (result) onSaved();
  }
  return (
    <EditDialog
      title="确认恢复知识版本"
      command={command}
      dirty={false}
      onClose={onClose}
      onSave={() => void save()}
      saveLabel="确认恢复为新修订"
      zIndex={uiLayers.confirmation}
      wide
    >
      <p>
        {target.project.name} · 将 r{preview.source.revisionNo}{' '}
        的内容恢复为新当前修订，当前 r{preview.current.revisionNo}{' '}
        及其后续历史继续保留。
      </p>
      <h3 className="mt">{preview.source.content.title}</h3>
      <pre className="code mt">{preview.source.content.body}</pre>
      <p className="caption mt">
        基准在提交前变化会报冲突，不会悄悄覆盖新内容。恢复正文不暗改当前子库组织。
      </p>
      <Recovery
        projectId={target.project.id}
        operation="knowledge.restore"
        command={command}
        schema={knowledgeEntryResponseSchema}
        onRecovered={onSaved}
      />
    </EditDialog>
  );
}

function RemoveDialog({
  target,
  entry,
  onSaved,
  onClose,
}: {
  target: Target;
  entry: KnowledgeIndexItem;
  onSaved: () => void;
  onClose: () => void;
}) {
  const command = useBusinessCommand(target.session);
  async function save() {
    const result = await command.run((commandId) =>
      api(
        `${base(target.project.id)}/entries/${entry.id}`,
        {
          method: 'DELETE',
          body: {
            commandId,
            rowVersion: entry.rowVersion,
            baseRevisionId: entry.revisionId,
          },
        },
        deleteKnowledgeEntryReceiptSchema,
      ),
    );
    if (result) onSaved();
  }
  return (
    <EditDialog
      title="确认删除项目知识"
      command={command}
      dirty={false}
      onClose={onClose}
      onSave={() => void save()}
      saveLabel="确认删除当前入口"
      zIndex={uiLayers.confirmation}
    >
      <p>
        {target.project.name} · <strong>{entry.title}</strong> · r
        {entry.revisionNo}
      </p>
      <Notice>
        只删除这一条当前入口。历史保留可恢复；后续知识引用与旧派生不再作为可读模型来源，不批量删除其他条目。
      </Notice>
      <Recovery
        projectId={target.project.id}
        operation="knowledge.explicit-delete"
        command={command}
        schema={deleteKnowledgeEntryReceiptSchema}
        onRecovered={onSaved}
      />
    </EditDialog>
  );
}

const classify = {
  create: '新增',
  update: '修改',
  explicitDelete: '明确删除',
  conflict: '冲突待选择',
  unchanged: '未变化',
};
function CompareDialog({
  target,
  initialSpaceId,
  initialText = '[]',
  initialComparison,
  onChanged,
  onClose,
}: {
  target: Target;
  initialSpaceId: string;
  initialText?: string;
  initialComparison?: Comparison;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [spaces, setSpaces] = useState<KSpace[]>([]);
  const [spaceId, setSpaceId] = useState(initialSpaceId);
  const [text, setText] = useState(initialText);
  const [asNew, setAsNew] = useState(false);
  const [comparison, setComparison] = useState<Comparison | undefined>(
    initialComparison,
  );
  const [round, setRound] = useState(0);
  const [choices, setChoices] = useState<
    Record<string, 'local' | 'remote' | 'merged'>
  >({});
  const [merged, setMerged] = useState<Record<string, KnowledgeDraft>>({});
  const [receipt, setReceipt] = useState<SelectionReceipt>();
  const [error, setError] = useState('');
  const [selectionHistory, setSelectionHistory] =
    useState<z.infer<typeof knowledgeSelectionHistorySchema>>();
  const [checkingHistory, setCheckingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    if (!comparison) return;
    const abort = new AbortController();
    setSelectionHistory(undefined);
    setCheckingHistory(true);
    setHistoryError('');
    void api(
      `${base(target.project.id)}/comparisons/${comparison.id}/selections`,
      { signal: abort.signal },
      knowledgeSelectionHistorySchema,
    )
      .then((result) => {
        if (!abort.signal.aborted) setSelectionHistory(result);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setHistoryError(describeError(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted) setCheckingHistory(false);
      });
    return () => abort.abort();
  }, [target.project.id, comparison?.id]);
  const compareCommand = useBusinessCommand(
    `${target.session}:compare:${round}`,
  );
  const commitCommand = useBusinessCommand(
    comparison ? `${target.session}:commit:${comparison.id}` : null,
  );
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    void api(
      `${base(target.project.id)}/spaces`,
      { signal: abort.signal },
      knowledgeSpacesResponseSchema,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        setSpaces(result.spaces);
        if (!spaceId && result.spaces[0]) setSpaceId(result.spaces[0].id);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      });
    return () => abort.abort();
  }, [target.project.id]);
  const locked =
    checkingHistory ||
    Boolean(historyError) ||
    compareCommand.pending ||
    compareCommand.uncertain ||
    commitCommand.pending ||
    commitCommand.uncertain;
  function invalidate(next: string) {
    setText(next);
    setComparison(undefined);
    setReceipt(undefined);
    setChoices({});
    setSelectionHistory(undefined);
    setRound((value) => value + 1);
  }
  async function compare() {
    setError('');
    const result = await compareCommand.run((commandId) => {
      if (!spaceId) throw new Error('请明确选择本次比较子库。');
      return api(
        `${base(target.project.id)}/comparisons`,
        {
          method: 'POST',
          body: {
            commandId,
            spaceId,
            localManifest: parseKnowledgeManifest(
              text,
              target.project.id,
              asNew,
            ),
          },
        },
        knowledgeComparisonResponseSchema,
      );
    });
    if (result) {
      setComparison(result.comparison);
      setReceipt(undefined);
      setChoices({});
    }
  }
  const mergeKey = (item: KnowledgeComparisonItem) =>
    item.localId ?? item.entryId ?? item.changeId;
  function selected(): z.infer<typeof knowledgeChoiceSchema>[] {
    if (!comparison) return [];
    return comparison.items.flatMap<z.infer<typeof knowledgeChoiceSchema>>(
      (item) => {
        const choice = choices[item.changeId];
        if (!choice) return [];
        if (choice === 'merged')
          return [
            {
              changeId: item.changeId,
              choice,
              content: parseKnowledgeDraft(
                merged[mergeKey(item)] ??
                  draftFromKnowledge(item.localContent!),
              ),
            },
          ];
        return [{ changeId: item.changeId, choice }];
      },
    );
  }
  async function commit() {
    if (!comparison) return;
    if (
      selectionHistory?.comparisonId !== comparison.id ||
      checkingHistory ||
      historyError ||
      selectionHistory.selections.length
    )
      return;
    const result = await commitCommand.run((commandId) => {
      const selections = selected();
      if (!selections.length)
        throw new Error('请逐项明确选择需要提交的本地、平台或合并内容。');
      return api(
        `${base(target.project.id)}/comparisons/${comparison.id}/commit`,
        {
          method: 'POST',
          body: {
            commandId,
            comparisonId: comparison.id,
            scopeDigest: comparison.scopeDigest,
            selections,
          },
        },
        knowledgeSelectionReceiptSchema,
      );
    });
    if (result) {
      setReceipt(result);
      onChanged();
    }
  }
  function mapCandidate(item: KnowledgeComparisonItem, id: string) {
    try {
      const manifest = parseKnowledgeManifest(text, target.project.id, asNew);
      const next = manifest.map((local) =>
        local.localId === item.localId && local.operation === 'upsert'
          ? { ...local, entryId: id, baseRevisionId: null }
          : local,
      );
      setAsNew(false);
      invalidate(JSON.stringify(next, null, 2));
    } catch (failure) {
      setError(describeError(failure));
    }
  }
  const activeCommand = comparison ? commitCommand : compareCommand;
  const hasPriorSelection = Boolean(selectionHistory?.selections.length);
  async function moreHistory() {
    if (!comparison || !selectionHistory?.nextCursor || checkingHistory) return;
    const prior = selectionHistory;
    setCheckingHistory(true);
    try {
      const result = await api(
        `${base(target.project.id)}/comparisons/${comparison.id}/selections?afterSelectionId=${prior.nextCursor}`,
        {},
        knowledgeSelectionHistorySchema,
      );
      setSelectionHistory({
        ...result,
        selections: [...prior.selections, ...result.selections],
      });
    } catch (failure) {
      setHistoryError(describeError(failure));
    } finally {
      setCheckingHistory(false);
    }
  }
  return (
    <EditDialog
      title="导入并比较项目知识"
      command={activeCommand}
      submitting={commitCommand.pending}
      dirty={
        receipt
          ? receipt.results.some((item) => item.status === 'conflict')
          : text !== initialText || Boolean(Object.keys(choices).length)
      }
      onClose={onClose}
      onSave={() => void commit()}
      saveLabel={`确认提交所选 ${Object.keys(choices).length} 项`}
      wide
      allowSave={
        Boolean(comparison) &&
        selectionHistory?.comparisonId === comparison?.id &&
        !hasPriorSelection &&
        Boolean(Object.keys(choices).length) &&
        !receipt &&
        !locked
      }
    >
      <p className="caption mb">
        写入项目：{target.project.name}
        。仅处理本次明确选择的子库/条目；未选项和清单缺席不代表删除。
      </p>
      {error && <Notice error>{error}</Notice>}
      {checkingHistory && <Notice>正在核对本人已有选择回执…</Notice>}
      {historyError && (
        <Notice error>
          {historyError} 当前未确认已有回执，未开放再次提交。
        </Notice>
      )}
      {initialComparison && (
        <Notice>
          已打开原比较范围。请核对两端内容并逐项选择；打开链接不会自动写入知识。
        </Notice>
      )}
      {compareCommand.error && comparison && (
        <Notice error>{compareCommand.error}</Notice>
      )}
      {!initialComparison && (
        <fieldset
          disabled={locked}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <div className="formgrid">
            <label className="field-label">
              本次比较子库
              <select
                value={spaceId}
                onChange={(event) => {
                  setSpaceId(event.target.value);
                  invalidate(text);
                }}
              >
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {spaceLabel(space)}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-label">
              本地知识包
              <div className="row wrap">
                <Button icon="upload" onClick={() => file.current?.click()}>
                  选择知识 JSON
                </Button>
                <Button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(text)
                      .catch(() =>
                        setError('未能复制，请直接从本地清单输入框复制。'),
                      );
                  }}
                >
                  复制保留的本地清单
                </Button>
              </div>
            </div>
          </div>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const selectedFile = event.target.files?.[0];
              if (!selectedFile) return;
              if (selectedFile.size > 512 * 1024) {
                setError('单次输入最多512KiB，请明确拆分范围，不会静默截断。');
                return;
              }
              void selectedFile
                .text()
                .then(invalidate)
                .catch(() => setError('未能读取所选文件。'));
              event.target.value = '';
            }}
          />
          <label className="field-label mt">
            本地清单 / 导出包 JSON
            <textarea
              className="code-input"
              value={text}
              rows={7}
              onChange={(event) => invalidate(event.target.value)}
            />
          </label>
          <label className="row mt">
            <input
              type="checkbox"
              checked={asNew}
              onChange={(event) => {
                setAsNew(event.target.checked);
                invalidate(text);
              }}
            />
            明确作为新条目复制，不复用原项目条目身份（引用仍需核对）
          </label>
          <p className="caption mt">
            支持知识导出包或 upsert / explicitDelete
            清单，最多100项。已映射UUID须属于所选子库；同名/同哈希只提示候选，不自动合并。不上传源码、目录或凭据。
          </p>
          <div className="row mt">
            <Button
              kind="primary"
              disabled={
                !spaceId || compareCommand.pending || Boolean(comparison)
              }
              onClick={() => void compare()}
            >
              {compareCommand.pending ? '正在比较…' : '比较双方清单'}
            </Button>
            <Button
              disabled={!comparison}
              onClick={() => {
                setComparison(undefined);
                setReceipt(undefined);
                setChoices({});
                setRound((value) => value + 1);
              }}
            >
              保留输入并重置比较
            </Button>
          </div>
        </fieldset>
      )}
      {!comparison && (
        <Recovery
          projectId={target.project.id}
          operation="knowledge.compare"
          command={compareCommand}
          schema={knowledgeComparisonResponseSchema}
          onRecovered={(result) => setComparison(result.comparison)}
        />
      )}
      {comparison && (
        <div className="stack mt">
          {comparison.items.map((item) => (
            <section key={item.changeId} className="card pad">
              <div className="between">
                <h3>
                  {item.localContent?.title ??
                    item.remoteIndex?.title ??
                    item.localId}
                </h3>
                <span
                  className={`badge ${item.classification === 'conflict' ? 'amber' : item.classification === 'explicitDelete' ? 'red' : ''}`}
                >
                  {classify[item.classification]}
                </span>
              </div>
              <p className="caption mt">{item.reason}</p>
              {item.matchCandidates.length > 0 && (
                <div className="notice mt">
                  发现可能同名的正式条目；不会自动当作同一身份。
                  <div className="row wrap mt">
                    {item.matchCandidates.map((candidate) => (
                      <Button
                        key={candidate.id}
                        kind="small"
                        disabled={
                          locked ||
                          Boolean(receipt) ||
                          hasPriorSelection ||
                          Boolean(initialComparison)
                        }
                        onClick={() => mapCandidate(item, candidate.id)}
                      >
                        明确映射 {candidate.title} · {candidate.id.slice(0, 8)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {item.localOperation !== null &&
                item.classification !== 'unchanged' && (
                  <>
                    <div className="two mt">
                      <div>
                        <span className="caption">本地提出的内容</span>
                        <pre className="code">
                          {item.localContent?.body ??
                            '明确删除此条目的当前入口，保留历史。'}
                        </pre>
                      </div>
                      <div>
                        <span className="caption">
                          平台比较时内容
                          {item.remoteIndex
                            ? ` · r${item.remoteIndex.revisionNo}`
                            : ''}
                          {item.remoteDeleted ? ' · 已删除' : ''}
                        </span>
                        <pre className="code">
                          {item.remoteContent?.body ?? '平台没有已映射条目。'}
                        </pre>
                      </div>
                    </div>
                    <fieldset
                      disabled={locked || Boolean(receipt) || hasPriorSelection}
                      style={{ border: 0, padding: 0, margin: 0 }}
                    >
                      <div className="row wrap mt">
                        {(
                          [
                            'local',
                            'remote',
                            ...(item.localOperation === 'upsert'
                              ? ['merged']
                              : []),
                          ] as ('local' | 'remote' | 'merged')[]
                        ).map((choice) => (
                          <label className="row" key={choice}>
                            <input
                              type="radio"
                              name={`knowledge-choice-${item.changeId}`}
                              checked={choices[item.changeId] === choice}
                              onChange={() => {
                                setChoices((values) => ({
                                  ...values,
                                  [item.changeId]: choice,
                                }));
                                if (choice === 'merged' && item.localContent)
                                  setMerged((values) => ({
                                    ...values,
                                    [mergeKey(item)]:
                                      values[mergeKey(item)] ??
                                      draftFromKnowledge(item.localContent!),
                                  }));
                              }}
                            />
                            {choice === 'local'
                              ? item.localOperation === 'explicitDelete'
                                ? '明确删除'
                                : '保留本地内容'
                              : choice === 'remote'
                                ? '保留平台内容'
                                : '人工编辑合并内容'}
                          </label>
                        ))}
                        <Button
                          kind="small"
                          onClick={() =>
                            setChoices((values) => {
                              const next = { ...values };
                              delete next[item.changeId];
                              return next;
                            })
                          }
                        >
                          本轮不提交
                        </Button>
                      </div>
                      {choices[item.changeId] === 'merged' && (
                        <div className="mt">
                          <DraftFields
                            value={
                              merged[mergeKey(item)] ??
                              draftFromKnowledge(item.localContent!)
                            }
                            onChange={(draft) =>
                              setMerged((values) => ({
                                ...values,
                                [mergeKey(item)]: draft,
                              }))
                            }
                          />
                        </div>
                      )}
                    </fieldset>
                  </>
                )}
            </section>
          ))}
        </div>
      )}
      {hasPriorSelection && (
        <Notice>
          此比较已有人工选择回执，保持原记录，不重复提交。剩余变更可在原本地工作稿中重新比较。
          {selectionHistory?.selections.map(
            ({ receipt: previous, createdAt }) => (
              <details key={previous.selectionId} className="mt">
                <summary>
                  {date(createdAt)} · 已处理 {previous.results.length} 项
                </summary>
                {previous.results.map((item) => (
                  <p key={item.changeId}>
                    {comparison?.items.find(
                      (candidate) => candidate.changeId === item.changeId,
                    )?.localContent?.title ??
                      comparison?.items.find(
                        (candidate) => candidate.changeId === item.changeId,
                      )?.remoteIndex?.title ??
                      '知识条目'}
                    ：
                    {
                      (
                        {
                          created: '已新增',
                          updated: '已更新',
                          deleted: '已删除',
                          keptRemote: '保留平台',
                          unchanged: '内容未变',
                          conflict: '冲突，未覆盖',
                        } as const
                      )[item.status]
                    }
                    {item.code ? `（${item.code}）` : ''}
                    <span className="caption">
                      {' '}
                      · 条目 {item.entryId ?? '—'} · 修订{' '}
                      {item.revisionId ?? '—'}
                    </span>
                  </p>
                ))}
              </details>
            ),
          )}
          {selectionHistory?.hasMore && (
            <Button
              disabled={checkingHistory}
              onClick={() => void moreHistory()}
            >
              读取更多原回执
            </Button>
          )}
        </Notice>
      )}
      {receipt && (
        <Notice
          error={receipt.results.some((item) => item.status === 'conflict')}
        >
          已处理 {receipt.results.length} 项，其中冲突{' '}
          {receipt.results.filter((item) => item.status === 'conflict').length}{' '}
          项。
          {receipt.results.map((item) => {
            const compared = comparison?.items.find(
              (candidate) => candidate.changeId === item.changeId,
            );
            const title =
              compared?.remoteIndex?.title ??
              compared?.localContent?.title ??
              compared?.localId ??
              item.entryId ??
              item.changeId;
            return (
              <p key={item.changeId}>
                <strong>{title}</strong>：
                {
                  (
                    {
                      created: '已新建',
                      updated: '已保存',
                      deleted: '已删除当前入口',
                      keptRemote: '保留平台，未写入',
                      unchanged: '内容未变',
                      conflict: '冲突，未覆盖',
                    } as const
                  )[item.status]
                }
                {item.code === 'STALE_BASE_REVISION'
                  ? '：比较后的平台内容已变化'
                  : item.code
                    ? `：需核对前置条件（${item.code}）`
                    : ''}
                {item.status === 'conflict' && item.remoteCurrent && (
                  <>
                    {' '}
                    （比较基准 r{compared?.remoteIndex?.revisionNo ?? '—'}
                    {' → '}回执时平台 r{item.remoteCurrent.revisionNo}；
                    本地输入保留，平台当前内容未覆盖）
                  </>
                )}
              </p>
            );
          })}
          冲突条目的本地输入与平台当前修订均保留。可保持本地输入重新比较。
        </Notice>
      )}
      {comparison && (
        <Recovery
          projectId={target.project.id}
          operation="knowledge.commit-selection"
          command={commitCommand}
          schema={knowledgeSelectionReceiptSchema}
          onRecovered={(result) => {
            setReceipt(result);
            onChanged();
          }}
        />
      )}
    </EditDialog>
  );
}

function ExportDialog({
  project,
  entries,
  hasMore,
  onMore,
  onClose,
}: {
  project: Project;
  entries: KnowledgeIndexItem[];
  hasMore: boolean;
  onMore: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      const selection = selected.map((id) => {
        const entry = entries.find((item) => item.id === id);
        if (!entry) throw new Error('所选索引已变化，请重新核对范围。');
        return { entryId: entry.id, revisionId: entry.revisionId };
      });
      const response = await fetch(
        `/api/v1${base(project.id)}/export?selection=${encodeURIComponent(JSON.stringify(selection))}`,
        {
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(180000),
        },
      );
      if (!response.ok) {
        if (response.status === 401)
          window.dispatchEvent(new Event('aitesthub:session-expired'));
        throw new Error(
          `导出未完成（HTTP ${response.status}），请检查当前项目权限/条目状态。`,
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'AITestHub-知识包.json';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title="导出知识包"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            kind="primary"
            disabled={busy || !selected.length}
            onClick={() => void download()}
          >
            {busy ? '正在生成…' : `导出所选 ${selected.length} 项`}
          </Button>
        </>
      }
    >
      <p className="caption">
        {project.name} ·
        明确选择本次导出条目，固定所选内容修订；不将当前页默当完整项目。每包最多20项，更多条目可分批导出。
      </p>
      {error && <Notice error>{error}</Notice>}
      <div className="stack mt">
        {entries
          .filter((entry) => !entry.deleted)
          .map((entry) => (
            <label key={entry.id} className="row">
              <input
                type="checkbox"
                checked={selected.includes(entry.id)}
                disabled={
                  busy ||
                  (selected.length >= 20 && !selected.includes(entry.id))
                }
                onChange={(event) =>
                  setSelected((items) =>
                    event.target.checked
                      ? [...items, entry.id]
                      : items.filter((id) => id !== entry.id),
                  )
                }
              />
              <span>{entry.title}</span>
              <span className="caption">r{entry.revisionNo}</span>
            </label>
          ))}
      </div>
      {hasMore && (
        <div className="mt">
          <Button disabled={busy} onClick={onMore}>
            加载更多轻索引以选择范围
          </Button>
        </div>
      )}
    </Dialog>
  );
}

export function KnowledgePage({ project }: { project: Project | null }) {
  const { message } = App.useApp();
  const [spaces, setSpaces] = useState<KSpace[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [query, setQuery] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [entries, setEntries] = useState<KnowledgeIndexItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<{
    target: Target;
    existing?: EntryReply;
    initialSpaceId: string;
  }>();
  const [spaceEditor, setSpaceEditor] = useState<{
    target: Target;
    existing?: KSpace;
  }>();
  const [history, setHistory] = useState<{
    target: Target;
    entryId: string;
    restoreMode?: boolean;
  }>();
  const [remove, setRemove] = useState<{
    target: Target;
    entry: KnowledgeIndexItem;
  }>();
  const [compare, setCompare] = useState<{
    target: Target;
    initialSpaceId: string;
    text?: string;
    comparison?: Comparison;
  }>();
  const [linkedHash, setLinkedHash] = useState(window.location.hash);
  useEffect(() => {
    const follow = () => setLinkedHash(window.location.hash);
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(linkedHash.split('?')[1]);
    const raw = query.get('comparisonId');
    if (!raw || !project) return;
    const id = idSchema.safeParse(raw);
    if (!id.success) {
      setError('知识比较链接的标识无效。');
      return;
    }
    if (query.get('projectId') !== project.id) {
      setError('此比较链接的项目当前不可访问或尚未选中。');
      return;
    }
    const abort = new AbortController();
    void api(
      `${base(project.id)}/comparisons/${id.data}`,
      { signal: abort.signal },
      knowledgeComparisonResponseSchema,
    )
      .then((result) => {
        if (!abort.signal.aborted)
          setCompare({
            target: { project, session: crypto.randomUUID() },
            initialSpaceId: result.comparison.spaceId,
            comparison: result.comparison,
          });
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      });
    return () => abort.abort();
  }, [project?.id, linkedHash]);
  const [exporting, setExporting] = useState<Project>();
  const generation = useRef(0);
  const currentProject = useRef(project?.id);
  currentProject.current = project?.id;
  useEffect(() => {
    setSpaceId('');
    setQuery('');
    setEntries([]);
    setSpaces([]);
    setError('');
    setExporting(undefined);
  }, [project?.id]);
  useEffect(() => {
    if (!project) return;
    const abort = new AbortController();
    void api(
      `${base(project.id)}/spaces`,
      { signal: abort.signal },
      knowledgeSpacesResponseSchema,
    )
      .then((result) => {
        if (!abort.signal.aborted) setSpaces(result.spaces);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      });
    return () => abort.abort();
  }, [project?.id, refresh]);
  useEffect(() => {
    if (!project) return;
    const abort = new AbortController();
    generation.current++;
    setLoading(true);
    setEntries([]);
    setCursor(null);
    setError('');
    const params = new URLSearchParams({
      query,
      includeDeleted: String(includeDeleted),
      limit: '50',
      ...(spaceId ? { spaceId } : {}),
    });
    void api(
      `${base(project.id)}/entries?${params}`,
      { signal: abort.signal },
      knowledgeIndexResponseSchema,
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setEntries(result.entries);
          setCursor(result.nextCursor);
          setHasMore(result.hasMore);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [project?.id, spaceId, query, includeDeleted, refresh]);
  function more() {
    if (!project || !cursor || loading) return;
    const epoch = generation.current;
    setLoading(true);
    const params = new URLSearchParams({
      query,
      includeDeleted: String(includeDeleted),
      limit: '50',
      afterId: cursor,
      ...(spaceId ? { spaceId } : {}),
    });
    void api(
      `${base(project.id)}/entries?${params}`,
      {},
      knowledgeIndexResponseSchema,
    )
      .then((result) => {
        if (generation.current === epoch) {
          setEntries((items) => [
            ...items,
            ...result.entries.filter(
              (entry) => !items.some((item) => item.id === entry.id),
            ),
          ]);
          setCursor(result.nextCursor);
          setHasMore(result.hasMore);
        }
      })
      .catch((failure) => {
        if (generation.current === epoch) setError(describeError(failure));
      })
      .finally(() => {
        if (generation.current === epoch) setLoading(false);
      });
  }
  function changed(target: Project, description = '已确认保存知识资料') {
    if (currentProject.current === target.id) setRefresh((value) => value + 1);
    void message.success(`项目“${target.name}”：${description}。`);
  }
  function edit(entry: KnowledgeIndexItem) {
    if (!project) return;
    const target = { project, session: crypto.randomUUID() };
    void api(
      `${base(project.id)}/entries/${entry.id}`,
      {},
      knowledgeEntryResponseSchema,
    )
      .then((existing) => {
        if (currentProject.current === target.project.id)
          setEditor({
            target,
            existing,
            initialSpaceId: existing.entry.spaceId,
          });
      })
      .catch((failure) => {
        if (currentProject.current === target.project.id)
          setError(describeError(failure));
      });
  }
  function prepareRemove(entry: KnowledgeIndexItem) {
    if (!project) return;
    const target = { project, session: crypto.randomUUID() };
    void api(
      `${base(project.id)}/entries/${entry.id}/history`,
      {},
      knowledgeHistoryResponseSchema,
    )
      .then((result) => {
        if (result.entry.deleted) throw new Error('条目已删除，请查看历史。');
        if (currentProject.current === target.project.id)
          setRemove({ target, entry: result.entry });
      })
      .catch((failure) => {
        if (currentProject.current === target.project.id)
          setError(describeError(failure));
      });
  }
  if (!project)
    return (
      <div className="knowledge-page">
        <div className="empty">
          <Icon name="book" />
          <h2>选择项目查看知识</h2>
          <p>知识按当前项目权限读取，不默认加载所有项目全文。</p>
        </div>
      </div>
    );
  const selectedSpace = spaces.find(
    (space) => space.id === spaceId && space.projectId === project.id,
  );
  const visibleEntries = entries.filter(
    (entry) => entry.projectId === project.id,
  );
  return (
    <div className="knowledge-page">
      <div className="heading">
        <div>
          <div className="eyebrow">PROJECT KNOWLEDGE</div>
          <h1>项目知识</h1>
          <p>轻索引与独立条目，按需读取；所有项目成员可维护。</p>
        </div>
        <div className="row wrap">
          <Button
            icon="download"
            disabled={
              loading || !visibleEntries.some((entry) => !entry.deleted)
            }
            onClick={() => setExporting(project)}
          >
            导出知识包
          </Button>
          <Button
            icon="upload"
            onClick={() =>
              setCompare({
                target: { project, session: crypto.randomUUID() },
                initialSpaceId: selectedSpace?.id ?? '',
              })
            }
          >
            导入并比较
          </Button>
          <Button
            kind="primary"
            icon="plus"
            onClick={() =>
              setEditor({
                target: { project, session: crypto.randomUUID() },
                initialSpaceId: selectedSpace?.id ?? '',
              })
            }
          >
            新增知识
          </Button>
        </div>
      </div>
      <div className="row wrap mb knowledge-filters">
        <label className="field-label">
          子知识库
          <select
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
          >
            <option value="">全部子知识库</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {spaceLabel(space)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label grow">
          检索标题、标签或正文
          <input
            className="field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入关键词，列表仅返回轻索引"
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(event) => setIncludeDeleted(event.target.checked)}
          />
          查看已删除入口
        </label>
        <Button
          kind="small"
          onClick={() =>
            setSpaceEditor({
              target: { project, session: crypto.randomUUID() },
            })
          }
        >
          新增子库
        </Button>
        {selectedSpace && (
          <Button
            kind="small"
            onClick={() =>
              setSpaceEditor({
                target: { project, session: crypto.randomUUID() },
                existing: selectedSpace,
              })
            }
          >
            编辑子库
          </Button>
        )}
        <Button
          icon="refresh"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {loading && !entries.length && (
        <div className="empty">
          <p>正在读取轻索引…</p>
        </div>
      )}
      <div className="two">
        {visibleEntries.map((entry) => (
          <section className="card pad" key={entry.id}>
            <div className="between">
              <span className="badge">
                {spaces.find((space) => space.id === entry.spaceId)?.name ??
                  '项目子库'}
              </span>
              <span className="caption">
                r{entry.revisionNo}
                {entry.deleted ? ' · 已删除' : ''}
              </span>
            </div>
            <h2 className="mt">{entry.title}</h2>
            <p className="caption mt">
              {entry.summary
                ? `${Array.from(entry.summary).slice(0, 100).join('')}${Array.from(entry.summary).length > 100 ? '…' : ''}`
                : '尚未填写索引摘要；点击后按需读取正文。'}
            </p>
            <div className="row mt">
              {!entry.deleted && (
                <Button kind="small" onClick={() => edit(entry)}>
                  查看 / 编辑
                </Button>
              )}
              {entry.deleted && (
                <Button
                  kind="small"
                  onClick={() =>
                    setHistory({
                      target: { project, session: crypto.randomUUID() },
                      entryId: entry.id,
                      restoreMode: true,
                    })
                  }
                >
                  恢复条目
                </Button>
              )}
              <Button
                kind="small"
                onClick={() =>
                  setHistory({
                    target: { project, session: crypto.randomUUID() },
                    entryId: entry.id,
                  })
                }
              >
                版本历史
              </Button>
              {!entry.deleted && (
                <Button
                  kind="small danger"
                  onClick={() => prepareRemove(entry)}
                >
                  删除
                </Button>
              )}
            </div>
          </section>
        ))}
      </div>
      {!loading && !error && !entries.length && (
        <div className="card empty">
          <Icon name="book" />
          <h2>当前范围没有知识条目</h2>
          <p>
            {query
              ? '请调整检索条件；没有返回内容不代表已读取全文。'
              : '可新增项目知识，或明确导入本地知识清单后比较。'}
          </p>
        </div>
      )}
      <div className="notice mt">
        环境、账号用途和连接使用同一份结构化配置。知识只记录非秘密说明，不复制密码或
        Token。
      </div>
      <div className="between mt">
        <span className="caption">
          已加载 {entries.length} 条轻索引{hasMore ? '，仍有更多条目' : ''}。
        </span>
        {hasMore && (
          <Button disabled={loading} onClick={more}>
            {loading ? '正在加载…' : '加载更多'}
          </Button>
        )}
      </div>
      {editor && (
        <EntryEditor
          key={editor.target.session}
          {...editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            changed(editor.target.project);
            setEditor(undefined);
          }}
          onCompare={(target, id, text) => {
            setEditor(undefined);
            setCompare({
              target: { ...target, session: crypto.randomUUID() },
              initialSpaceId: id,
              text,
            });
          }}
        />
      )}
      {spaceEditor && (
        <SpaceEditor
          key={spaceEditor.target.session}
          {...spaceEditor}
          onClose={() => setSpaceEditor(undefined)}
          onSaved={() => {
            changed(spaceEditor.target.project);
            setSpaceEditor(undefined);
          }}
        />
      )}
      {history && (
        <HistoryDialog
          key={history.target.session}
          {...history}
          onClose={() => setHistory(undefined)}
          onChanged={() => changed(history.target.project)}
        />
      )}
      {remove && (
        <RemoveDialog
          key={remove.target.session}
          {...remove}
          onClose={() => setRemove(undefined)}
          onSaved={() => {
            changed(remove.target.project, '已删除当前入口，历史保留');
            setRemove(undefined);
          }}
        />
      )}
      {compare && (
        <CompareDialog
          key={compare.target.session}
          target={compare.target}
          initialSpaceId={compare.initialSpaceId}
          {...(compare.text ? { initialText: compare.text } : {})}
          {...(compare.comparison
            ? { initialComparison: compare.comparison }
            : {})}
          onClose={() => {
            setCompare(undefined);
            if (compare.comparison) {
              const query = new URLSearchParams(
                window.location.hash.split('?')[1],
              );
              query.delete('comparisonId');
              window.history.replaceState(
                null,
                '',
                `${window.location.pathname}${window.location.search}#knowledge?${query}`,
              );
              setLinkedHash(window.location.hash);
            }
          }}
          onChanged={() => {
            if (currentProject.current === compare.target.project.id)
              setRefresh((value) => value + 1);
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          project={exporting}
          entries={visibleEntries}
          hasMore={hasMore}
          onMore={more}
          onClose={() => setExporting(undefined)}
        />
      )}
    </div>
  );
}

export function KnowledgeReferenceCandidates({
  projectId,
  remaining,
  onAdd,
}: {
  projectId: string | null;
  remaining: number;
  onAdd: (reference: PreparedReference) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sourceProject, setSourceProject] = useState(projectId ?? '');
  const [entries, setEntries] = useState<KnowledgeIndexItem[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    void api('/me', { signal: abort.signal }, meSchema)
      .then((result) => {
        setProjects(result.projects);
        if (!sourceProject && result.projects[0])
          setSourceProject(result.projects[0].id);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!sourceProject) return;
    const abort = new AbortController();
    generation.current++;
    setSelected([]);
    setEntries([]);
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ query, limit: '30' });
    void api(
      `${base(sourceProject)}/entries?${params}`,
      { signal: abort.signal },
      knowledgeIndexResponseSchema,
    )
      .then((result) => {
        if (!abort.signal.aborted) {
          setEntries(result.entries);
          setCursor(result.nextCursor);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [sourceProject, query]);
  function more() {
    if (!cursor || loading) return;
    const epoch = generation.current;
    setLoading(true);
    const params = new URLSearchParams({ query, limit: '30', afterId: cursor });
    void api(
      `${base(sourceProject)}/entries?${params}`,
      {},
      knowledgeIndexResponseSchema,
    )
      .then((result) => {
        if (epoch === generation.current) {
          setEntries((items) => [...items, ...result.entries]);
          setCursor(result.nextCursor);
        }
      })
      .catch((failure) => {
        if (epoch === generation.current) setError(describeError(failure));
      })
      .finally(() => {
        if (epoch === generation.current) setLoading(false);
      });
  }
  return (
    <div className="knowledge-page">
      <div className="formgrid">
        <label className="field-label">
          明确来源项目
          <select
            value={sourceProject}
            onChange={(event) => setSourceProject(event.target.value)}
          >
            <option value="">请选择来源项目</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          查找知识索引
          <input
            className="field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="标题、标签或正文关键词"
          />
        </label>
      </div>
      <p className="caption mt">
        这里仅展示轻索引。添加的是固定修订引用，尚未读取正文；来源与写入目标分开，发送时重新检查权限。
      </p>
      {error && <Notice error>{error}</Notice>}
      {loading && <p className="caption mt">正在检索索引…</p>}
      <div className="stack mt">
        {entries.map((entry) => (
          <label className="row" key={entry.id}>
            <input
              type="checkbox"
              checked={selected.includes(entry.id)}
              disabled={
                remaining <= 0 ||
                (selected.length >= remaining && !selected.includes(entry.id))
              }
              onChange={(event) =>
                setSelected((items) =>
                  event.target.checked
                    ? [...items, entry.id]
                    : items.filter((id) => id !== entry.id),
                )
              }
            />
            <span className="grow">
              <strong>{entry.title}</strong>
              <span className="caption">
                {' '}
                · r{entry.revisionNo}
                <br />
                {entry.summary}
              </span>
            </span>
          </label>
        ))}
      </div>
      {!loading && !error && sourceProject && !entries.length && (
        <p className="caption mt">没有可引用条目。</p>
      )}
      <div className="row wrap mt">
        {cursor && (
          <Button disabled={loading} onClick={more}>
            加载更多索引
          </Button>
        )}
        <Button
          kind="primary"
          disabled={!selected.length || selected.length > remaining || loading}
          onClick={() => {
            const projectName =
              projects.find((item) => item.id === sourceProject)?.name ??
              '来源项目';
            for (const entry of entries.filter((item) =>
              selected.includes(item.id),
            ))
              onAdd(pinKnowledgeReference(entry, projectName));
            setSelected([]);
          }}
        >
          添加所选固定引用
        </Button>
      </div>
    </div>
  );
}
