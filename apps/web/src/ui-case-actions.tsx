import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space } from 'antd';
import { z } from 'zod';
import {
  assetOperationStatusSchema,
  assetReceiptSchema,
  createScopedCaseInputSchema,
  type Asset,
  type CreateScopedCaseInput,
} from '../../../packages/contracts/src/assets';
import { uiCaseContentSchema } from '../../../packages/contracts/src/domain';
import type { CoverageCheckpoint } from '../../../packages/contracts/src/coverage-checkpoints';
import { api, describeError, isUncertainMutationError } from './api';
import { currentIdentityOwner } from './identity-context';
import { workspaceDrafts } from './workspace-drafts';
import type { CaseScope } from './requirements';

export type UiSupplementSource = {
  caseId: string;
  revisionId: string;
  title: string;
  scenarioId: string | null;
  origin?: { meetingId: string; opinionId: string; round: number };
};

const newScenarioId = 'new';
const operation = 'assets.create-scoped-case';
const contentSchema = uiCaseContentSchema.omit({ scenarioId: true }).extend({
  steps: uiCaseContentSchema.shape.steps.unwrap(),
});
const importSchema = z.array(contentSchema).min(1).max(100);
type Content = z.infer<typeof contentSchema>;
type Scenario = CreateScopedCaseInput['scenario'];
type Fields = {
  scene: string;
  sceneTitle?: string;
  objective?: string;
  setId?: string;
  title?: string;
  testPoint?: string;
  preconditions?: string;
  steps?: { action?: string; expected?: string }[];
  expected?: string;
  basis?: string;
  goal?: string;
  imported?: string;
};

function lines(input?: string) {
  return (
    input
      ?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  );
}

