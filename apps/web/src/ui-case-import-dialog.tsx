import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { Asset } from '../../../packages/contracts/src/assets';
import {
  uiCaseImportInputSchema,
  uiCaseImportOperationStatusSchema,
  uiCaseImportPreviewInputSchema,
  uiCaseImportPreviewSchema,
  uiCaseImportReceiptSchema,
  type UiCaseImportPreview,
  type UiCaseImportPreviewInput,
  type UiCaseImportReceipt,
} from '../../../packages/contracts/src/ui-case-import';
import { idSchema } from '../../../packages/contracts/src/base';
import { api, describeError, isUncertainMutationError } from './api';
import { useBusinessCommand } from './business-command';
import { currentIdentityOwner } from './identity-context';
import { RecoveryBlock } from './recovery-block';
import type { CaseScope } from './requirements';
import { uiLayers } from './ui-layers';

type Source = UiCaseImportPreviewInput['sources'][number];
type Mapping = UiCaseImportPreviewInput['mappings'][number];
const keyFor = (index: number, id: string) => `${index}:${id}`;

export function UiCaseImportDialog({
  scope,
  userId,
  scenes,
  onClose,
  onImported,
}: {
  scope: CaseScope;
  userId: string;
  scenes: Asset[];
  onClose: () => void;
  onImported: (receipt: UiCaseImportReceipt) => Promise<void>;
}) {
  const path = `/projects/${scope.projectId}/assets`;
  const storageKey = `aitesthub:ui-case-import:${userId}:${scope.projectId}:${scope.requirementId}`;
  const [recoverId, setRecoverId] = useState(() => {
    try {
      return idSchema.safeParse(localStorage.getItem(storageKey)).data;
    } catch {
      return undefined;
    }
  });
  const [session, setSession] = useState(() => crypto.randomUUID());
  const command = useBusinessCommand(session);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<(Source & { id: string })[]>([]);
  const [preview, setPreview] = useState<UiCaseImportPreview>();
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [mappingsDirty, setMappingsDirty] = useState(false);
  const [reading, setReading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [receipt, setReceipt] = useState<UiCaseImportReceipt>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const previewController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => previewController.current?.abort(), []);
  const pathIndex = new Map(scenes.map((scene) => [scene.id, scene.title]));
  const fileBusy = useRef(false);
  const busy = reading || previewing || recovering || command.pending;
  const sources = [
    ...(text.trim() ? [{ label: '粘贴的 JSON', text }] : []),
    ...files.map(({ label, text: contents }) => ({ label, text: contents })),
  ];
  const selection = (preview?.packages ?? []).flatMap((packet) =>
    packet.scenes.flatMap((scene) =>
      scene.cases.flatMap((item) =>
        !packet.errors.length &&
        !scene.problems.length &&
        !item.problems.length &&
        item.action &&
        (selected[keyFor(packet.packageIndex, item.caseLocalId)] ??
          item.action === 'create')
          ? [
              {
                packageIndex: packet.packageIndex,
                caseLocalId: item.caseLocalId,
              },
            ]
          : [],
      ),
    ),
  );

  async function readFiles(next: File[]) {
    if (fileBusy.current || !next.length) return;
    fileBusy.current = true;
    setReading(true);
    setError(undefined);
    try {
      const contents = await Promise.all(
        next.map(async (file) => {
          const text = await file.text();
          if (!text.trim() || text.length > 1_000_000)
            throw new Error(`「${file.name}」为空或超过导入文本上限。`);
          return {
            id: crypto.randomUUID(),
            label: file.name || '剪贴板文件',
            text,
          };
        }),
      );
      if (currentIdentityOwner() !== userId) return;
      setFiles((previous) => [...previous, ...contents]);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      fileBusy.current = false;
      setReading(false);
    }
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    if (preview || busy || recoverId) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void readFiles(files);
  }

  async function loadPreview() {
    if (busy || recoverId || currentIdentityOwner() !== userId) return;
    const controller = new AbortController();
    previewController.current?.abort();
    previewController.current = controller;
    setPreviewing(true);
    setError(undefined);
    try {
      const input = uiCaseImportPreviewInputSchema.parse({
        requirementId: scope.requirementId,
        sources,
        mappings,
      });
      const result = await api(
        path + '/ui-import-previews',
        { method: 'POST', body: input, signal: controller.signal },
        uiCaseImportPreviewSchema,
      );
      if (controller.signal.aborted) return;
      setPreview(result);
      setMappingsDirty(false);
      setSession(crypto.randomUUID());
    } catch (failure) {
      if (!controller.signal.aborted) setError(describeError(failure));
    } finally {
      if (!controller.signal.aborted) setPreviewing(false);
    }
  }

  function changeMapping(
    packageIndex: number,
    sceneLocalId: string,
    target?: Mapping['target'],
  ) {
    setMappings((previous) => [
      ...previous.filter(
        (item) =>
          item.packageIndex !== packageIndex ||
          item.sceneLocalId !== sceneLocalId,
      ),
      ...(target ? [{ packageIndex, sceneLocalId, target }] : []),
    ]);
    setMappingsDirty(true);
  }

  async function showReceipt(result: UiCaseImportReceipt) {
    setReceipt(result);
    setRecoverId(undefined);
    command.confirmRecoveredReceipt();
    localStorage.removeItem(storageKey);
    await onImported(result);
  }

  async function apply() {
    if (
      busy ||
      recoverId ||
      !preview ||
      mappingsDirty ||
      !selection.length ||
      currentIdentityOwner() !== userId
    )
      return;
    const result = await command.run(async (commandId) => {
      const input = uiCaseImportInputSchema.parse({
        commandId,
        requirementId: scope.requirementId,
        sources,
        mappings,
        digest: preview.digest,
        selection,
      });
      localStorage.setItem(storageKey, commandId);
      try {
        return await api(
          path + '/ui-imports',
          { method: 'POST', body: input },
          uiCaseImportReceiptSchema,
        );
      } catch (failure) {
        if (isUncertainMutationError(failure)) setRecoverId(commandId);
        else localStorage.removeItem(storageKey);
        throw failure;
      }
    });
    if (result) {
      try {
        await showReceipt(result);
      } catch (failure) {
        setNotice(
          '已取得导入回执。读回目录时遇到问题。' + describeError(failure),
        );
      }
    }
  }

  async function recover() {
    if (!recoverId || recovering || currentIdentityOwner() !== userId) return;
    setRecovering(true);
    setNotice(undefined);
    try {
      const result = await api(
        `${path}/ui-imports/receipts/${recoverId}`,
        {},
        uiCaseImportOperationStatusSchema,
      );
      if (result.status === 'completed' && result.response)
        await showReceipt(result.response);
      else if (result.status === 'failed') {
        localStorage.removeItem(storageKey);
        setRecoverId(undefined);
        setSession(crypto.randomUUID());
        setNotice('已核对原导入失败。可检查输入后再次确认。');
      } else setNotice('原导入尚未确认，请稍后核对回执。');
    } catch (failure) {
      setNotice(describeError(failure));
    } finally {
      setRecovering(false);
    }
  }

  function back() {
    setPreview(undefined);
    setMappings([]);
    setMappingsDirty(false);
    setSelected({});
  }

  return (
    <Modal
      open
      width={980}
      zIndex={uiLayers.dialog}
      title={receipt ? '导入结果' : preview ? '确认导入范围' : '导入用例'}
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      keyboard={!busy}
      maskClosable={false}
      footer={
        receipt ? (
          <Button type="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <Space>
            <Button disabled={busy} onClick={onClose}>
              关闭
            </Button>
            {preview && !recoverId && (
              <Button disabled={busy} onClick={back}>
                返回编辑
              </Button>
            )}
            {!recoverId && (
              <Button
                type="primary"
                loading={busy}
                disabled={
                  preview && !mappingsDirty
                    ? !selection.length
                    : !sources.length
                }
                onClick={() =>
                  void (preview && !mappingsDirty ? apply() : loadPreview())
                }
              >
                {preview
                  ? mappingsDirty
                    ? '更新预览'
                    : `导入 ${selection.length} 条用例`
                  : '解析并预览'}
              </Button>
            )}
          </Space>
        )
      }
    >
      <div className="ui-case-import" onPaste={paste}>
        <Typography.Paragraph type="secondary">
          {scope.title}
        </Typography.Paragraph>
        {(error || command.error) && (
          <Alert type="error" showIcon title={error ?? command.error} />
        )}
        {notice && <Alert type="info" showIcon title={notice} />}
        {recoverId && (
          <RecoveryBlock
            variant="pending"
            title="核对原导入回执"
            reference={recoverId}
            actions={
              <Button loading={recovering} onClick={() => void recover()}>
                查询原回执
              </Button>
            }
          />
        )}
        {receipt ? (
          <>
            <Alert
              type="info"
              showIcon
              title={`已保存 ${receipt.items.filter((item) => item.status === 'accepted').length} 条，未保存 ${receipt.items.filter((item) => item.status === 'rejected').length} 条`}
            />
            <ul className="ui-case-import-receipts">
              {receipt.items.map((item) => {
                const packet = preview?.packages.find(
                  (entry) => entry.packageIndex === item.packageIndex,
                );
                const scene = packet?.scenes.find(
                  (entry) => entry.sceneLocalId === item.sceneLocalId,
                );
                const label = scene?.cases.find(
                  (entry) => entry.caseLocalId === item.caseLocalId,
                )?.title;
                return (
                  <li key={keyFor(item.packageIndex, item.caseLocalId)}>
                    <b>{label ?? item.caseLocalId}</b>
                    <span>
                      {packet?.label ?? `第 ${item.packageIndex + 1} 份草稿`} ·{' '}
                      {scene?.title ?? item.sceneLocalId}
                    </span>
                    {item.status === 'accepted' ? (
                      <span>
                        已保存 · {item.assetId} · 修订 {item.revisionId}
                      </span>
                    ) : (
                      <span>未保存 · {item.reason}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : preview ? (
          <>
            <div className="row wrap ui-case-import-summary">
              <Tag>{preview.packages.length} 份草稿</Tag>
              <Tag>
                {preview.packages.reduce(
                  (count, packet) => count + packet.scenes.length,
                  0,
                )}{' '}
                个场景
              </Tag>
              <Tag color="green">已选 {selection.length} 条</Tag>
            </div>
            {mappingsDirty && (
              <Alert type="info" title="场景映射已修改，请更新预览。" />
            )}
            <Collapse
              defaultActiveKey={preview.packages.map(
                (packet) => packet.packageIndex,
              )}
              items={preview.packages.map((packet) => ({
                key: packet.packageIndex,
                label: (
                  <Space>
                    {packet.label}
                    {packet.oldBasis && <Tag color="gold">基于旧资料</Tag>}
                  </Space>
                ),
                children: (
                  <>
                    {packet.errors.map((problem, index) => (
                      <Alert
                        key={index}
                        title={problem}
                        type="error"
                        showIcon
                      />
                    ))}
                    {packet.gaps.length > 0 && (
                      <ul>
                        {packet.gaps.map((gap, index) => (
                          <li key={index}>
                            {gap.blocksSubmission ? '阻塞' : '提示'} ·{' '}
                            {gap.description}
                          </li>
                        ))}
                      </ul>
                    )}
                    {packet.scenes.map((scene) => {
                      const mapping = mappings.find(
                        (entry) =>
                          entry.packageIndex === packet.packageIndex &&
                          entry.sceneLocalId === scene.sceneLocalId,
                      );
                      const target = mapping?.target ?? scene.target;
                      return (
                        <section
                          className="ui-case-import-scene"
                          key={scene.sceneLocalId}
                        >
                          <div className="row wrap">
                            <b>{scene.title}</b>
                            <Select
                              aria-label={`导入目标 · ${scene.title}`}
                              placeholder="请选择目标场景"
                              popupMatchSelectWidth={false}
                              value={
                                target?.kind === 'existing'
                                  ? target.sceneId
                                  : (target?.kind ?? null)
                              }
                              disabled={busy || Boolean(recoverId)}
                              options={[
                                { value: 'new', label: '新建场景' },
                                ...scenes.map((item) => ({
                                  value: item.id,
                                  label:
                                    (scene.matchedSceneIds.includes(item.id)
                                      ? '同名 · '
                                      : '') + item.title,
                                })),
                              ]}
                              onChange={(value: string) =>
                                changeMapping(
                                  packet.packageIndex,
                                  scene.sceneLocalId,
                                  value === 'new'
                                    ? { kind: 'new' }
                                    : { kind: 'existing', sceneId: value },
                                )
                              }
                            />
                            {target?.kind === 'new' && (
                              <Input
                                className="ui-case-import-scene-name"
                                aria-label={`新场景名称 · ${scene.title}`}
                                value={target.title ?? scene.title}
                                maxLength={200}
                                disabled={busy || Boolean(recoverId)}
                                onChange={(event) =>
                                  changeMapping(
                                    packet.packageIndex,
                                    scene.sceneLocalId,
                                    {
                                      kind: 'new',
                                      title: event.target.value,
                                    },
                                  )
                                }
                              />
                            )}
                          </div>
                          {target?.kind === 'existing' &&
                            !pathIndex.has(target.sceneId) && (
                              <Alert
                                type="warning"
                                title="预览指定的场景当前不可读取。"
                              />
                            )}
                          {scene.problems.length > 0 && (
                            <ul>
                              {scene.problems.map((reason, index) => (
                                <li key={index}>{reason}</li>
                              ))}
                            </ul>
                          )}
                          {scene.cases.map((item) => {
                            const id = keyFor(
                              packet.packageIndex,
                              item.caseLocalId,
                            );
                            return (
                              <div className="ui-case-import-entry" key={id}>
                                <Checkbox
                                  checked={
                                    Boolean(item.action) &&
                                    (selected[id] ?? item.action === 'create')
                                  }
                                  disabled={
                                    !item.action ||
                                    item.problems.length > 0 ||
                                    scene.problems.length > 0 ||
                                    packet.errors.length > 0 ||
                                    busy ||
                                    Boolean(recoverId)
                                  }
                                  onChange={(event) =>
                                    setSelected((previous) => ({
                                      ...previous,
                                      [id]: event.target.checked,
                                    }))
                                  }
                                >
                                  {item.title}
                                </Checkbox>
                                {item.action === 'revise' && (
                                  <Tag color="orange">保存新修订</Tag>
                                )}
                                {item.testPoint && <p>{item.testPoint}</p>}
                                {item.expected && (
                                  <p>整体预期 · {item.expected}</p>
                                )}
                                {item.problems.length > 0 && (
                                  <ul>
                                    {item.problems.map((reason, index) => (
                                      <li key={index}>{reason}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            );
                          })}
                        </section>
                      );
                    })}
                  </>
                ),
              }))}
            />
          </>
        ) : !recoverId ? (
          <>
            <label className="ui-case-import-input">
              <b>粘贴 Skill 草稿 JSON</b>
              <Input.TextArea
                value={text}
                rows={8}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
                placeholder="支持粘贴单份草稿或多份草稿组成的数组"
              />
            </label>
            <label className="ui-case-import-input">
              <b>选择 JSON 文件（可多选）</b>
              <input
                className="ui-case-import-file"
                type="file"
                accept=".json,application/json"
                multiple
                disabled={busy}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void readFiles(files);
                }}
              />
            </label>
            <p className="caption">
              也可粘贴 JSON 文件。请选择用例设计 Skill 输出的原始草稿。
            </p>
            {files.map((file) => (
              <div key={file.id} className="row spread">
                <span>{file.label}</span>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    setFiles((previous) =>
                      previous.filter((item) => item.id !== file.id),
                    )
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
