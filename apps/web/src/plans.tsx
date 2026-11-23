import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { Key } from 'react';
import { EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import { apiRegressionQualificationListSchema } from '../../../packages/contracts/src/api-execution';
import { requirementEligibleParticipantsSchema } from '../../../packages/contracts/src/requirements';
import {
  apiQueueReceiptSchema,
  apiStartPreviewSchema,
  createPlanInputSchema,
  planDetailSchema,
  planListSchema,
  planReceiptSchema,
  revisePlanInputSchema,
  renamePlanInputSchema,
  uiPlanApprovalBasisSchema,
  uiPlanEligibilitySchema,
  uiPlanScopeSchema,
} from '../../../packages/contracts/src/plans';
import {
  assetListSchema,
  assetNavigationSchema,
} from '../../../packages/contracts/src/assets';
import type { Asset } from '../../../packages/contracts/src/assets';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import { api, describeError } from './api';
import { uiLayers } from './ui-layers';
import type { Project } from './types';
import { reviewLabels, StatusTag } from './semantic-status';
import { BeijingTime } from './beijing-time';
import { DetailDrawer } from './detail-drawer';
import { ResultListState, ResultPagination } from './result-list';
import { PageHeading } from './page-heading';
import { PlanScheduleSection, type Schedule } from './plan-schedules';
import { scheduleListSchema } from '../../../packages/contracts/src/schedules';
import {
  PlanningPendingBanner,
  PlanningRecovery,
  usePlanningCommand,
  usePlanningPending,
  PlanningActorContext,
} from './planning-command';

type Plan = z.infer<typeof planReceiptSchema>['plan'];
type PlanDetail = z.infer<typeof planDetailSchema>;
type UiScope = z.infer<typeof uiPlanScopeSchema>;
type StartPreview = z.infer<typeof apiStartPreviewSchema>;
type QueueReceipt = z.infer<typeof apiQueueReceiptSchema>;
type Navigation = z.infer<typeof assetNavigationSchema>;
type PlanHandoff = {
  kind: 'UI' | 'API';
  caseIds: string[];
  versionId: string | undefined;
  approvalBasis: z.infer<typeof uiPlanApprovalBasisSchema>[];
};

function readPlanHandoff(projectId?: string): PlanHandoff | null {
  if (!projectId) return null;
  const [path, search] = window.location.hash.replace(/^#\/?/, '').split('?');
  if (path !== 'plans') return null;
  const query = new URLSearchParams(search);
  const linkedProject = query.get('projectId');
  const kind = query.get('kind');
  if (
    (linkedProject && linkedProject !== projectId) ||
    (kind !== 'UI' && kind !== 'API')
  )
    return null;
  const caseIds = query.getAll('caseId');
  if (
    !caseIds.length ||
    caseIds.length > 10000 ||
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id) => !idSchema.safeParse(id).success)
  )
    return null;
  const version = idSchema.safeParse(query.get('versionId'));
  const approvalIds = query.getAll('approvalSnapshotId');
  if (
    kind === 'UI' &&
    (!version.success || approvalIds.length !== caseIds.length)
  )
    return null;
  if (kind === 'API' && approvalIds.length) return null;
  const basis = z.array(uiPlanApprovalBasisSchema).safeParse(
    approvalIds.map((approvalSnapshotId, index) => ({
      caseId: caseIds[index],
      approvalSnapshotId,
    })),
  );
  if (!basis.success) return null;
  return {
    kind,
    caseIds,
    versionId: version.success ? version.data : undefined,
    approvalBasis: basis.data,
  };
}
interface PlanFields {
  name: string;
  environmentId: string;
  productBuild: string;
  requirementVersionId: string;
}

