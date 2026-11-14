import { AuxiliaryAction } from './auxiliary-action';
import {
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ReactNode, SetStateAction } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  FileAddOutlined,
  LinkOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { z } from 'zod';
import { requirementSchema } from '../../../packages/contracts/src/domain';
import {
  addRequirementVersionResourceInputSchema as addRequirementVersionInputSchema,
  createRequirementResourceInputSchema as createRequirementInputSchema,
  requirementCandidatesSchema,
  requirementVersionCreatedSchema,
} from '../../../packages/contracts/src/requirements';
import type { RequirementMaterialInput } from '../../../packages/contracts/src/requirements';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import { safeSourceLinkSchema } from '../../../packages/contracts/src/source-links';
import { uploadProjectFile } from './file-channel';
import {
  useProjectFileCapabilities,
  resourceByteLabel,
  webFileBinaryMaximumBytes,
  type FileCapabilities,
} from './file-capabilities';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import { ApiError } from './api';

export type Requirement = z.infer<typeof requirementSchema>;
type DraftMaterial = {
  id: string;
  purpose: RequirementMaterialInput['purpose'];
  originalName: string;
  sourceLink?: string;
  file?: File;
  fileResourceId?: string;
  registeredFileId?: string;
  acceptedCapabilities?: FileCapabilities;
  localFileId: string;
  readability: RequirementMaterialInput['readability'];
  state: 'local' | 'uploading' | 'verified' | 'failed';
  error?: string;
};
export const purposeLabels = {
  requirement: '主需求',
  prototype: 'HTML 原型',
  supplement: '补充说明',
};
export const readabilityLabels = {
  readable: '可读',
  unreadable: '不可读',
  notChecked: '未检查',
  partial: '部分可读',
};

