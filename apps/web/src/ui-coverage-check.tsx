import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Tag,
} from 'antd';
import { z } from 'zod';
import {
  coverageCheckpointListSchema,
  saveCoverageCheckpointInputSchema,
  saveCoverageCheckpointResultSchema,
  type CoverageCheckpoint,
} from '../../../packages/contracts/src/coverage-checkpoints';
import type { Asset } from '../../../packages/contracts/src/assets';
import { api, describeError, isUncertainMutationError } from './api';
import { ReviewStateTag } from './semantic-status';
import { currentIdentityOwner } from './identity-context';
import type { CaseScope } from './requirements';

const receiptSchema = z.strictObject({
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  response: saveCoverageCheckpointResultSchema.nullable(),
});

type EditorFields = {
  title: string;
  source: string;
  scenarioId?: string;
  caseIds: string[];
};

export function UiCoverageCheck({
  scope,
  userId,
  assets,
  scenarioId,
  open,
  tester,
  onClose,
  onCase,
  onSupplement,
}: {
  scope: CaseScope;
  userId: string;
  assets: Asset[];
  scenarioId: string | undefined;
  open: boolean;
  tester: boolean;
  onClose: () => void;
  onCase: (asset: Asset) => void;
  onSupplement: (checkpoint: CoverageCheckpoint) => void;
}) {
  const [items, setItems] = useState<CoverageCheckpoint[]>();
  const [error, setError] = useState<string>();
  const [missingOnly, setMissingOnly] = useState(false);
  const [edit, setEdit] = useState<CoverageCheckpoint | 'new'>();
  const [submitting, setSubmitting] = useState(false);
  const [uncertain, setUncertain] = useState<string>();
  const storageKey =
    'aitesthub:ui-checkpoint:' +
    userId +
    ':' +
    scope.projectId +
    ':' +
    scope.requirementVersionId;
  const [form] = Form.useForm<EditorFields>();
  useEffect(() => {
    try {
      const parsed = z.uuid().safeParse(localStorage.getItem(storageKey));
      setUncertain(parsed.success ? parsed.data : undefined);
    } catch {
      setUncertain(undefined);
    }
  }, [storageKey, open]);
  const path = `/projects/${scope.projectId}/assets/coverage-checkpoints`;
  const query = new URLSearchParams({
    kind: 'UI',
    requirementVersionId: scope.requirementVersionId,
  });
  const scopedAssets = assets.filter(
    (asset) =>
      asset.kind === 'UI' &&
      !asset.removedAt &&
      asset.requirementVersionId === scope.requirementVersionId,
  );
  const scenarios = scopedAssets.filter(
    (asset) => asset.targetType === 'scenario',
  );
  const caseAssets = new Map(
    scopedAssets
      .filter((asset) => asset.targetType === 'case')
      .map((asset) => [asset.id, asset]),
  );
  const entries = (items ?? [])
    .filter((item) => !scenarioId || item.scenarioId === scenarioId)
    .map((item) => ({
      item,
      linked: item.caseIds.flatMap((id) => caseAssets.get(id) ?? []),
    }));
  const covered = entries.filter(({ linked }) => linked.length).length;
  const rows = missingOnly
    ? entries.filter(({ linked }) => !linked.length)
    : entries;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setItems(undefined);
    setError(undefined);
    setMissingOnly(false);
    void api(
      path + '?' + query,
      { signal: controller.signal },
      coverageCheckpointListSchema,
    )
      .then(({ items }) => {
        if (!controller.signal.aborted) setItems(items);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      });
    return () => controller.abort();
  }, [open, path, scope.requirementVersionId]);

  function showEditor(item: CoverageCheckpoint | 'new') {
    form.resetFields();
    form.setFieldsValue(
      item === 'new'
        ? {
            title: '',
            source: '',
            ...(scenarioId ? { scenarioId } : {}),
            caseIds: [],
          }
        : {
            title: item.title,
            source: item.source,
            ...(item.scenarioId ? { scenarioId: item.scenarioId } : {}),
            caseIds: [...item.caseIds],
          },
    );
    setEdit(item);
  }
  function clearReceipt() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // A retained identifier only permits recovery of the original receipt.
    }
  }
  function accept(checkpoint: CoverageCheckpoint) {
    if (
      checkpoint.kind !== 'UI' ||
      checkpoint.requirementVersionId !== scope.requirementVersionId
    )
      throw new Error('检查点回执不属于所选需求版本。');
    clearReceipt();
    setItems((previous) => [
      ...(previous ?? []).filter((item) => item.id !== checkpoint.id),
      checkpoint,
    ]);
    setUncertain(undefined);
    setEdit(undefined);
    setError(undefined);
  }
  async function save() {
    const values = await form.validateFields().catch(() => undefined);
    if (!values || !edit || uncertain || submitting) return;
    const commandId = crypto.randomUUID();
    setSubmitting(true);
    setError(undefined);
    try {
      const body = saveCoverageCheckpointInputSchema.parse({
        ...values,
        scenarioId: values.scenarioId || null,
        commandId,
        kind: 'UI',
        requirementVersionId: scope.requirementVersionId,
        ...(edit === 'new'
          ? {}
          : { checkpointId: edit.id, rowVersion: edit.rowVersion }),
      });
      if (currentIdentityOwner() !== userId)
        throw new Error('请先核对当前账号。');
      localStorage.setItem(storageKey, commandId);
      if (localStorage.getItem(storageKey) !== commandId)
        throw new Error('无法保留操作标识，本次未发送。');
      let result;
      try {
        result = await api(
          path,
          { method: 'POST', body },
          saveCoverageCheckpointResultSchema,
        );
      } catch (failure) {
        if (isUncertainMutationError(failure)) setUncertain(commandId);
        else clearReceipt();
        throw failure;
      }
      try {
        accept(result.checkpoint);
      } catch (failure) {
        setUncertain(commandId);
        throw failure;
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSubmitting(false);
    }
  }
  async function recover() {
    if (!uncertain) return;
    setSubmitting(true);
    try {
      const result = await api(
        path + '/receipts/' + uncertain,
        {},
        receiptSchema,
      );
      if (result.status === 'completed' && result.response)
        accept(result.response.checkpoint);
      else if (result.status === 'failed') {
        clearReceipt();
        setUncertain(undefined);
        setError('已确认原检查点写入失败。');
      } else setError('原操作尚无法确认，暂不重复提交。');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSubmitting(false);
    }
  }
  const editorScenario = Form.useWatch('scenarioId', form);
  return (
    <Modal
      title={
        edit
          ? edit === 'new'
            ? '确认需求验收点'
            : '维护验收点关联'
          : '用例覆盖检查'
      }
      width={680}
      open={open}
      closable={!uncertain && !submitting}
      maskClosable={!uncertain && !submitting}
      keyboard={!uncertain && !submitting}
      onCancel={() => {
        if (submitting || uncertain) return;
        if (edit) setEdit(undefined);
        else onClose();
      }}
      footer={
        edit ? (
          <Space>
            <Button
              disabled={submitting || Boolean(uncertain)}
              onClick={() => setEdit(undefined)}
            >
              返回覆盖检查
            </Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={Boolean(uncertain)}
              onClick={() => void save()}
            >
              保存已确认验收点
            </Button>
          </Space>
        ) : (
          <Button disabled={submitting || Boolean(uncertain)} onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      <p className="caption">
        {scope.title} · v{scope.versionNo}
        {scenarioId &&
          ' · ' +
            (scenarios.find((item) => item.id === scenarioId)?.title ??
              '所选场景')}
      </p>
      {(error || uncertain) && (
        <Alert
          type="error"
          showIcon
          title={error ?? '有原检查点写入待核对。'}
          action={
            uncertain && (
              <Button loading={submitting} onClick={() => void recover()}>
                查询原回执
              </Button>
            )
          }
        />
      )}
      {edit ? (
        <Form
          form={form}
          layout="vertical"
          disabled={submitting || Boolean(uncertain)}
        >
          <Form.Item
            name="title"
            label="验收点"
            rules={[{ required: true, whitespace: true, max: 200 }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item
            name="source"
            label="需求来源"
            rules={[{ required: true, whitespace: true, max: 4000 }]}
          >
            <Input.TextArea
              maxLength={4000}
              placeholder="记录已确认需求中的条款、章节或验收来源"
            />
          </Form.Item>
          <Form.Item name="scenarioId" label="业务场景">
            <Select
              allowClear
              options={scenarios.map((asset) => ({
                value: asset.id,
                label: asset.title,
              }))}
              onChange={() => form.setFieldValue('caseIds', [])}
            />
          </Form.Item>
          <Form.Item name="caseIds" label="关联用例">
            <Select
              mode="multiple"
              optionFilterProp="label"
              options={[...caseAssets.values()]
                .filter(
                  (asset) =>
                    !editorScenario || asset.parentId === editorScenario,
                )
                .map((asset) => ({ value: asset.id, label: asset.title }))}
            />
          </Form.Item>
        </Form>
      ) : !items ? (
        !error && <Skeleton active />
      ) : (
        <div className="ui-case-coverage-controls">
          <p>按已确认的需求验收点核对用例关联。</p>
          <Space wrap>
            {entries.length > 0 && (
              <>
                <Tag>有用例 {covered}</Tag>
                <Tag>待补用例 {entries.length - covered}</Tag>
                <Button
                  size="small"
                  type={!missingOnly ? 'primary' : 'default'}
                  aria-pressed={!missingOnly}
                  onClick={() => setMissingOnly(false)}
                >
                  全部
                </Button>
                <Button
                  size="small"
                  type={missingOnly ? 'primary' : 'default'}
                  aria-pressed={missingOnly}
                  onClick={() => setMissingOnly(true)}
                >
                  只看待补
                </Button>
              </>
            )}
            {tester && (
              <Button size="small" onClick={() => showEditor('new')}>
                确认验收点
              </Button>
            )}
          </Space>
          {!entries.length ? (
            <Empty description="当前范围暂无可核对的已确认验收点。已有用例仍可在列表查看。" />
          ) : !rows.length ? (
            <Empty description="当前范围没有待补用例的验收点。" />
          ) : (
            <div className="ui-case-coverage-points">
              {rows.map(({ item, linked }) => {
                const scenario = scenarios.find(
                  (asset) => asset.id === item.scenarioId,
                );
                return (
                  <article className="ui-case-coverage-point" key={item.id}>
                    <header>
                      <span className="caption">
                        {scenario?.title ?? '该版本通用'} · {item.id}
                      </span>
                      <Tag color={linked.length ? 'green' : 'gold'}>
                        {linked.length ? '有用例' : '待补用例'}
                      </Tag>
                    </header>
                    <h3>{item.title}</h3>
                    <p className="caption preserve-lines">{item.source}</p>
                    {linked.length ? (
                      linked.map((asset) => (
                        <Space key={asset.id} wrap>
                          <Button size="small" onClick={() => onCase(asset)}>
                            {asset.title} · r{asset.revisionNo}
                          </Button>
                          <ReviewStateTag state={asset.reviewState} />
                        </Space>
                      ))
                    ) : (
                      <p className="caption">暂无关联用例</p>
                    )}
                    {tester && (
                      <footer>
                        <Button size="small" onClick={() => showEditor(item)}>
                          维护关联
                        </Button>
                        {!linked.length && (
                          <Button
                            size="small"
                            onClick={() => onSupplement(item)}
                          >
                            补充用例
                          </Button>
                        )}
                      </footer>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