function PlanNameEditor({
  projectId,
  plan,
  onClose,
  onSaved,
}: {
  projectId: string;
  plan: Plan | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [form] = Form.useForm<{ name: string }>();
  const { modal } = App.useApp();
  const command = usePlanningCommand(
    projectId,
    plan ? `${projectId}:${plan.id}:name` : null,
  );
  useEffect(() => {
    setName(plan?.name ?? '');
    form.setFieldsValue({ name: plan?.name ?? '' });
  }, [plan, form]);
  const close = () => {
    if (command.pending) return;
    if (plan && name !== plan.name && !command.uncertain)
      modal.confirm({
        title: '放弃尚未保存的名称修改？',
        okText: '放弃修改',
        cancelText: '继续编辑',
        onOk: onClose,
      });
    else onClose();
  };
  return (
    <Modal
      title="修改计划名称"
      open={plan !== null}
      onCancel={close}
      okText="保存名称"
      confirmLoading={command.pending}
      okButtonProps={{ disabled: command.uncertain }}
      cancelButtonProps={{ disabled: command.pending }}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        className="mb"
        title="只新增名称修订，原固定范围、环境和批准快照保持原样，历史不变。"
      />
      {command.error && <Alert type="error" showIcon title={command.error} />}
      <PlanningRecovery
        projectId={projectId}
        operation="plans.rename"
        command={command}
        schema={planReceiptSchema}
        onRecovered={() => {
          void onSaved().then(onClose);
        }}
      />
      <Form
        form={form}
        layout="vertical"
        onValuesChange={(values: { name?: string }) =>
          setName(values.name ?? '')
        }
        onFinish={async (values: { name: string }) => {
          if (!plan) return;
          const receipt = await command.run(
            'plans.rename',
            plan.id,
            '修改计划名称',
            (commandId) =>
              api(
                `/projects/${projectId}/plans/${plan.id}/name`,
                {
                  method: 'PUT',
                  body: renamePlanInputSchema.parse({
                    commandId,
                    rowVersion: plan.rowVersion,
                    basePlanRevisionId: plan.planRevisionId,
                    name: values.name,
                  }),
                },
                planReceiptSchema,
              ),
          );
          if (receipt) {
            await onSaved();
            onClose();
          }
        }}
      >
        <Form.Item
          name="name"
          label="计划名称"
          rules={[
            {
              required: true,
              whitespace: true,
              max: 200,
              message: '请输入不超过200字的计划名称。',
            },
          ]}
        >
          <Input
            maxLength={200}
            disabled={command.pending || command.uncertain}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PlanEditor({
  projectId,
  kind,
  plan,
  handoff,
  open,
  onClose,
  onSaved,
}: {
  projectId: string;
  kind: 'UI' | 'API';
  plan: Plan | null;
  handoff: PlanHandoff | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<{
    name: string;
    environmentId: string;
    productBuild: string;
    requirementVersionId: string;
  }>();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [eligibility, setEligibility] = useState<
    z.infer<typeof uiPlanEligibilitySchema>['items']
  >([]);
  const [apiQualifications, setApiQualifications] = useState<
    z.infer<typeof apiRegressionQualificationListSchema>['qualifications']
  >([]);
  const [navigation, setNavigation] = useState<Navigation>({
    requirements: [],
  });
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [refreshCaseIds, setRefreshCaseIds] = useState<string[]>([]);
  const [excludedHandoffCount, setExcludedHandoffCount] = useState(0);
  const [caseVisible, setCaseVisible] = useState(50);
  const [loading, setLoading] = useState(false);
  const command = usePlanningCommand(
    projectId,
    open ? `${projectId}:${kind}:${plan?.id ?? 'new'}` : null,
  );
  const pending = command.pending,
    locked = pending || command.uncertain;
  const [error, setError] = useState<string>();
  const [discard, setDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const selectedVersion: string | undefined = Form.useWatch(
    'requirementVersionId',
    form,
  );
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    form.resetFields();
    setError(undefined);
    setDirty(false);
    setDiscard(false);
    setLoading(true);
    setExcludedHandoffCount(0);
    setRefreshCaseIds([]);
    setCaseVisible(50);
    form.setFieldsValue({
      name: plan?.name ?? '',
      productBuild: plan?.productBuild ?? '',
      ...(plan ? { environmentId: plan.environmentId } : {}),
      ...(plan?.kind === 'UI'
        ? { requirementVersionId: plan.requirementVersionId }
        : {}),
    });
    setCaseIds(plan?.items.map((item) => item.caseId) ?? []);
    void Promise.all([
      api(
        `/projects/${projectId}/assets?kind=${kind}`,
        { signal: controller.signal },
        assetListSchema,
      ),
      api(
        `/projects/${projectId}/assets/navigation?kind=${kind}`,
        { signal: controller.signal },
        assetNavigationSchema,
      ),
      api(
        `/projects/${projectId}/test-configuration?kind=environment`,
        { signal: controller.signal },
        testConfigurationListSchema,
      ),
      kind === 'UI'
        ? api(
            `/projects/${projectId}/plans/ui-eligibility`,
            { signal: controller.signal },
            uiPlanEligibilitySchema,
          )
        : Promise.resolve({ items: [] }),
      kind === 'API'
        ? api(
            `/projects/${projectId}/api-executions/regression-qualifications`,
            { signal: controller.signal },
            apiRegressionQualificationListSchema,
          )
        : Promise.resolve({ qualifications: [] }),
    ])
      .then(([data, map, configs, qualified, apiQualified]) => {
        if (!controller.signal.aborted) {
          setAssets(data.assets);
          setNavigation(map);
          setEnvironments(configs.configurations);
          setEligibility(qualified.items);
          setApiQualifications(apiQualified.qualifications);
          if (!plan && handoff?.kind === kind) {
            const candidates = handoff.caseIds.flatMap((id) => {
              const item = data.assets.find((asset) => asset.id === id);
              return item?.targetType === 'case' && !item.removedAt
                ? [item]
                : [];
            });
            const versionId =
              handoff.versionId ?? candidates[0]?.requirementVersionId;
            if (kind === 'UI' && versionId)
              form.setFieldValue('requirementVersionId', versionId);
            const expected = new Map(
              handoff.approvalBasis.map(({ caseId, approvalSnapshotId }) => [
                caseId,
                approvalSnapshotId,
              ]),
            );
            const current = new Map(
              qualified.items.map((entry) => [entry.caseId, entry]),
            );
            const selected = candidates.filter((item) =>
              kind === 'UI'
                ? item.requirementVersionId === versionId &&
                  current.get(item.id)?.eligible === true &&
                  current.get(item.id)?.approvedRevisionId ===
                    item.revisionId &&
                  current.get(item.id)?.approvalSnapshotId ===
                    expected.get(item.id)
                : apiQualified.qualifications.some(
                    (entry) => entry.caseId === item.id,
                  ),
            );
            setCaseIds(selected.map((item) => item.id));
            setExcludedHandoffCount(handoff.caseIds.length - selected.length);
          }
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, plan, handoff, projectId, kind, form]);
  function requestClose() {
    if (pending) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function save(values: {
    name: string;
    environmentId: string;
    productBuild: string;
    requirementVersionId: string;
  }) {
    setError(undefined);
    const receipt = await command.run(
      plan ? 'plans.revise' : 'plans.create',
      plan?.id ?? null,
      plan ? '修改计划范围' : '新建计划',
      async (key) => {
        const approvalBasis =
          !plan && kind === 'UI' && handoff?.kind === 'UI'
            ? handoff.approvalBasis.filter(({ caseId }) =>
                caseIds.includes(caseId),
              )
            : [];
        const input = {
          commandId: key,
          kind,
          name: values.name,
          environmentId: values.environmentId,
          productBuild: values.productBuild?.trim() || null,
          caseIds,
          ...(approvalBasis.length ? { approvalBasis } : {}),
          ...(kind === 'UI'
            ? { requirementVersionId: values.requirementVersionId }
            : {}),
        };
        const body = plan
          ? revisePlanInputSchema.parse({
              ...input,
              rowVersion: plan.rowVersion,
              basePlanRevisionId: plan.planRevisionId,
              ...(refreshCaseIds.length ? { refreshCaseIds } : {}),
            })
          : createPlanInputSchema.parse(input);
        return api(
          `/projects/${projectId}/plans${plan ? `/${plan.id}` : ''}`,
          { method: plan ? 'PUT' : 'POST', body },
          planReceiptSchema,
        );
      },
    );
    if (receipt) {
      setDirty(false);
      await onSaved();
      onClose();
    }
  }
  const cases = assets.filter(
    (asset) =>
      asset.targetType === 'case' &&
      !asset.removedAt &&
      (kind === 'API' || asset.requirementVersionId === selectedVersion),
  );
  const originalIds = new Set(plan?.items.map((item) => item.caseId));
  const eligibleUi = new Map(eligibility.map((item) => [item.caseId, item]));
  const handedOffApprovals = new Map(
    handoff?.approvalBasis.map(({ caseId, approvalSnapshotId }) => [
      caseId,
      approvalSnapshotId,
    ]),
  );
  const apiReady = new Map(
    apiQualifications.map((item) => [item.caseId, item]),
  );
  const requirementNames = new Map(
    navigation.requirements.flatMap((requirement) =>
      requirement.versions.map((version) => [
        version.id,
        `${requirement.title} · v${version.versionNo}`,
      ]),
    ),
  );
  const invalidSelection = caseIds.some(
    (id) =>
      (!originalIds.has(id) || refreshCaseIds.includes(id)) &&
      (kind === 'UI' ? !eligibleUi.get(id)?.eligible : !apiReady.has(id)),
  );
  return (
    <>
      <Modal
        title={`${plan ? '主动更新' : '新建'} ${kind === 'UI' ? 'UI 固定' : '接口逻辑用例'}计划`}
        open={open}
        zIndex={uiLayers.dialog}
        width={1030}
        rootClassName="plans-page planning-modal"
        classNames={{
          container: 'dialog wide',
          header: 'dialog-head',
          body: 'dialog-body',
          footer: 'dialog-foot',
        }}
        styles={{
          container: { padding: 0, maxHeight: '90vh' },
          body: { overflow: 'auto' },
          footer: { margin: 0 },
        }}
        onCancel={requestClose}
        closable={!pending}
        maskClosable={!pending}
        footer={
          <Space>
            <Button disabled={pending} onClick={requestClose}>
              取消
            </Button>
            <Button
              type="primary"
              disabled={
                loading ||
                !caseIds.length ||
                command.uncertain ||
                invalidSelection
              }
              loading={pending}
              onClick={() => form.submit()}
            >
              保存计划修订
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title={
            kind === 'UI'
              ? 'UI 计划保存时固定已审快照，不会随草稿或新需求版本漂移。'
              : '接口计划关联用例，真正开始时锁定最新有效的可回归修订。'
          }
          description={
            kind === 'UI'
              ? '同一需求版本下可逐条选入。修改计划时，原固定项只有勾选更新才会换修订。'
              : '可选择本项目各需求的接口用例。开始预览显示试跑资格和目标环境缺口。'
          }
          className="section-alert"
        />
        {invalidSelection && !loading && (
          <Alert
            type="warning"
            showIcon
            className="section-alert"
            title="新增或待换版的用例缺少当前执行资格。"
          />
        )}
        {excludedHandoffCount > 0 && !loading && (
          <Alert
            type="warning"
            className="section-alert"
            title={`带入的 ${excludedHandoffCount} 条用例的批准修订已变化、缺少资格或不在当前需求版本。`}
          />
        )}
        {(error || command.error) && (
          <Alert
            type="error"
            title={error || command.error}
            showIcon
            className="section-alert"
          />
        )}
        <PlanningRecovery
          projectId={projectId}
          operation={plan ? 'plans.revise' : 'plans.create'}
          command={command}
          schema={planReceiptSchema}
          onRecovered={() => {
            setDirty(false);
            void onSaved().then(onClose);
          }}
        />
        <Form<PlanFields>
          form={form}
          layout="vertical"
          onValuesChange={(changed: Partial<PlanFields>) => {
            setDirty(true);
            if ('requirementVersionId' in changed) setCaseIds([]);
          }}
          onFinish={(values: {
            name: string;
            environmentId: string;
            productBuild: string;
            requirementVersionId: string;
          }) => void save(values)}
        >
          <div className="formgrid mt">
            <Form.Item
              name="name"
              label="计划名称"
              rules={[{ required: true, whitespace: true, max: 200 }]}
            >
              <Input maxLength={200} disabled={locked} />
            </Form.Item>
            <Form.Item
              name="environmentId"
              label="目标环境"
              rules={[{ required: true, message: '请选择目标环境' }]}
            >
              <Select
                disabled={locked}
                options={environments
                  .filter(
                    (configuration) =>
                      configuration.content.kind === 'environment',
                  )
                  .map((configuration) => ({
                    value: configuration.id,
                    label: `${configuration.content.name}${'active' in configuration.content && !configuration.content.active ? '（已停用）' : ''}`,
                    disabled:
                      'active' in configuration.content &&
                      !configuration.content.active,
                  }))}
              />
            </Form.Item>
            {kind === 'UI' && (
              <Form.Item
                name="requirementVersionId"
                label="固定需求版本"
                rules={[{ required: true, message: '选择明确需求版本' }]}
              >
                <Select
                  disabled={locked || Boolean(plan)}
                  options={navigation.requirements.flatMap((requirement) =>
                    requirement.versions.map((version) => ({
                      value: version.id,
                      label: `${requirement.title} · v${version.versionNo}`,
                    })),
                  )}
                />
              </Form.Item>
            )}
            <Form.Item name="productBuild" label="被测版本/构建标识（可留空）">
              <Input maxLength={200} disabled={locked} />
            </Form.Item>
          </div>
        </Form>
        <Typography.Paragraph>
          已明确选择 {caseIds.length} 条。
          {kind === 'UI'
            ? '新增或换版时使用当前已批准的用例。'
            : '开始前会展示全部缺口，手动有效子集须再次明确选择。'}
        </Typography.Paragraph>
        <div className="mt" aria-busy={loading}>
          {loading && (
            <p className="caption" role="status">
              读取项目用例…
            </p>
          )}
          {cases.slice(0, caseVisible).map((asset) => {
            const selected = caseIds.includes(asset.id),
              qualification = eligibleUi.get(asset.id),
              ready = apiReady.get(asset.id),
              eligible =
                kind === 'API'
                  ? Boolean(ready)
                  : qualification?.eligible === true &&
                    qualification.approvedRevisionId === asset.revisionId &&
                    (!handedOffApprovals.has(asset.id) ||
                      handedOffApprovals.get(asset.id) ===
                        qualification.approvalSnapshotId),
              unavailable = !eligible && !selected;
            return (
              <div key={asset.id}>
                <label className="checkrow" key={asset.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={locked || unavailable}
                    onChange={(event) => {
                      setCaseIds(
                        event.target.checked
                          ? [...caseIds, asset.id]
                          : caseIds.filter((id) => id !== asset.id),
                      );
                      if (!event.target.checked)
                        setRefreshCaseIds((current) =>
                          current.filter((id) => id !== asset.id),
                        );
                      setDirty(true);
                    }}
                  />
                  <span className="grow">
                    {asset.title}
                    <small>
                      {asset.id} ·{' '}
                      {assets.find((item) => item.id === asset.setId)?.title ??
                        asset.setId}{' '}
                      {kind === 'API' &&
                      requirementNames.has(asset.requirementVersionId)
                        ? `· ${requirementNames.get(asset.requirementVersionId)} `
                        : ''}
                      · 当前编辑 r{asset.revisionNo} ·{' '}
                      {kind === 'UI'
                        ? reviewLabels[asset.reviewState]
                        : ready
                          ? `可回归 r${ready.revisionNo}`
                          : '暂无可回归修订'}
                      {kind === 'UI' && !eligible && (
                        <span role="status">
                          {' '}
                          ·{' '}
                          {qualification?.reasons.join('；') ||
                            '资格尚未核实。'}
                        </span>
                      )}
                    </small>
                  </span>
                  <span className="badge">
                    {kind === 'UI' && selected && originalIds.has(asset.id)
                      ? refreshCaseIds.includes(asset.id)
                        ? '更新修订'
                        : '保留原修订'
                      : eligible
                        ? '可选择'
                        : '暂不可新选'}
                  </span>
                </label>
                {kind === 'UI' &&
                  eligible &&
                  selected &&
                  originalIds.has(asset.id) && (
                    <Checkbox
                      checked={refreshCaseIds.includes(asset.id)}
                      disabled={locked}
                      onChange={(event) => {
                        setRefreshCaseIds((ids) =>
                          event.target.checked
                            ? [...ids, asset.id]
                            : ids.filter((id) => id !== asset.id),
                        );
                        setDirty(true);
                      }}
                    >
                      将 {asset.title} 更新到当前已批准修订
                    </Checkbox>
                  )}
              </div>
            );
          })}
          {!loading && !cases.length && (
            <p className="caption">
              {kind === 'UI' && !selectedVersion
                ? '请选择明确需求版本后查看用例。'
                : '当前条件下没有可选用例。'}
            </p>
          )}
          {cases.length > caseVisible && (
            <button
              className="btn small mt"
              onClick={() => setCaseVisible((count) => count + 50)}
            >
              显示更多用例（{caseVisible} / {cases.length}）
            </button>
          )}
        </div>
        {caseIds
          .filter((id) => !cases.some((item) => item.id === id))
          .map((id) => (
            <label className="checkrow mt" key={id}>
              <input
                type="checkbox"
                checked
                disabled={locked}
                onChange={() => {
                  setCaseIds(caseIds.filter((item) => item !== id));
                  setDirty(true);
                }}
              />
              <span>
                历史或已失效引用：{id}
                <small>
                  保留已有选择；请明确取消或重新选择，不能静默删项。
                </small>
              </span>
            </label>
          ))}
      </Modal>
      <Modal
        title="计划有未保存的选择"
        width={610}
        rootClassName="plans-page planning-modal"
        classNames={{
          container: 'dialog',
          header: 'dialog-head',
          body: 'dialog-body',
          footer: 'dialog-foot',
        }}
        styles={{ container: { padding: 0 }, footer: { margin: 0 } }}
        open={discard}
        zIndex={uiLayers.confirmation}
        onCancel={() => setDiscard(false)}
        footer={
          <Space>
            <Button onClick={() => setDiscard(false)}>继续编辑</Button>
            <Button
              danger
              onClick={() => {
                setDiscard(false);
                onClose();
              }}
            >
              放弃修改
            </Button>
            <Button
              type="primary"
              disabled={command.uncertain}
              onClick={() => {
                setDiscard(false);
                form.submit();
              }}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          只有保存才生成新计划修订；现有固定历史不被本地草稿改变。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}

export function PlansPage({
  project,
  userId,
}: {
  project: Project | null;
  userId: string;
}) {
  const { message } = App.useApp();
  const [handoff, setHandoff] = useState(() => readPlanHandoff(project?.id));
  const [kind, setKind] = useState<'UI' | 'API'>(() => handoff?.kind ?? 'UI');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [creatorNames, setCreatorNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    setCreatorNames({});
    if (project)
      void api(
        `/projects/${project.id}/requirements/eligible-participants`,
        { signal: controller.signal },
        requirementEligibleParticipantsSchema,
      )
        .then((response) => {
          if (!controller.signal.aborted)
            setCreatorNames(
              Object.fromEntries(
                response.users.map((user) => [user.id, user.displayName]),
              ),
            );
        })
        .catch(() => {
          /* Names are optional; the immutable creator ID remains available. */
        });
    return () => controller.abort();
  }, [project?.id, userId]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleError, setScheduleError] = useState('');
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [visibleCount, setVisibleCount] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [renaming, setRenaming] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [uiScope, setUiScope] = useState<UiScope | null>(null);
  const [scopeError, setScopeError] = useState<string>();
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [overlapConfirmed, setOverlapConfirmed] = useState(false);
  const [queue, setQueue] = useState<QueueReceipt | null>(null);
  const [queueError, setQueueError] = useState<string>();
  const [pending, setPending] = useState(false);
  const queueCommand = usePlanningCommand(
    project?.id ?? '',
    preview ? `${project?.id}:queue:${preview.previewId}` : null,
    userId,
  );
  const unresolved = usePlanningPending(project?.id, userId);
  const tester = Boolean(userId && project?.roles.includes('tester'));
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const detailTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onHashChange = () => {
      const linked = readPlanHandoff(project?.id);
      setHandoff(linked);
      if (linked) setKind(linked.kind);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [project?.id]);
  async function load(signal?: AbortSignal) {
    const generation = ++listGeneration.current;
    if (!project) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [result, scheduleResult, configurationResult] =
        await Promise.allSettled([
          api(
            `/projects/${project.id}/plans?kind=${kind}`,
            signal ? { signal } : {},
            planListSchema,
          ),
          kind === 'API'
            ? api(
                `/projects/${project.id}/schedules`,
                signal ? { signal } : {},
                scheduleListSchema,
              )
            : Promise.resolve({ schedules: [] }),
          api(
            `/projects/${project.id}/test-configuration?kind=environment`,
            signal ? { signal } : {},
            testConfigurationListSchema,
          ),
        ]);
      if (!signal?.aborted && generation === listGeneration.current) {
        if (result.status === 'fulfilled') {
          setPlans(result.value.plans);
          setError(undefined);
        } else {
          setPlans([]);
          setError(describeError(result.reason));
        }
        if (scheduleResult.status === 'fulfilled') {
          setSchedules(scheduleResult.value.schedules);
          setScheduleError('');
        } else {
          setSchedules([]);
          setScheduleError(describeError(scheduleResult.reason));
        }
        if (configurationResult.status === 'fulfilled')
          setEnvironments(configurationResult.value.configurations);
        else setEnvironments([]);
      }
    } catch (err) {
      if (!signal?.aborted && generation === listGeneration.current) {
        setPlans([]);
        setError(describeError(err));
      }
    } finally {
      if (!signal?.aborted && generation === listGeneration.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setPlans([]);
    setSchedules([]);
    setScheduleError('');
    setEnvironments([]);
    setVisibleCount(15);
    setDetail(null);
    setPreview(null);
    setUiScope(null);
    setEditorOpen(false);
    detailGeneration.current += 1;
    setDetailLoading(false);
    setPending(false);
    void load(controller.signal);
    return () => {
      controller.abort();
      detailGeneration.current += 1;
    };
  }, [project?.id, kind]);
  useEffect(() => {
    if (!tester || !handoff || handoff.kind !== kind) return;
    setEditing(null);
    setEditorOpen(true);
  }, [tester, handoff, kind]);
  async function inspect(plan: Plan): Promise<boolean> {
    if (!project) return false;
    const generation = ++detailGeneration.current;
    setDetail(null);
    setDetailLoading(true);
    setScopeError(undefined);
    setUiScope(null);
    try {
      const result = await api(
        `/projects/${project.id}/plans/${plan.id}`,
        {},
        planDetailSchema,
      );
      if (generation !== detailGeneration.current) return false;
      setDetail(result);
      return true;
    } catch (err) {
      if (generation === detailGeneration.current) setError(describeError(err));
      return false;
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }
  async function fixedScope(plan: Plan, revisionId = plan.planRevisionId) {
    if (!project || plan.kind !== 'UI') return;
    const generation = detailGeneration.current;
    setPending(true);
    setUiScope(null);
    setScopeError(undefined);
    try {
      const result = await api(
        `/projects/${project.id}/plans/${plan.id}/ui-scope?planRevisionId=${revisionId}`,
        {},
        uiPlanScopeSchema,
      );
      if (generation === detailGeneration.current) setUiScope(result);
    } catch (err) {
      if (generation === detailGeneration.current)
        setScopeError(describeError(err));
    } finally {
      if (generation === detailGeneration.current) setPending(false);
    }
  }
  async function prepare(plan: Plan) {
    if (!project || plan.kind !== 'API') return;
    const generation = ++detailGeneration.current;
    setDetail(null);
    setDetailLoading(false);
    setPending(true);
    setQueueError(undefined);
    setQueue(null);
    try {
      const result = await api(
        `/projects/${project.id}/plans/${plan.id}/api-start-previews`,
        {
          method: 'POST',
          body: {
            commandId: crypto.randomUUID(),
            planRevisionId: plan.planRevisionId,
            source: 'manual',
          },
        },
        apiStartPreviewSchema,
      );
      if (generation !== detailGeneration.current) return;
      setPreview(result);
      setSelectedCaseIds(
        result.items.every((item) => item.eligible)
          ? result.items.map((item) => item.caseId)
          : [],
      );
      setOverlapConfirmed(false);
    } catch (err) {
      if (generation === detailGeneration.current) setError(describeError(err));
    } finally {
      if (generation === detailGeneration.current) setPending(false);
    }
  }
  async function exportFixedScope() {
    if (!project || !uiScope) return;
    const generation = detailGeneration.current;
    setPending(true);
    setScopeError(undefined);
    try {
      const current = await api(
        `/projects/${project.id}/plans/${uiScope.plan.id}/ui-scope?planRevisionId=${uiScope.plan.planRevisionId}`,
        {},
        uiPlanScopeSchema,
      );
      if (generation !== detailGeneration.current) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(current, null, 2)], {
          type: 'application/json;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `AITestHub-UI-plan-${current.plan.planRevisionId}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      void message.info('固定范围文件已生成，已向浏览器发起下载。');
    } catch (error) {
      if (generation === detailGeneration.current)
        setScopeError(describeError(error));
    } finally {
      if (generation === detailGeneration.current) setPending(false);
    }
  }
  async function submit() {
    if (!project || !preview) return;
    setPending(true);
    setQueueError(undefined);
    try {
      const value = await queueCommand.run(
        'api-runs.queue',
        preview.planId,
        '提交接口回归请求',
        (key) =>
          api(
            `/projects/${project.id}/plans/${preview.planId}/api-requests`,
            {
              method: 'POST',
              body: {
                commandId: key,
                previewId: preview.previewId,
                scopeDigest: preview.scopeDigest,
                selectedCaseIds,
                confirmedExistingRunIds: overlapConfirmed
                  ? preview.existingRunIds
                  : [],
                confirmedExistingRequestIds: overlapConfirmed
                  ? preview.existingRequestIds
                  : [],
              },
            },
            apiQueueReceiptSchema,
          ),
      );
      if (value) setQueue(value);
    } catch (err) {
      setQueueError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  async function refreshRequest() {
    if (!project || !queue) return;
    try {
      setQueue(
        await api(
          `/projects/${project.id}/plans/api-requests/${queue.request.id}`,
          {},
          apiQueueReceiptSchema,
        ),
      );
    } catch (err) {
      setQueueError(describeError(err));
    }
  }
  if (!project)
    return (
      <Card>
        <EmptyState />
      </Card>
    );
  const overlap = Boolean(
    preview &&
    (preview.existingRunIds.length || preview.existingRequestIds.length),
  );
  const canCreate =
    tester && !unresolved.some((item) => item.targetId === null);
  function openNewPlan() {
    setEditing(null);
    setEditorOpen(true);
  }
  return (
    <PlanningActorContext.Provider value={userId ?? null}>
      <PageHeading
        eyebrow="TEST PLANS"
        title="测试计划"
        description="UI 固定已审范围；接口每轮开始采用所引用用例的最新已审修订。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!canCreate}
            onClick={openNewPlan}
          >
            新建计划
          </Button>
        }
      />
      <div className="segmented mb" role="tablist" aria-label="计划类型">
        {(['UI', 'API'] as const).map((value) => (
          <button
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={`tab ${kind === value ? 'active' : ''}`}
            key={value}
            onClick={() => {
              setHandoff(null);
              setKind(value);
            }}
          >
            {value === 'UI' ? 'UI 自主测试' : '接口回归'}
          </button>
        ))}
      </div>
      <PlanningPendingBanner
        projectId={project.id}
        onRecovered={() => void load()}
      />
      {scheduleError && (
        <Alert
          className="section-alert"
          type="warning"
          showIcon
          title={`定时状态未能读取：${scheduleError}`}
          action={
            <Button loading={loading} onClick={() => void load()}>
              重新读取
            </Button>
          }
        />
      )}
      {!plans.length && (
        <section className="card mb">
          {loading ? (
            <ResultListState state="loading" title="正在读取测试计划" />
          ) : error ? (
            <ResultListState
              state="error"
              title="测试计划读取失败"
              description={error}
              action={<Button onClick={() => void load()}>重新读取</Button>}
            />
          ) : (
            <ResultListState
              state="empty"
              title={kind === 'UI' ? '还没有 UI 计划' : '还没有接口计划'}
              description="从符合评审条件的资产中选择全部或部分用例。"
              action={
                <Button
                  type="primary"
                  disabled={!canCreate}
                  onClick={openNewPlan}
                >
                  创建计划
                </Button>
              }
            />
          )}
        </section>
      )}
      {plans.slice(0, visibleCount).map((plan) => {
        const locked = unresolved.some((item) => item.targetId === plan.id);
        const environment = environments.find(
          (item) => item.id === plan.environmentId,
        )?.content.name;
        return (
          <section className="card pad mb" key={plan.id}>
            <div className="between">
              <div className="grow">
                <h2>{plan.name}</h2>
                <p className="caption">
                  {plan.id} · 创建人{' '}
                  <span title={`账号ID ${plan.createdBy}`}>
                    {creatorNames[plan.createdBy] ??
                      `账号 ${plan.createdBy.slice(0, 8)}`}
                  </span>{' '}
                  · {plan.items.length} 条用例
                </p>
              </div>
              <div className="row wrap">
                <Button
                  icon={<EyeOutlined />}
                  onClick={(event) => {
                    detailTrigger.current = event.currentTarget;
                    void inspect(plan);
                  }}
                >
                  详情
                </Button>
                <Button
                  icon={<EditOutlined />}
                  disabled={!tester || locked}
                  onClick={() => {
                    setEditing(plan);
                    setEditorOpen(true);
                  }}
                >
                  编辑范围
                </Button>
                <Button
                  disabled={!tester || locked}
                  onClick={() => setRenaming(plan)}
                >
                  改名
                </Button>
                {plan.kind === 'UI' ? (
                  <Button
                    type="primary"
                    disabled={!tester || pending || locked}
                    onClick={(event) => {
                      detailTrigger.current = event.currentTarget;
                      void inspect(plan).then((opened) => {
                        if (opened) void fixedScope(plan);
                      });
                    }}
                  >
                    在本地 AI 发起
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    disabled={!tester || pending || locked}
                    onClick={() => void prepare(plan)}
                  >
                    运行
                  </Button>
                )}
              </div>
            </div>
            <div className="row wrap mt">
              <StatusTag tone="info">
                {plan.kind === 'UI' ? '固定已审版本' : '开始时取最新可回归'}
              </StatusTag>
              <span className="caption">
                {plan.kind === 'UI'
                  ? `固定需求版本 ${plan.requirementVersionId}`
                  : `同项目跨需求 · 引用 ${plan.items.length} 条逻辑用例，运行前核对资格`}
              </span>
              {environment && (
                <span className="caption">环境 {environment}</span>
              )}
              {plan.productBuild && (
                <span className="caption">被测版本 {plan.productBuild}</span>
              )}
            </div>
            {plan.kind === 'API' && !scheduleError && (
              <PlanScheduleSection
                projectId={project.id}
                plan={plan}
                schedule={
                  schedules.find((item) => item.planId === plan.id) ?? null
                }
                tester={tester}
                locked={locked}
                onSaved={() => load()}
              />
            )}
          </section>
        );
      })}
      {plans.length > 0 && (
        <div className="card mb">
          <ResultPagination
            summary={`已展示 ${Math.min(visibleCount, plans.length)} / ${plans.length} 条计划`}
          >
            {plans.length > visibleCount && (
              <Button onClick={() => setVisibleCount((count) => count + 15)}>
                显示更多计划
              </Button>
            )}
          </ResultPagination>
        </div>
      )}
      <PlanEditor
        projectId={project.id}
        kind={kind}
        plan={editing}
        handoff={handoff}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setHandoff(null);
        }}
        onSaved={() => load()}
      />
      <PlanNameEditor
        projectId={project.id}
        plan={renaming}
        onClose={() => setRenaming(null)}
        onSaved={() => load()}
      />
      <DetailDrawer
        title={detail?.plan.name ?? '计划详情'}
        meta={
          detail &&
          `${detail.plan.kind === 'UI' ? 'UI 自主测试' : '接口回归'} · ${detail.plan.items.length} 条用例`
        }
        wide={uiScope !== null}
        open={detail !== null || detailLoading}
        returnFocusRef={detailTrigger}
        onClose={() => {
          detailGeneration.current += 1;
          setDetailLoading(false);
          setPending(false);
          setDetail(null);
          setUiScope(null);
        }}
      >
        {detail && (
          <>
            <Descriptions
              column={1}
              items={[
                {
                  key: 'revision',
                  label: '当前计划修订',
                  children: detail.plan.planRevisionId,
                },
                {
                  key: 'environment',
                  label:
                    detail.plan.kind === 'UI' ? '固定环境' : '逻辑引用环境',
                  children: (
                    <>
                      <b>
                        {detail.display.environmentName ?? '名称当前不可读取'}
                      </b>
                      <div className="caption">{detail.plan.environmentId}</div>
                    </>
                  ),
                },
                {
                  key: 'scope',
                  label: '范围',
                  children: (
                    <Space direction="vertical">
                      <Typography.Text type="secondary">
                        {detail.plan.kind === 'API'
                          ? '按项目保存用例引用，实际开始时锁定最新可回归修订。'
                          : '以下名称来自原固定已审快照。'}
                      </Typography.Text>
                      {detail.display.cases.map((item) => (
                        <div key={item.caseId}>
                          <Button
                            type="link"
                            onClick={() => {
                              const page =
                                detail.plan.kind === 'API'
                                  ? 'api-regression'
                                  : 'cases';
                              window.location.hash = `${page}?${new URLSearchParams({ projectId: project.id, kind: detail.plan.kind, assetId: item.caseId })}`;
                            }}
                          >
                            {item.title ?? '历史用例（名称当前不可读取）'}
                          </Button>
                          <div className="caption">
                            {item.caseId}
                            {item.approvalSnapshotId
                              ? ` · 固定批准 ${item.approvalSnapshotId}`
                              : ''}
                          </div>
                        </div>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
            <Typography.Title level={5}>不可变修订记录</Typography.Title>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.revisions}
              columns={[
                {
                  title: '修订',
                  dataIndex: 'revisionNo',
                  render: (value: number) => `r${value}`,
                },
                { title: '修订 ID', dataIndex: 'id' },
                {
                  title: '保存时间',
                  dataIndex: 'createdAt',
                  render: (value: string) => <BeijingTime value={value} />,
                },
                ...(detail.plan.kind === 'UI' && tester
                  ? [
                      {
                        title: '固定范围',
                        render: (_: unknown, item: { id: string }) => (
                          <Button
                            disabled={pending}
                            onClick={() =>
                              void fixedScope(detail.plan, item.id)
                            }
                          >
                            查看此修订
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            {scopeError && (
              <Alert
                type="error"
                showIcon
                title={scopeError}
                className="section-alert"
              />
            )}
            {uiScope && (
              <>
                <Alert
                  type="info"
                  showIcon
                  title="固定范围已读取"
                  description="由你在本地 AI 中配置官方 MCP、UI 执行 Skill 与 Ego 后发起。此处仅提供范围与指引，不代表浏览器执行已开始。"
                  className="section-alert"
                />
                <Descriptions
                  column={1}
                  items={[
                    {
                      key: 'revision',
                      label: '本次查看的固定计划修订',
                      children: uiScope.plan.planRevisionId,
                    },
                    {
                      key: 'environment',
                      label: '固定环境',
                      children: uiScope.scope.environment.content.name,
                    },
                  ]}
                />
                <Table
                  rowKey="caseId"
                  size="small"
                  dataSource={uiScope.scope.items}
                  pagination={false}
                  columns={[
                    { title: '场景', render: (_, item) => item.scenario.title },
                    { title: '用例', render: (_, item) => item.content.title },
                    { title: '批准快照 ID', dataIndex: 'approvalSnapshotId' },
                  ]}
                />
                <Button
                  className="section-alert"
                  onClick={() => {
                    const current = uiScope;
                    void navigator.clipboard
                      .writeText(
                        `AITestHub 本地 UI 执行范围\n平台：${window.location.origin}\n项目：${project.id}\n计划：${current.plan.id}\n固定计划修订：${current.plan.planRevisionId}\n请通过官方 MCP 当前权限领取此固定范围，核对环境后由本地 UI 执行 Skill 与 Ego 执行并回传。保留真实观察与证据；未知副作用先核实，不重复提交。`,
                      )
                      .then(() => message.success('已复制固定范围指引'))
                      .catch(() =>
                        message.error('剪贴板不可用，请手动复制修订 ID'),
                      );
                  }}
                >
                  复制本地范围指引
                </Button>
                <Button
                  className="section-alert"
                  type="primary"
                  disabled={pending}
                  onClick={() => void exportFixedScope()}
                >
                  导出固定范围
                </Button>
              </>
            )}
          </>
        )}
      </DetailDrawer>
      <Modal
        title="接口开始前预览"
        zIndex={uiLayers.dialog}
        open={preview !== null}
        width={1030}
        rootClassName="plans-page planning-modal"
        classNames={{
          container: 'dialog wide',
          header: 'dialog-head',
          body: 'dialog-body',
          footer: 'dialog-foot',
        }}
        styles={{
          container: { padding: 0, maxHeight: '90vh' },
          body: { overflow: 'auto' },
          footer: { margin: 0 },
        }}
        onCancel={() => {
          if (!pending) setPreview(null);
        }}
        footer={
          <Space>
            <Button disabled={pending} onClick={() => setPreview(null)}>
              关闭
            </Button>
            {!queue && (
              <Button
                type="primary"
                disabled={
                  queueCommand.uncertain ||
                  !selectedCaseIds.length ||
                  (overlap && !overlapConfirmed)
                }
                loading={pending}
                onClick={() => void submit()}
              >
                明确提交所选有效范围
              </Button>
            )}
          </Space>
        }
        destroyOnHidden
      >
        <Typography.Paragraph>
          逐条展示当前资格。手动执行子集时请确认范围。实际开始时锁定最新可回归修订并校验目标环境。
        </Typography.Paragraph>
        {(queueError || queueCommand.error) && (
          <Alert
            type="error"
            title={queueError || queueCommand.error}
            showIcon
          />
        )}
        <PlanningRecovery
          projectId={project.id}
          operation="api-runs.queue"
          command={queueCommand}
          schema={apiQueueReceiptSchema}
          onRecovered={setQueue}
        />
        {preview && (
          <>
            <Typography.Paragraph>
              预览 {preview.items.length} 条；有效{' '}
              {preview.items.filter((item) => item.eligible).length} 条；缺口{' '}
              {preview.items.filter((item) => !item.eligible).length}{' '}
              条；已明确选择 {selectedCaseIds.length} 条。
            </Typography.Paragraph>
            {preview.items.some((item) => !item.eligible) && (
              <Alert
                className="section-alert"
                type="warning"
                showIcon
                title="存在缺口，未自动选择有效子集。请手动选择需要提交的有效用例。"
              />
            )}
            <Table
              rowKey="caseId"
              size="small"
              dataSource={preview.items}
              pagination={{ pageSize: 15 }}
              rowSelection={{
                selectedRowKeys: selectedCaseIds,
                onChange: (keys: Key[]) => setSelectedCaseIds(keys.map(String)),
                getCheckboxProps: (item) => ({
                  disabled:
                    pending ||
                    queueCommand.uncertain ||
                    !item.eligible ||
                    Boolean(queue),
                }),
              }}
              columns={[
                { title: '用例', dataIndex: 'title' },
                {
                  title: '当前资格',
                  render: (_, item) => (
                    <Tag color={item.eligible ? 'green' : 'gold'}>
                      {item.eligible ? '当前有效' : '存在缺口'}
                    </Tag>
                  ),
                },
                {
                  title: '完整缺口',
                  render: (_, item) =>
                    item.reasons.length
                      ? item.reasons.map((reason) => (
                          <Typography.Paragraph
                            key={`${reason.code}:${reason.message}`}
                          >
                            {reason.message}
                          </Typography.Paragraph>
                        ))
                      : '无已知缺口',
                },
              ]}
            />
            {overlap && (
              <Alert
                className="section-alert"
                type="warning"
                showIcon
                title="此计划存在重叠轮次或排队请求"
                description={
                  <>
                    <Typography.Paragraph>
                      现有轮次：{preview.existingRunIds.join('、') || '无'}
                      ；排队请求：
                      {preview.existingRequestIds.join('、') || '无'}
                    </Typography.Paragraph>
                    <Checkbox
                      checked={overlapConfirmed}
                      disabled={
                        pending || queueCommand.uncertain || Boolean(queue)
                      }
                      onChange={(event) =>
                        setOverlapConfirmed(event.target.checked)
                      }
                    >
                      已核对上述精确 ID，仍明确并行提交本轮
                    </Checkbox>
                  </>
                }
              />
            )}
            {queue && (
              <Alert
                className="section-alert"
                type="info"
                showIcon
                title={`平台实际请求状态：${queue.request.state}`}
                description={
                  <Space direction="vertical">
                    <Typography.Text>
                      请求 {queue.request.id}；runId：
                      {queue.request.runId ?? '尚未产生'}
                    </Typography.Text>
                    <Typography.Text>
                      {queue.request.reasonCode ?? '尚无补充原因'}
                      。排队不代表真实测试已开始或完成。
                    </Typography.Text>
                    <Button onClick={() => void refreshRequest()}>
                      刷新原请求状态
                    </Button>
                  </Space>
                }
              />
            )}
            <Typography.Paragraph type="secondary">
              本次提交标识：{queueCommand.commandId}
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </PlanningActorContext.Provider>
  );
}

function EmptyState() {
  return (
    <Typography.Paragraph>
      请先选择当前有效项目，再查看和维护测试计划。
    </Typography.Paragraph>
  );
}