export function RequirementComposer({
  projectId,
  requirement,
  open,
  onClose,
  onSaved,
}: {
  projectId: string;
  requirement: Requirement | null;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string, versionId: string) => Promise<void>;
}) {
  const [form] = Form.useForm<{
    title: string;
    businessNumber: string;
    summary: string;
  }>();
  const [materialRecord, setMaterialRecord] = useState<{
    key: object | null;
    items: DraftMaterial[];
  }>({ key: null, items: [] });
  const [readyScope, setReadyScope] = useState<object | null>(null);
  const [target, setTarget] = useState<Requirement | null>(requirement);
  const [pending, setPending] = useState(false);
  const [lookupPending, setLookupPending] = useState(false);
  const [adoptingVersion, setAdoptingVersion] = useState<string>();
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] =
    useState<z.infer<typeof requirementCandidatesSchema>>();
  const [link, setLink] = useState('');
  const [linkName, setLinkName] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const submissionId = useRef(crypto.randomUUID());
  const lookupGeneration = useRef(0);
  const identity = useSyncExternalStore(
      subscribeIdentityChanges,
      identityContextEpoch,
      identityContextEpoch,
    ),
    actor = currentIdentityOwner();
  const scope = useMemo(
    () => ({
      projectId,
      identity,
      actor,
      open,
      alive: false,
      ready: false,
      busy: false,
      abort: new AbortController(),
    }),
    [
      projectId,
      identity,
      actor,
      open,
      requirement?.id,
      requirement?.rowVersion,
    ],
  );
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const current = () =>
    activeScope.current === scope &&
    scope.alive &&
    scope.ready &&
    scope.open &&
    scope.actor !== null &&
    !scope.abort.signal.aborted &&
    scope.identity === identityContextEpoch() &&
    scope.actor === currentIdentityOwner();
  const assertCurrent = () => {
    if (!current())
      throw new ApiError(
        '当前身份或项目已变化，旧材料操作未继续；已发送的原提交请核对原回执。',
        409,
        'UPLOAD_CONTEXT_CHANGED',
      );
  };
  useLayoutEffect(() => {
    if (scope.abort.signal.aborted) scope.abort = new AbortController();
    scope.alive = true;
    return () => {
      scope.alive = false;
      scope.ready = false;
      scope.abort.abort();
    };
  }, [scope]);
  const capabilities = useProjectFileCapabilities(projectId, open),
    limits = capabilities.data?.limits;
  const countLimit = limits?.maxFilesPerBatch;
  const draftReady = readyScope === scope && scope.ready;
  const draftPending = draftReady && pending;
  const materials = materialRecord.key === scope ? materialRecord.items : [];
  const materialSignature = JSON.stringify(
    materials.map((item) => [
      item.id,
      item.purpose,
      item.originalName,
      item.sourceLink,
      item.readability,
    ]),
  );
  const currentMaterialSignature = useRef(materialSignature);
  currentMaterialSignature.current = materialSignature;
  useEffect(() => setCandidates(undefined), [materialSignature]);
  function setMaterials(change: SetStateAction<DraftMaterial[]>) {
    setMaterialRecord((previous) => {
      if (!current()) return previous;
      const owned = previous.key === scope ? previous.items : [];
      return {
        key: scope,
        items: typeof change === 'function' ? change(owned) : change,
      };
    });
  }
  const uniqueBytes = new Map<string, bigint>();
  for (const material of materials)
    if (material.file)
      uniqueBytes.set(
        material.fileResourceId ??
          material.registeredFileId ??
          material.localFileId,
        BigInt(material.file.size),
      );
  const materialBytes = [...uniqueBytes.values()].reduce(
    (sum, value) => sum + value,
    0n,
  );
  const uploadContext = (id: string) => ({
    signal: scope.abort.signal,
    isCurrent: current,
    onRegistered: (file: { id: string }) =>
      update(id, { registeredFileId: file.id }),
    onAccepted: (_file: unknown, caps: FileCapabilities) =>
      update(id, { acceptedCapabilities: caps }),
  });
  useEffect(() => {
    if (open && !scope.ready && capabilities.status === 'ready') {
      if (
        activeScope.current !== scope ||
        !scope.alive ||
        scope.actor === null ||
        scope.identity !== identityContextEpoch() ||
        scope.actor !== currentIdentityOwner() ||
        (requirement !== null && requirement.projectId !== projectId)
      )
        return;
      form.resetFields();
      form.setFieldsValue({
        title: requirement?.title ?? '',
        businessNumber: requirement?.businessNumber ?? '',
        summary: '',
      });
      scope.ready = true;
      setMaterials([]);
      setTarget(requirement);
      setError(undefined);
      setCandidates(undefined);
      setLink('');
      setLinkName('');
      setDiscardOpen(false);
      setPending(false);
      setLookupPending(false);
      submissionId.current = crypto.randomUUID();
      setReadyScope(scope);
    }
  }, [scope, form, capabilities.status]);

  function update(id: string, change: Partial<DraftMaterial>) {
    if (!current()) return;
    setMaterials((previous) =>
      current()
        ? previous.map((item) =>
            item.id === id ? { ...item, ...change } : item,
          )
        : previous,
    );
  }
  function requestClose() {
    if (
      activeScope.current !== scope ||
      !scope.alive ||
      !scope.open ||
      scope.busy
    )
      return;
    if (!draftReady) {
      onClose();
      return;
    }
    if (!current() || pending) return;
    if (
      materials.length ||
      form.isFieldsTouched() ||
      link.trim() ||
      linkName.trim() ||
      target?.id !== requirement?.id
    )
      setDiscardOpen(true);
    else onClose();
  }
  function addFile(file: File, selectedFiles: File[]) {
    if (!current() || !limits) {
      setError('材料限额尚未核对，请等待真实限额读取或重试。');
      return false;
    }
    if (materials.length + selectedFiles.length > limits.maxFilesPerBatch) {
      setError(
        `本次选择将超过当前每版本 ${limits.maxFilesPerBatch} 份材料限额，请减少选择后重新添加。`,
      );
      return false;
    }
    if (
      file.size > webFileBinaryMaximumBytes ||
      BigInt(file.size) > BigInt(limits.maxFileBytes)
    ) {
      setError(
        `「${file.name}」超过本次读取的单文件 ${resourceByteLabel(limits.maxFileBytes)} 限额。`,
      );
      return false;
    }
    const id = crypto.randomUUID();
    setMaterials((previous) =>
      current() && previous.length < limits.maxFilesPerBatch
        ? [
            ...previous,
            {
              id,
              localFileId: id,
              file,
              originalName: file.name,
              purpose: 'requirement',
              readability: 'notChecked',
              state: 'local',
            },
          ]
        : previous,
    );
    return false;
  }
  function addLink() {
    try {
      assertCurrent();
      if (!limits) throw new Error('材料限额尚未核对，请先读取真实限额。');
      if (!safeSourceLinkSchema.safeParse(link.trim()).success)
        throw new Error(
          '来源链接须为无账号、密码或Token认证参数的HTTP(S)地址。',
        );
      const url = new URL(link);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('来源链接须为无内嵌账号密码的 HTTP(S) 地址。');
      if (!linkName.trim()) throw new Error('请填写来源名称。');
      if (materials.length >= limits.maxFilesPerBatch)
        throw new Error(`当前每版本最多 ${limits.maxFilesPerBatch} 份材料。`);
      const id = crypto.randomUUID();
      setMaterials((previous) =>
        current()
          ? [
              ...previous,
              {
                id,
                localFileId: id,
                originalName: linkName.trim(),
                sourceLink: url.href,
                purpose: 'supplement',
                readability: 'notChecked',
                state: 'local',
              },
            ]
          : previous,
      );
      setLink('');
      setLinkName('');
      setError(undefined);
    } catch (err) {
      setError(describeError(err));
    }
  }
  async function lookup() {
    if (!current() || scope.busy) return;
    const lookupId = ++lookupGeneration.current;
    const title: unknown = form.getFieldValue('title');
    const number: unknown = form.getFieldValue('businessNumber');
    if (typeof title !== 'string' || !title.trim()) {
      setError('先填写需求名称，再查找候选。');
      return;
    }
    setLookupPending(true);
    scope.busy = true;
    setError(undefined);
    try {
      const finished: DraftMaterial[] = [];
      for (const material of materials) {
        if (material.file && !material.fileResourceId)
          finished.push(await uploadMaterial(material));
        else finished.push(material);
      }
      assertCurrent();
      const response = await api(
        `/projects/${projectId}/requirements/candidates`,
        {
          method: 'POST',
          signal: scope.abort.signal,
          body: {
            title,
            businessNumber:
              typeof number === 'string' && number.trim()
                ? number.trim()
                : null,
            ...(finished.length
              ? {
                  materials: finished.map((item, order) => ({
                    purpose: item.purpose,
                    originalName: item.originalName,
                    readability: item.readability,
                    order,
                    ...(item.fileResourceId
                      ? { fileResourceId: item.fileResourceId }
                      : {}),
                    ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
                  })),
                }
              : {}),
          },
        },
        requirementCandidatesSchema,
      );
      if (
        current() &&
        lookupId === lookupGeneration.current &&
        materialSignature === currentMaterialSignature.current &&
        form.getFieldValue('title') === title &&
        form.getFieldValue('businessNumber') === number
      )
        setCandidates((previous) => (current() ? response : previous));
    } catch (err) {
      if (current() && lookupId === lookupGeneration.current)
        setError(describeError(err));
    } finally {
      scope.busy = false;
      if (current() && lookupId === lookupGeneration.current)
        setLookupPending(false);
    }
  }
  async function adoptVersion(candidate: Requirement, versionId: string) {
    if (!current() || scope.busy) return;
    scope.busy = true;
    setAdoptingVersion(versionId);
    try {
      await onSaved(candidate.id, versionId);
      if (current()) onClose();
    } catch (failure) {
      if (current()) setError(describeError(failure));
    } finally {
      scope.busy = false;
      if (current()) setAdoptingVersion(undefined);
    }
  }
  async function uploadMaterial(material: DraftMaterial) {
    assertCurrent();
    if (!material.file)
      throw new Error('原文件不在当前草稿，请核对原登记，不自动换文件。');
    update(material.id, { state: 'uploading', error: '' });
    try {
      const uploaded = await uploadProjectFile(
        projectId,
        material.file,
        material.localFileId,
        undefined,
        uploadContext(material.id),
      );
      assertCurrent();
      const ready = {
        ...material,
        fileResourceId: uploaded.id,
        state: 'verified' as const,
      };
      update(material.id, ready);
      return ready;
    } catch (error) {
      update(material.id, { state: 'failed', error: describeError(error) });
      throw error;
    }
  }
  async function retransmit(material: DraftMaterial) {
    if (!current() || scope.busy || !material.registeredFileId) return;
    scope.busy = true;
    setPending(true);
    setError(undefined);
    try {
      await uploadMaterial(material);
    } catch (error) {
      if (current()) setError(describeError(error));
    } finally {
      scope.busy = false;
      if (current()) setPending(false);
    }
  }
  async function save(values: {
    title: string;
    businessNumber: string;
    summary: string;
  }) {
    if (!current() || scope.busy) return;
    if (!limits) {
      setError(
        '真实限额尚未核对，未开始新版本提交；已登记文件可在行内完整重传。',
      );
      return;
    }
    if (!materials.length) {
      setError('请至少选择一份文件或来源链接，并说明用途。');
      return;
    }
    setPending(true);
    scope.busy = true;
    const originalSubmissionId = submissionId.current;
    setError(undefined);
    try {
      const finished: DraftMaterial[] = [];
      for (const material of materials) {
        if (material.file && !material.fileResourceId) {
          finished.push(await uploadMaterial(material));
        } else finished.push(material);
      }
      const materialInputs: RequirementMaterialInput[] = finished.map(
        (item, order) => ({
          purpose: item.purpose,
          originalName: item.originalName,
          readability: item.readability,
          order,
          ...(item.fileResourceId
            ? { fileResourceId: item.fileResourceId }
            : {}),
          ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
        }),
      );
      const input = target
        ? addRequirementVersionInputSchema.parse({
            submissionId: originalSubmissionId,
            rowVersion: target.rowVersion,
            summary: values.summary ?? '',
            materials: materialInputs,
          })
        : createRequirementInputSchema.parse({
            projectId,
            submissionId: originalSubmissionId,
            title: values.title,
            businessNumber: values.businessNumber?.trim() || null,
            summary: values.summary ?? '',
            materials: materialInputs,
          });
      const path = `/projects/${projectId}/requirements${target ? `/${target.id}/versions` : ''}`;
      assertCurrent();
      const result = await api(
        path,
        { method: 'POST', body: input, signal: scope.abort.signal },
        requirementVersionCreatedSchema,
      );
      assertCurrent();
      await onSaved(result.requirement.id, result.version.id);
      assertCurrent();
      onClose();
    } catch (err) {
      if (current())
        setError(
          err instanceof z.ZodError
            ? err.issues.map((issue) => issue.message).join('；')
            : describeError(err),
        );
    } finally {
      scope.busy = false;
      if (current()) setPending(false);
    }
  }

  return (
    <>
      <Modal
        title={
          draftReady && target
            ? `上传新版本：${target.title}`
            : '新建需求与首版材料'
        }
        open={open}
        zIndex={uiLayers.dialog}
        width={1080}
        onCancel={requestClose}
        closable={!draftPending}
        maskClosable={!draftPending}
        keyboard={!draftPending}
        footer={
          <Space>
            <Button disabled={draftPending} onClick={requestClose}>
              取消
            </Button>
            <Button
              type="primary"
              loading={draftPending}
              disabled={
                !draftReady ||
                capabilities.status !== 'ready' ||
                lookupPending ||
                Boolean(adoptingVersion)
              }
              onClick={() => form.submit()}
            >
              {draftPending
                ? '完整上传与保存中'
                : target
                  ? '保存新版本'
                  : '创建需求'}
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        {capabilities.status === 'loading' && (
          <Typography.Paragraph type="secondary" aria-live="polite">
            正在读取当前项目文件限额…
          </Typography.Paragraph>
        )}
        {capabilities.status === 'error' && (
          <Alert
            className="section-alert"
            type="error"
            showIcon
            title={`文件限额未读取：${capabilities.error ?? '服务未返回可靠限额'}`}
            description="未采用静态默认或扩大限额；已登记文件仍可按原身份完整重传。"
            action={
              <Button size="small" onClick={capabilities.refresh}>
                重新读取
              </Button>
            }
          />
        )}
        {!draftReady ? (
          <Typography.Paragraph type="secondary">
            正在准备当前身份与项目的材料草稿…
          </Typography.Paragraph>
        ) : (
          <>
            {error && (
              <Alert
                className="section-alert"
                type="error"
                title={error}
                showIcon
              />
            )}
            <Form
              form={form}
              layout="vertical"
              onValuesChange={() => setCandidates(undefined)}
              onFinish={(values: {
                title: string;
                businessNumber: string;
                summary: string;
              }) => void save(values)}
            >
              <div className="requirement-form-grid">
                <Form.Item
                  name="title"
                  label="需求名称"
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      max: 200,
                      message: '请输入需求名称（不超过 200 字符）',
                    },
                  ]}
                >
                  <Input
                    maxLength={200}
                    disabled={pending || target !== null}
                  />
                </Form.Item>
                <Form.Item
                  name="businessNumber"
                  label="需求编号（可留空）"
                  rules={[{ max: 100, message: '编号不超过 100 字符' }]}
                >
                  <Input
                    maxLength={100}
                    disabled={pending || target !== null}
                  />
                </Form.Item>
              </div>
              {!requirement && (
                <Space className="section-alert" wrap>
                  <Button
                    icon={<SearchOutlined />}
                    onClick={() => void lookup()}
                    loading={lookupPending}
                    disabled={pending || target !== null}
                  >
                    查找已有需求
                  </Button>
                  <AuxiliaryAction
                    label="AI语义查找"
                    disabled={
                      pending ||
                      target !== null ||
                      capabilities.status !== 'ready'
                    }
                    source={async () => {
                      assertCurrent();
                      const values = await form.validateFields([
                        'title',
                        'businessNumber',
                        'summary',
                      ]);
                      const ready: RequirementMaterialInput[] = [];
                      for (const item of materials) {
                        let fileResourceId = item.fileResourceId;
                        if (item.file && !fileResourceId) {
                          fileResourceId = (await uploadMaterial(item))
                            .fileResourceId;
                        }
                        ready.push({
                          purpose: item.purpose,
                          originalName: item.originalName,
                          readability: item.readability,
                          order: ready.length,
                          ...(fileResourceId ? { fileResourceId } : {}),
                          ...(item.sourceLink
                            ? { sourceLink: item.sourceLink }
                            : {}),
                        });
                      }
                      assertCurrent();
                      return {
                        purpose: 'requirementLookup',
                        projectId,
                        title: values.title,
                        businessNumber: values.businessNumber?.trim() || null,
                        summary: values.summary ?? '',
                        materials: ready,
                      };
                    }}
                  />
                  {target && (
                    <Button
                      disabled={pending}
                      onClick={() => {
                        if (current())
                          setTarget((previous) =>
                            current() ? null : previous,
                          );
                      }}
                    >
                      改为独立新建
                    </Button>
                  )}
                </Space>
              )}
              {candidates && !target && (
                <CardLike>
                  <Alert
                    showIcon
                    type="warning"
                    title={candidates.lookupMessage}
                  />
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={candidates.candidates}
                    locale={{
                      emptyText:
                        '本次本地规则没有候选。语义查重未执行，不能认定不存在相似需求。',
                    }}
                    columns={[
                      { title: '候选名称', dataIndex: 'title' },
                      {
                        title: '编号',
                        dataIndex: 'businessNumber',
                        render: (value: string | null) => value ?? '—',
                      },
                      {
                        title: '匹配版本与最新版本',
                        render: (_, candidate) => (
                          <Space direction="vertical">
                            {candidates.exactMaterialMatches
                              .filter(
                                (match) => match.requirementId === candidate.id,
                              )
                              .map((match) => (
                                <Tag key={match.requirementVersionId}>
                                  完整材料相同 V{match.versionNo}
                                  {match.versionNo < match.latestVersionNo
                                    ? ` · 已有最新 V${match.latestVersionNo}`
                                    : ' · 最新版'}
                                </Tag>
                              ))}
                            <span>
                              最新 V
                              {candidates.latestVersions.find(
                                (version) =>
                                  version.requirementId === candidate.id,
                              )?.versionNo ?? '未取得'}
                            </span>
                          </Space>
                        ),
                      },
                      {
                        title: '归属选择',
                        render: (_, candidate) => (
                          <Space direction="vertical">
                            {candidates.exactMaterialMatches
                              .filter(
                                (match) => match.requirementId === candidate.id,
                              )
                              .map((match) => (
                                <Button
                                  key={match.requirementVersionId}
                                  disabled={Boolean(adoptingVersion)}
                                  loading={
                                    adoptingVersion ===
                                    match.requirementVersionId
                                  }
                                  onClick={() =>
                                    void adoptVersion(
                                      candidate,
                                      match.requirementVersionId,
                                    )
                                  }
                                >
                                  采用已有 V{match.versionNo}（不新建版本）
                                </Button>
                              ))}
                            {(() => {
                              const latest = candidates.latestVersions.find(
                                (version) =>
                                  version.requirementId === candidate.id,
                              );
                              return latest &&
                                !candidates.exactMaterialMatches.some(
                                  (match) =>
                                    match.requirementVersionId ===
                                    latest.requirementVersionId,
                                ) ? (
                                <Button
                                  disabled={Boolean(adoptingVersion)}
                                  loading={
                                    adoptingVersion ===
                                    latest.requirementVersionId
                                  }
                                  onClick={() =>
                                    void adoptVersion(
                                      candidate,
                                      latest.requirementVersionId,
                                    )
                                  }
                                >
                                  采用最新 V{latest.versionNo}（使用已有资料）
                                </Button>
                              ) : null;
                            })()}
                            <Button
                              disabled={Boolean(adoptingVersion)}
                              onClick={() => {
                                if (!current()) return;
                                setTarget(candidate);
                                form.setFieldsValue({
                                  title: candidate.title,
                                  businessNumber:
                                    candidate.businessNumber ?? '',
                                });
                              }}
                            >
                              作为该需求的新版本
                            </Button>
                          </Space>
                        ),
                      },
                    ]}
                  />
                  <p className="caption">
                    采用已有版本只打开并使用该版资料，不创建版本。要保留本次所选材料，可明确新建版本或继续独立新建；重复编号需修改或留空。
                  </p>
                </CardLike>
              )}
              {target && (
                <Alert
                  className="section-alert"
                  type="info"
                  showIcon
                  title={`明确为已有需求「${target.title}」新增版本，基准 ${target.rowVersion}`}
                  description="新版本保留旧材料与历史，不继承旧批准，也不自动升级已有测试计划。请选择本版完整材料，旧材料缺席不会删除旧原件。"
                />
              )}
              <Form.Item
                name="summary"
                label={target ? '本版变更说明' : '材料说明'}
                rules={[{ max: 10000, message: '说明不超过 10000 字符' }]}
              >
                <Input.TextArea
                  rows={3}
                  maxLength={10000}
                  showCount
                  disabled={pending}
                  placeholder="说明主需求、原型或补充材料的变化；此处不编辑需求原文"
                />
              </Form.Item>
            </Form>
            <Typography.Title level={5}>
              本版材料（{materials.length}/{countLimit ?? '—'}）
            </Typography.Title>
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={addFile}
              disabled={
                pending || !countLimit || materials.length >= countLimit
              }
            >
              <Button
                icon={<FileAddOutlined />}
                disabled={
                  pending || !countLimit || materials.length >= countLimit
                }
              >
                选择文件
              </Button>
            </Upload>
            <Typography.Paragraph type="secondary">
              保存或完整材料查找前按完整字节上传并验证
              SHA-256；中断后明确再次完整重传，不自动重试。本次读取限额：每文件
              {limits ? resourceByteLabel(limits.maxFileBytes) : '待核对'}
              ，每版唯一文件总量
              {limits ? resourceByteLabel(limits.maxSubmissionBytes) : '待核对'}
              ，最多{countLimit ?? '待核对'}
              份材料。已登记文件按原受理限额交付。可读性是人工标记，上传成功不代表平台已解析内容。
            </Typography.Paragraph>
            <Typography.Paragraph
              type={
                limits && materialBytes > BigInt(limits.maxSubmissionBytes)
                  ? 'warning'
                  : 'secondary'
              }
            >
              本版唯一文件预计总量 {resourceByteLabel(materialBytes.toString())}
              ；同一已登记资源只计一次，同内容不同资源分别计量。保存时由服务端按当前或原提交策略最终核对。
            </Typography.Paragraph>
            <Space.Compact block className="section-alert">
              <Input
                aria-label="来源名称"
                placeholder="来源名称"
                value={linkName}
                onChange={(event) => {
                  if (current()) setLinkName(event.target.value);
                }}
                disabled={pending}
                maxLength={512}
              />
              <Input
                aria-label="来源链接"
                placeholder="https://…（保存不代表已读取登录态内容）"
                value={link}
                onChange={(event) => {
                  if (current()) setLink(event.target.value);
                }}
                disabled={pending}
                maxLength={4000}
              />
              <Button
                icon={<LinkOutlined />}
                onClick={addLink}
                disabled={
                  pending || !countLimit || materials.length >= countLimit
                }
              >
                添加来源
              </Button>
            </Space.Compact>
            <Table<DraftMaterial>
              rowKey="id"
              size="small"
              dataSource={materials}
              pagination={false}
              scroll={{ x: 780 }}
              columns={[
                {
                  title: '材料名称',
                  render: (_, material) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{material.originalName}</Typography.Text>
                      {material.sourceLink ? (
                        <Typography.Text type="secondary">
                          来源链接 · 未自动读取
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          {material.file
                            ? `${(material.file.size / 1024).toFixed(1)} KiB`
                            : ''}
                        </Typography.Text>
                      )}
                      {material.error && (
                        <Typography.Text type="danger">
                          {material.error}
                        </Typography.Text>
                      )}
                      {material.acceptedCapabilities && (
                        <Typography.Text type="secondary">
                          原登记单文件限额{' '}
                          {resourceByteLabel(
                            material.acceptedCapabilities.limits.maxFileBytes,
                          )}{' '}
                          ·{' '}
                          {material.acceptedCapabilities.policy.source ===
                          'legacyDefault'
                            ? '旧版明确默认'
                            : '原受理策略'}
                        </Typography.Text>
                      )}
                    </Space>
                  ),
                },
                {
                  title: '用途',
                  render: (_, material) => (
                    <Select
                      aria-label={`材料用途：${material.originalName}`}
                      value={material.purpose}
                      disabled={pending}
                      style={{ width: 130 }}
                      options={Object.entries(purposeLabels).map(
                        ([value, label]) => ({ value, label }),
                      )}
                      onChange={(purpose: DraftMaterial['purpose']) =>
                        update(material.id, { purpose })
                      }
                    />
                  ),
                },
                {
                  title: '可读性（人工标记）',
                  render: (_, material) => (
                    <Select
                      aria-label={`材料可读性：${material.originalName}`}
                      value={material.readability}
                      disabled={pending}
                      style={{ width: 130 }}
                      options={Object.entries(readabilityLabels).map(
                        ([value, label]) => ({ value, label }),
                      )}
                      onChange={(readability: DraftMaterial['readability']) =>
                        update(material.id, { readability })
                      }
                    />
                  ),
                },
                {
                  title: '文件状态',
                  render: (_, material) =>
                    material.sourceLink ? (
                      <Tag>来源引用</Tag>
                    ) : (
                      <Tag
                        color={
                          material.state === 'verified'
                            ? 'green'
                            : material.state === 'failed'
                              ? 'red'
                              : 'default'
                        }
                      >
                        {
                          {
                            local: '待完整上传',
                            uploading: '上传/校验中',
                            verified: '字节已验证',
                            failed: '上传未完成',
                          }[material.state]
                        }
                      </Tag>
                    ),
                },
                {
                  title: '操作',
                  render: (_, material) => (
                    <Space size={0}>
                      {material.file &&
                        material.registeredFileId &&
                        material.state !== 'verified' && (
                          <Button
                            type="link"
                            size="small"
                            disabled={pending}
                            onClick={() => void retransmit(material)}
                          >
                            完整重传
                          </Button>
                        )}
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={pending}
                        onClick={() =>
                          setMaterials((previous) =>
                            current()
                              ? previous.filter(
                                  (item) => item.id !== material.id,
                                )
                              : previous,
                          )
                        }
                        aria-label={`移除材料 ${material.originalName}`}
                      >
                        移除
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
            <Typography.Paragraph type="secondary" className="section-alert">
              本次提交标识：
              <Typography.Text code>{submissionId.current}</Typography.Text>
              。未收到回执时先核对现有记录，再决定重传。
            </Typography.Paragraph>
          </>
        )}
      </Modal>
      <Modal
        title="尚有未保存的材料或输入"
        open={discardOpen && draftReady}
        zIndex={uiLayers.confirmation}
        onCancel={() => setDiscardOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscardOpen(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                if (!current()) return;
                setDiscardOpen(false);
                onClose();
              }}
            >
              放弃本次编辑
            </Button>
            <Button
              type="primary"
              onClick={() => {
                if (!current()) return;
                setDiscardOpen(false);
                form.submit();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          选择保存、放弃或继续编辑。已保存的需求版本与原件保持可追溯。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}

function CardLike({ children }: { children: ReactNode }) {
  return <div className="requirement-candidates">{children}</div>;
}