export function UiCaseActionDialog({
  scope,
  userId,
  action,
  assets,
  scenarioId,
  source,
  checkpoint,
  onClose,
  onChanged,
}: {
  scope: CaseScope;
  userId: string;
  action: 'new' | 'import' | 'generate' | 'supplement';
  assets: Asset[];
  scenarioId: string | undefined;
  source: UiSupplementSource | undefined;
  checkpoint: CoverageCheckpoint | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [form] = Form.useForm<Fields>();
  const [assistant, setAssistant] = useState(
    action === 'generate' || action === 'supplement',
  );
  const [preview, setPreview] = useState<{
    scenario: Scenario;
    goal: string;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [written, setWritten] = useState<Asset[]>([]);
  const [pending, setPending] = useState<{
    scenario: Scenario;
    remaining: Content[];
  }>();
  const path = `/projects/${scope.projectId}/assets`;
  const storageKey =
    'aitesthub:scoped-ui-case:' +
    userId +
    ':' +
    scope.projectId +
    ':' +
    scope.requirementVersionId;
  const [uncertain, setUncertain] = useState<string | undefined>(() => {
    try {
      const parsed = z.uuid().safeParse(localStorage.getItem(storageKey));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  });
  const selected = Form.useWatch('scene', form);
  const scopeAssets = assets.filter(
    (asset) =>
      !asset.removedAt &&
      asset.kind === 'UI' &&
      asset.requirementVersionId === scope.requirementVersionId,
  );
  const scenarios = scopeAssets.filter(
    (asset) => asset.targetType === 'scenario',
  );
  const sets = scopeAssets.filter((asset) => asset.targetType === 'set');
  const target =
    source?.scenarioId ??
    checkpoint?.scenarioId ??
    scenarioId ??
    scenarios[0]?.id ??
    newScenarioId;
  const fixedScenario = Boolean(checkpoint?.scenarioId);
  const imported = action === 'import';
  const locked = submitting || Boolean(uncertain);
  const labels = {
    new: '新增用例',
    import: '导入用例',
    generate: '生成用例',
    supplement: '请 AI 补充用例',
  };
  const defaultGoal = checkpoint?.title ?? '';
  const initial: Fields = {
    scene: target,
    title: checkpoint?.title ?? '',
    testPoint: checkpoint?.title ?? '',
    basis: checkpoint?.source ?? '',
    expected: checkpoint?.title ?? '',
    goal: defaultGoal,
    steps: [{ action: '' }],
  };

  function resolveScenario(values: Fields): Scenario {
    if (values.scene !== newScenarioId) {
      if (
        !scenarios.some((asset) => asset.id === values.scene) ||
        (fixedScenario && values.scene !== target)
      )
        throw new Error('请选择当前需求版本的有效场景。');
      return { scenarioId: values.scene };
    }
    const title = values.sceneTitle?.trim();
    const objective = values.objective?.trim();
    if (!title || !objective)
      throw new Error('请填写新场景名称和独立覆盖理由。');
    if (scenarios.some((asset) => asset.title === title))
      throw new Error('该场景已存在，请复用现有场景。');
    if (sets.length > 1 && !sets.some((asset) => asset.id === values.setId))
      throw new Error('此版本有多个历史归属，请选择新场景的历史来源。');
    return {
      title,
      objective,
      sharedPreconditions: [],
      basisRefs: [],
      ...(values.setId ? { setId: values.setId } : {}),
    };
  }

  function authored(values: Fields): Content[] {
    if (imported) {
      let json: unknown;
      try {
        json = JSON.parse(values.imported ?? '');
      } catch {
        throw new Error('请输入有效的 UI 用例 JSON 数组。');
      }
      return importSchema.parse(json);
    }
    return [
      contentSchema.parse({
        kind: 'UI',
        title: values.title,
        testPoint: values.testPoint,
        preconditions: lines(values.preconditions),
        steps: values.steps?.map((step) => ({
          action: step.action,
          ...(step.expected?.trim() ? { expected: step.expected.trim() } : {}),
        })),
        expected: values.expected,
        basisRefs: values.basis?.trim()
          ? [
              {
                kind: 'explicitStatement',
                description: values.basis.trim(),
                readability: 'readable',
              },
            ]
          : [],
      }),
    ];
  }

  function remember(commandId: string) {
    if (currentIdentityOwner() !== userId)
      throw new Error('请先核对当前账号。');
    localStorage.setItem(storageKey, commandId);
    if (localStorage.getItem(storageKey) !== commandId)
      throw new Error('操作标识无法保存，本次未发送。');
  }

  function clearReceipt() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // A retained identifier can only be used to read the original receipt.
    }
  }

  async function saveBatch(batch: {
    scenario: Scenario;
    remaining: Content[];
  }) {
    let scenario = batch.scenario;
    const remaining = [...batch.remaining];
    setSubmitting(true);
    setError(undefined);
    try {
      while (remaining.length) {
        const content = remaining[0];
        if (!content) break;
        const commandId = crypto.randomUUID();
        const body = createScopedCaseInputSchema.parse({
          commandId,
          kind: 'UI',
          requirementVersionId: scope.requirementVersionId,
          scenario,
          content,
          ...(checkpoint
            ? {
                checkpoint: {
                  id: checkpoint.id,
                  rowVersion: checkpoint.rowVersion,
                },
              }
            : {}),
          ...(source
            ? {
                supplementOrigin: {
                  caseId: source.caseId,
                  revisionId: source.revisionId,
                  ...(source.origin ?? {}),
                  note: preview?.goal ?? source.title,
                },
              }
            : {}),
        });
        remember(commandId);
        let created: Asset;
        try {
          ({ asset: created } = await api(
            path + '/scoped-cases',
            { method: 'POST', body },
            assetReceiptSchema,
          ));
        } catch (failure) {
          if (isUncertainMutationError(failure)) setUncertain(commandId);
          else clearReceipt();
          throw failure;
        }
        if (
          created.projectId !== scope.projectId ||
          created.requirementVersionId !== scope.requirementVersionId ||
          created.kind !== 'UI' ||
          created.targetType !== 'case' ||
          !created.parentId ||
          ('scenarioId' in scenario && created.parentId !== scenario.scenarioId)
        ) {
          setUncertain(commandId);
          throw new Error('保存回执和目标范围不一致，请核对原操作。');
        }
        clearReceipt();
        if (!('scenarioId' in scenario))
          scenario = { scenarioId: created.parentId };
        remaining.shift();
        setWritten((items) => [...items, created]);
      }
      setPending(undefined);
      if (!imported) await onChanged();
    } catch (failure) {
      setPending({ scenario, remaining });
      setError(describeError(failure));
    } finally {
      setSubmitting(false);
    }
  }

  async function recover() {
    if (!uncertain) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ operation });
      const receipt = await api(
        path + '/receipts/' + uncertain + '?' + query,
        {},
        assetOperationStatusSchema,
      );
      if (receipt.status === 'completed' && receipt.response) {
        const { asset } = receipt.response;
        if (
          asset.kind !== 'UI' ||
          asset.projectId !== scope.projectId ||
          asset.requirementVersionId !== scope.requirementVersionId ||
          !asset.parentId
        )
          throw new Error('原回执不属于当前新建用例范围。');
        const recoveredScenario = asset.parentId;
        setWritten((items) => [...items, asset]);
        setPending(
          (prior) =>
            prior && {
              scenario: { scenarioId: recoveredScenario },
              remaining: prior.remaining.slice(1),
            },
        );
        setUncertain(undefined);
        clearReceipt();
        if (!imported) await onChanged();
      } else if (receipt.status === 'failed') {
        clearReceipt();
        setUncertain(undefined);
        setError('已核对原操作失败，可再确认输入后提交。');
      } else setError('原操作仍未确认，请核对原回执。');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSubmitting(false);
    }
  }

  async function prepare() {
    const values = await form.validateFields().catch(() => undefined);
    if (!values) return;
    setError(undefined);
    try {
      const scenario = resolveScenario(values);
      if (assistant) {
        const goal = values.goal?.trim();
        if (!goal) throw new Error('请填写生成范围或本次补充目标。');
        setPreview({ scenario, goal });
      } else {
        await saveBatch({ scenario, remaining: authored(values) });
      }
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  function openAssistant() {
    if (!preview || currentIdentityOwner() !== userId) return;
    const draft = 'new:detached:' + crypto.randomUUID();
    const details = {
      projectId: scope.projectId,
      requirementId: scope.requirementId,
      requirementVersionId: scope.requirementVersionId,
      scenario: preview.scenario,
      ...(checkpoint
        ? {
            checkpoint: {
              id: checkpoint.id,
              rowVersion: checkpoint.rowVersion,
            },
            acceptance: checkpoint.title,
            source: checkpoint.source,
          }
        : {}),
      ...(source
        ? {
            supplementOrigin: {
              caseId: source.caseId,
              revisionId: source.revisionId,
              ...(source.origin ?? {}),
              note: preview.goal,
            },
          }
        : {}),
    };
    workspaceDrafts(userId).set(draft, {
      content: [
        '请依据当前需求版本及我许可的资料，设计本范围的 UI 用例候选。',
        '先列出完整用例候选、依据与缺口，等待我确认后才保存。保存时，使用 create-scoped-case，并核对下列稳定范围。新增用例保持待评审。',
        '测试目标',
        preview.goal,
        '目标对象',
        JSON.stringify(details, null, 2),
      ].join('\n\n'),
      references: [
        {
          id: crypto.randomUUID(),
          label: scope.title + ' · v' + scope.versionNo,
          note: '固定本次需求版本。实际资料许可和使用范围在发送时按平台规则核对。',
          reference: {
            kind: 'requirementVersion',
            requirementVersionId: scope.requirementVersionId,
            dataScope: 'authorizedRelevantTestData',
          },
        },
      ],
      operationTarget: {
        projectId: scope.projectId,
        requirementId: scope.requirementId,
        objectIds: [
          ...('scenarioId' in preview.scenario
            ? [preview.scenario.scenarioId]
            : []),
          ...(source ? [source.caseId] : []),
        ],
      },
      skillIds: ['ath-case-design'],
    });
    onClose();
    window.location.hash =
      'workspace?' +
      new URLSearchParams({ projectId: scope.projectId, draft }).toString();
  }

  const importDone =
    imported && written.length > 0 && !pending && !uncertain && !submitting;
  return (
    <Modal
      title={preview ? '预览生成范围' : labels[action]}
      open
      width={720}
      closable={!locked}
      maskClosable={!locked}
      keyboard={!locked}
      onCancel={() => {
        if (locked) return;
        if (written.length) void onChanged();
        else onClose();
      }}
      okText={
        preview
          ? '打开 AI 工作台草稿'
          : importDone
            ? '完成'
            : assistant
              ? '预览生成范围'
              : imported
                ? '确认导入'
                : '保存待评审用例'
      }
      okButtonProps={{ disabled: Boolean(uncertain) }}
      confirmLoading={submitting}
      onOk={() => {
        if (preview) openAssistant();
        else if (importDone) void onChanged();
        else if (pending) void saveBatch(pending);
        else void prepare();
      }}
    >
      <p className="caption">
        {scope.title} · 需求版本 v{scope.versionNo}
      </p>
      {checkpoint && (
        <p className="preserve-lines">
          <strong>需求验收点</strong> {checkpoint.title} · {checkpoint.source}
        </p>
      )}
      {source && (
        <p className="caption">
          补充来源 · {source.title} · {source.caseId} · 修订 {source.revisionId}
        </p>
      )}
      {(error || uncertain) && (
        <Alert
          type="error"
          showIcon
          title={error ?? '有原用例写入待核对。'}
          action={
            uncertain && (
              <Button loading={submitting} onClick={() => void recover()}>
                查询原回执
              </Button>
            )
          }
        />
      )}
      {written.length > 0 && (
        <ul>
          {written.map((asset) => (
            <li key={asset.id}>
              已提交 {asset.title} · r{asset.revisionNo} · {asset.id}
            </li>
          ))}
        </ul>
      )}
      {preview ? (
        <>
          <p>
            目标场景{' '}
            {'scenarioId' in preview.scenario
              ? scenarios.find(
                  (asset) =>
                    'scenarioId' in preview.scenario &&
                    asset.id === preview.scenario.scenarioId,
                )?.title
              : preview.scenario.title}
          </p>
          <p className="preserve-lines">{preview.goal}</p>
          <p className="caption">
            草稿将送到 AI 工作台供确认，保留原需求版本与目标场景。
          </p>
          <Button onClick={() => setPreview(undefined)}>返回填写</Button>
        </>
      ) : (
        !importDone && (
          <Form
            form={form}
            layout="vertical"
            initialValues={initial}
            disabled={locked || Boolean(pending)}
          >
            <Form.Item
              name="scene"
              label="目标场景"
              rules={[{ required: true }]}
            >
              <Select
                disabled={fixedScenario}
                options={[
                  ...scenarios.map((asset) => ({
                    value: asset.id,
                    label: asset.title,
                  })),
                  { value: newScenarioId, label: '新增场景（独立覆盖）' },
                ]}
              />
            </Form.Item>
            {(selected ?? target) === newScenarioId && (
              <>
                <Form.Item
                  name="sceneTitle"
                  label="新场景名称"
                  rules={[{ required: true, whitespace: true, max: 200 }]}
                >
                  <Input maxLength={200} />
                </Form.Item>
                <Form.Item
                  name="objective"
                  label="独立覆盖理由"
                  rules={[{ required: true, whitespace: true }]}
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
                {sets.length > 1 && (
                  <Form.Item
                    name="setId"
                    label="历史来源"
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={sets.map((asset) => ({
                        value: asset.id,
                        label: asset.title + ' · ' + asset.id.slice(0, 8),
                      }))}
                    />
                  </Form.Item>
                )}
              </>
            )}
            {assistant ? (
              <Form.Item
                name="goal"
                label="生成范围或测试目标"
                rules={[{ required: true, whitespace: true }]}
              >
                <Input.TextArea rows={4} maxLength={5000} />
              </Form.Item>
            ) : imported ? (
              <Form.Item
                name="imported"
                label="UI 用例 JSON"
                rules={[{ required: true }]}
              >
                <Input.TextArea
                  rows={8}
                  placeholder="粘贴用例数组。每条包含 kind、title、testPoint、preconditions、steps、expected 和 basisRefs。"
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="title"
                  label="用例标题"
                  rules={[{ required: true, whitespace: true, max: 200 }]}
                >
                  <Input maxLength={200} />
                </Form.Item>
                <Form.Item
                  name="testPoint"
                  label="测试点"
                  rules={[{ required: true, whitespace: true }]}
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.Item name="preconditions" label="前置条件（每行一项）">
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.List name="steps">
                  {(fields, list) => (
                    <div>
                      {fields.map((field, index) => (
                        <Space.Compact key={field.key} block>
                          <Form.Item
                            name={[field.name, 'action']}
                            label={'业务步骤 ' + (index + 1)}
                            rules={[{ required: true, whitespace: true }]}
                          >
                            <Input />
                          </Form.Item>
                          <Form.Item
                            name={[field.name, 'expected']}
                            label="逐步预期"
                          >
                            <Input />
                          </Form.Item>
                          <Button
                            disabled={fields.length === 1}
                            onClick={() => list.remove(field.name)}
                          >
                            移除
                          </Button>
                        </Space.Compact>
                      ))}
                      <Button
                        size="small"
                        onClick={() => list.add({ action: '' })}
                      >
                        添加业务步骤
                      </Button>
                    </div>
                  )}
                </Form.List>
                <Form.Item
                  name="expected"
                  label="整体预期"
                  rules={[{ required: true, whitespace: true }]}
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.Item name="basis" label="需求来源">
                  <Input.TextArea rows={2} maxLength={4000} />
                </Form.Item>
                <Button
                  disabled={Boolean(pending)}
                  onClick={() => {
                    form.setFieldValue(
                      'goal',
                      form.getFieldValue('testPoint') || defaultGoal,
                    );
                    setAssistant(true);
                  }}
                >
                  交给 AI 起草
                </Button>
              </>
            )}
          </Form>
        )
      )}
    </Modal>
  );
}
