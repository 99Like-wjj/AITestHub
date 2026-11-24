import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base';
import {
  prepareRetestInputSchema,
  retestPreparationSchema,
  retestPreparationListSchema,
  startApiRetestInputSchema,
  apiRetestStartReceiptSchema,
  apiRetestStartPreviewSchema,
  apiRetestStartStatusSchema,
} from '../../../packages/contracts/src/retests';
import { assetListSchema } from '../../../packages/contracts/src/assets';
import type { Asset } from '../../../packages/contracts/src/assets';
import type { Issue } from '../../../packages/contracts/src/issues';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import type { TestConfigurationView } from '../../../packages/contracts/src/test-configuration';
import type { Project } from './types';
import type { IssueNavigation } from './issue-context';
import { api, describeError } from './api';
import { CommandDialog, useBusinessCommand } from './business-command';
import { uiLayers } from './ui-layers';
import { RecoveryBlock, RecoveryQueryForm } from './recovery-block';

type Preparation = z.infer<typeof retestPreparationSchema>;
type StartReceipt = z.infer<typeof apiRetestStartReceiptSchema>;
interface Choice {
  kind: 'UI' | 'API';
  level: 'case' | 'scenario';
  environmentId: string | null;
  productBuild: string;
  requirementVersionId: string | null;
  caseIds: string[];
  scenarioIds: string[];
  contextLabel: string;
}
export interface RetestTarget {
  session: string;
  issues: Issue[];
}

function RetestReceiptLookup({
  projectId,
  initialId,
}: {
  projectId: string;
  initialId?: string;
}) {
  const [id, setId] = useState(initialId ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [receipt, setReceipt] = useState<StartReceipt | null>(null);
  const generation = useRef(0);
  async function load() {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
      setError('请输入有效的原开始提交 UUID。');
      return;
    }
    const epoch = ++generation.current;
    setLoading(true);
    setError(undefined);
    setStatus(undefined);
    setReceipt(null);
    try {
      const result = await api(
        `/projects/${projectId}/retests/api-start-receipts/${parsed.data}`,
        {},
        apiRetestStartStatusSchema,
      );
      if (epoch !== generation.current) return;
      if (result.commandId !== parsed.data)
        throw new Error('原提交回执标识不匹配。');
      setStatus(result.status);
      setReceipt(result.response);
    } catch (failure) {
      if (epoch === generation.current)
        setError(
          `${describeError(failure)}；未查到不表示未受理，保留原标识，不换ID自动重发。`,
        );
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  return (
    <RecoveryBlock
      title="查询原接口复测提交"
      description="用原开始提交标识核对服务端状态和对应的执行轮次。"
    >
      <RecoveryQueryForm onFinish={() => void load()}>
        <Form.Item label="原提交 ID">
          <Input
            aria-label="原接口复测提交ID"
            value={id}
            disabled={loading}
            onChange={(event) => {
              setId(event.target.value);
              setError(undefined);
              setStatus(undefined);
              setReceipt(null);
            }}
            autoComplete="off"
            placeholder="输入原记录标识"
          />
        </Form.Item>
        <Form.Item className="recovery-query-submit">
          <Button type="primary" htmlType="submit" loading={loading}>
            查询原记录
          </Button>
        </Form.Item>
      </RecoveryQueryForm>
      {error && <Alert type="warning" title={error} showIcon />}
      {status && <Typography.Text>原操作账本状态：{status}</Typography.Text>}
      {receipt && (
        <Alert
          type="info"
          showIcon
          title={`原轮次 ${receipt.runId} · 初始回执 prepared`}
          description="仅表示已准备，执行状态及报告需按原轮次读取。"
          action={
            <a href={`/#reports?projectId=${projectId}&runId=${receipt.runId}`}>
              查看原轮次状态
            </a>
          }
        />
      )}
    </RecoveryBlock>
  );
}

export function RetestScopeView({
  project,
  preparation,
}: {
  project: Project;
  preparation: Preparation;
}) {
  const [subsetConfirmed, setSubsetConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [preview, setPreview] = useState<z.infer<
    typeof apiRetestStartPreviewSchema
  > | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [startSession, setStartSession] = useState<string | null>(null);
  const [overlapConfirmed, setOverlapConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<StartReceipt | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<string>();
  const requestEpoch = useRef(0);
  const command = useBusinessCommand(startSession);
  const tester = project.roles.includes('tester');
  const hasGaps = preparation.missingRequirements.length > 0;
  useEffect(() => {
    setPreview(null);
    setStartSession(null);
    setReceipt(null);
    setSubsetConfirmed(false);
    setCopied(undefined);
    requestEpoch.current += 1;
  }, [preparation.preparationId, preparation.revisionId]);
  async function readPreview(groupId: string) {
    const epoch = ++requestEpoch.current;
    setPreviewLoading(true);
    setError(undefined);
    try {
      const value = await api(
        `/projects/${project.id}/retests/groups/${groupId}/start-preview`,
        {},
        apiRetestStartPreviewSchema,
      );
      if (epoch !== requestEpoch.current) return;
      setPreview(value);
      setStartSession(crypto.randomUUID());
      setOverlapConfirmed(false);
      setReceipt(null);
      setRecoveryStatus(undefined);
    } catch (failure) {
      if (epoch === requestEpoch.current) setError(describeError(failure));
    } finally {
      if (epoch === requestEpoch.current) setPreviewLoading(false);
    }
  }
  async function start() {
    if (
      !preview ||
      receipt ||
      (hasGaps && !subsetConfirmed) ||
      (preview.existingRunIds.length && !overlapConfirmed)
    )
      return;
    const result = await command.run((commandId) =>
      api(
        `/projects/${project.id}/retests/groups/${preview.group.groupId}/start-api`,
        {
          method: 'POST',
          body: startApiRetestInputSchema.parse({
            commandId,
            scopeDigest: preview.scopeDigest,
            confirmedExistingRunIds: preview.existingRunIds,
          }),
        },
        apiRetestStartReceiptSchema,
      ),
    );
    if (result) setReceipt(result);
  }
  async function recover() {
    const epoch = requestEpoch.current;
    const original = command.commandId;
    setRecovering(true);
    try {
      const value = await api(
        `/projects/${project.id}/retests/api-start-receipts/${original}`,
        {},
        apiRetestStartStatusSchema,
      );
      if (epoch !== requestEpoch.current) return;
      if (value.commandId !== original)
        throw new Error('原开始提交回执不匹配。');
      setRecoveryStatus(value.status);
      if (value.response) {
        setReceipt(value.response);
        command.confirmRecoveredReceipt();
      }
    } catch (failure) {
      if (epoch === requestEpoch.current)
        command.setError(`${describeError(failure)}；保留原标识，不自动重发。`);
    } finally {
      if (epoch === requestEpoch.current) setRecovering(false);
    }
  }
  function closeStart() {
    requestEpoch.current += 1;
    setPreview(null);
    setStartSession(null);
    setReceipt(null);
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions
        bordered
        size="small"
        column={1}
        items={[
          {
            key: 'id',
            label: '固定准备范围',
            children: preparation.preparationId,
          },
          { key: 'rev', label: '准备修订', children: preparation.revisionId },
          {
            key: 'creator',
            label: '原创建人',
            children: preparation.createdBy,
          },
          { key: 'time', label: '创建时间', children: preparation.createdAt },
        ]}
      />
      <Alert
        type={hasGaps ? 'warning' : 'info'}
        showIcon
        title={`实际固定 ${preparation.groups.length} 个分组；完整缺口 ${preparation.missingRequirements.length} 项`}
        description="按原需求版本、类型、环境等分组；重复用例去重后保留多缺陷关联，不创建正式计划，不自动升级新需求版本。"
      />
      {hasGaps && (
        <>
          <Table
            rowKey={(row, index) => `${row.code}:${row.objectId}:${index}`}
            pagination={false}
            dataSource={preparation.missingRequirements}
            columns={[
              { title: '对象', dataIndex: 'objectId' },
              { title: '缺口代码', dataIndex: 'code' },
              { title: '说明', dataIndex: 'message' },
            ]}
          />
          <Checkbox
            checked={subsetConfirmed}
            onChange={(event) => setSubsetConfirmed(event.target.checked)}
          >
            已核对全部缺口，后续仅明确使用下面实际固定的有效分组范围
          </Checkbox>
        </>
      )}
      {error && <Alert type="error" showIcon title={error} />}
      {!preparation.groups.length && (
        <Typography.Paragraph type="secondary">
          尚无可用固定分组，请根据完整缺口补齐后明确准备新范围。
        </Typography.Paragraph>
      )}
      {preparation.groups.map((group) => (
        <Card
          key={group.groupId}
          size="small"
          title={`${group.kind} · ${group.environment.content.name} · ${group.items.length} 个固定用例`}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>
              固定分组 {group.groupId} · 环境修订 {group.environment.revisionId}{' '}
              · 产品构建 {group.productBuild ?? '未指定'}
            </Typography.Text>
            <Typography.Text>{group.context.label}</Typography.Text>
            <Typography.Text type="secondary">
              来源执行：
              {group.context.sourceRunIds.length
                ? group.context.sourceRunIds.join('、')
                : '无可追溯原执行，按人工映射准备'}
            </Typography.Text>
            <Table
              rowKey={(row) => `${row.ordinal}:${row.caseId}`}
              pagination={{ pageSize: 8 }}
              dataSource={group.items}
              scroll={{ x: 900 }}
              columns={[
                {
                  title: '场景',
                  render: (_, row) => row.scenario?.title ?? '独立单接口用例',
                },
                { title: '用例', render: (_, row) => row.content.title },
                { title: '精确批准', dataIndex: 'approvalSnapshotId' },
                { title: '需求版本', dataIndex: 'requirementVersionId' },
                {
                  title: '保留缺陷关联',
                  render: (_, row) => row.issueIds.join('、'),
                },
              ]}
            />
            {group.kind === 'UI' ? (
              <>
                <Alert
                  type="info"
                  title="固定范围已准备；本地执行 Skill 本轮延期"
                  description="用户在本地AI + Skill + Ego发起；此处不远程唤醒或新增服务器UI执行器，复制指引不表示已启动。"
                  showIcon
                />
                <Button
                  disabled={!tester || (hasGaps && !subsetConfirmed)}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(
                        `AITestHub本地UI复测固定范围\nprojectId=${project.id}\npreparationId=${preparation.preparationId}\ngroupId=${group.groupId}\nsourceType=retestPreparation\nsourceRevisionId=${group.groupId}\n固定用例=${group.items.map((row) => row.caseId).join(',')}\n缺口=${JSON.stringify(preparation.missingRequirements)}\n仅范围指引；四个Skill本轮未交付，不表示本地执行器已接入或任务已启动。`,
                      )
                      .then(() => setCopied(group.groupId))
                      .catch((failure: unknown) =>
                        setError(describeError(failure)),
                      );
                  }}
                >
                  复制固定范围与本地发起指引
                </Button>
                {copied === group.groupId && (
                  <Typography.Text role="status">
                    固定范围指引已复制；未启动执行。
                  </Typography.Text>
                )}
              </>
            ) : (
              <Button
                type="primary"
                disabled={
                  !tester || (hasGaps && !subsetConfirmed) || previewLoading
                }
                onClick={() => void readPreview(group.groupId)}
              >
                读取此固定分组的开始前预览
              </Button>
            )}
          </Space>
        </Card>
      ))}
      <CommandDialog
        open={preview !== null}
        zIndex={uiLayers.nestedDialog}
        title="接口直接复测 · 原固定分组开始确认"
        command={command}
        dirty={false}
        onClose={closeStart}
        onSave={() => void start()}
        allowSave={
          !receipt &&
          (!preview?.existingRunIds.length || overlapConfirmed) &&
          (!hasGaps || subsetConfirmed)
        }
        saveLabel={receipt ? '已取得原轮次回执' : '明确开始此精确接口复测范围'}
        width={1000}
      >
        {preview && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              title="明确开始将创建平台接口复测轮次，可能发起真实请求"
              description="只采用原固定批准范围，不按最新草稿漂移；请求和清理不自动重试，不因本次复测通过自动关闭缺陷。"
            />
            <Typography.Paragraph>
              分组 {preview.group.groupId} · 摘要 {preview.scopeDigest} ·
              固定用例 {preview.group.items.length} 条
            </Typography.Paragraph>
            <Table
              rowKey="caseId"
              pagination={false}
              dataSource={preview.group.items}
              columns={[
                { title: '用例', render: (_, row) => row.content.title },
                { title: '固定批准', dataIndex: 'approvalSnapshotId' },
                {
                  title: '关联缺陷',
                  render: (_, row) => row.issueIds.join('、'),
                },
              ]}
            />
            {!!preview.existingRunIds.length && (
              <>
                <Alert
                  type="warning"
                  showIcon
                  title="此固定分组存在未结束轮次"
                  description={preview.existingRunIds.join('、')}
                />
                <Checkbox
                  checked={overlapConfirmed}
                  onChange={(event) =>
                    setOverlapConfirmed(event.target.checked)
                  }
                >
                  已核对此处确切轮次ID，明确再启动新一轮
                </Checkbox>
              </>
            )}
            {command.uncertain && (
              <RecoveryBlock
                variant="pending"
                title="核对复测开始回执"
                reference={command.commandId}
                actions={
                  <Button
                    size="small"
                    loading={recovering}
                    onClick={() => void recover()}
                  >
                    查询原回执
                  </Button>
                }
              />
            )}
            {recoveryStatus && (
              <Typography.Text>
                原提交账本状态：{recoveryStatus}
              </Typography.Text>
            )}
            {receipt && (
              <Alert
                type="info"
                title={`原轮次 ${receipt.runId} · 初始回执 ${receipt.state}`}
                description="prepared不表示请求已发出、测试通过或缺陷已关闭。"
                showIcon
                action={
                  <a
                    href={`/#reports?projectId=${project.id}&runId=${receipt.runId}`}
                  >
                    查看原轮次实时状态/报告
                  </a>
                }
              />
            )}
            <Typography.Paragraph>
              <a
                href={`/#issues?projectId=${project.id}&retestCommandId=${command.commandId}`}
              >
                保留此开始提交的只读找回链接
              </a>
            </Typography.Paragraph>
          </Space>
        )}
      </CommandDialog>
    </Space>
  );
}

export function RetestPreparationDialog({
  project,
  target,
  requirements,
  onClose,
  onPrepared,
}: {
  project: Project;
  target: RetestTarget | null;
  requirements: IssueNavigation;
  onClose: () => void;
  onPrepared: () => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [name, setName] = useState('');
  const [environments, setEnvironments] = useState<TestConfigurationView[]>([]);
  const [metadataError, setMetadataError] = useState<string>();
  const [assets, setAssets] = useState<Record<string, Asset[]>>({});
  const [prepared, setPrepared] = useState<Preparation | null>(null);
  const [version, setVersion] = useState(0);
  const command = useBusinessCommand(
    target ? `${target.session}:${version}` : null,
  );
  useEffect(() => {
    if (!target) return;
    setName('');
    setPrepared(null);
    setVersion(0);
    setChoices(
      Object.fromEntries(
        target.issues.map((issue) => [
          issue.id,
          {
            kind: 'UI',
            level: 'case',
            environmentId: null,
            productBuild: '',
            requirementVersionId: issue.requirementVersionId,
            caseIds: [],
            scenarioIds: [],
            contextLabel: '',
          },
        ]),
      ),
    );
    const controller = new AbortController();
    setEnvironments([]);
    setMetadataError(undefined);
    void api(
      `/projects/${project.id}/test-configuration?kind=environment`,
      { signal: controller.signal },
      testConfigurationListSchema,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setEnvironments(
            result.configurations.filter(
              (row) => row.content.kind === 'environment' && row.content.active,
            ),
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setMetadataError(describeError(failure));
      });
    return () => controller.abort();
  }, [target, project.id]);
  const keys = [
    ...new Set(
      Object.values(choices)
        .filter((row) => row.requirementVersionId)
        .map((row) => `${row.kind}:${row.requirementVersionId}`),
    ),
  ]
    .sort()
    .join('|');
  useEffect(() => {
    const controller = new AbortController();
    if (!keys) return;
    void Promise.allSettled(
      keys.split('|').map(async (key) => {
        const [kind, versionId] = key.split(':');
        return {
          key,
          response: await api(
            `/projects/${project.id}/assets?kind=${kind}&requirementVersionId=${versionId}`,
            { signal: controller.signal },
            assetListSchema,
          ),
        };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setAssets((previous) => ({
        ...previous,
        ...Object.fromEntries(
          results.flatMap((result) =>
            result.status === 'fulfilled'
              ? [[result.value.key, result.value.response.assets]]
              : [],
          ),
        ),
      }));
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => describeError(result.reason));
      if (failures.length) setMetadataError(failures.join('；'));
    });
    return () => controller.abort();
  }, [project.id, keys]);
  function update(id: string, change: Partial<Choice>) {
    setChoices((previous) => {
      const row = previous[id];
      return row ? { ...previous, [id]: { ...row, ...change } } : previous;
    });
  }
  async function submit() {
    if (!target || prepared) return;
    const value = await command.run((commandId) => {
      const selections = target.issues.map((issue) => {
        const row = choices[issue.id];
        if (!row) throw new Error('范围草稿尚未就绪。');
        return {
          issueId: issue.id,
          rowVersion: issue.rowVersion,
          kind: row.kind,
          level: row.level,
          environmentId: row.environmentId,
          productBuild: row.productBuild.trim() || null,
          ...(row.requirementVersionId
            ? { requirementVersionId: row.requirementVersionId }
            : {}),
          ...(row.caseIds.length ? { caseIds: row.caseIds } : {}),
          ...(row.scenarioIds.length ? { scenarioIds: row.scenarioIds } : {}),
          ...(row.contextLabel ? { contextLabel: row.contextLabel } : {}),
        };
      });
      return api(
        `/projects/${project.id}/retests`,
        {
          method: 'POST',
          body: prepareRetestInputSchema.parse({ commandId, name, selections }),
        },
        retestPreparationSchema,
      );
    });
    if (value) {
      setPrepared(value);
      await onPrepared();
    }
  }
  return (
    <CommandDialog
      open={target !== null}
      title="直接准备场景/用例级复测 · 不先建正式计划"
      command={command}
      dirty={!prepared}
      onClose={onClose}
      onSave={() => void submit()}
      allowSave={!prepared}
      saveLabel={prepared ? '已生成固定范围' : '明确准备此批复测范围'}
      width={1200}
    >
      {prepared ? (
        <>
          <RetestScopeView project={project} preparation={prepared} />
          <Button
            onClick={() => {
              setPrepared(null);
              setVersion((value) => value + 1);
            }}
          >
            保留原准备历史，重新准备新范围
          </Button>
        </>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            title="只准备固定范围；不自动运行、关闭或改写缺陷"
            description="原需求版本/原范围可追溯时按原关联取已审。新需求版本必须明确映射场景/用例，不按同名猜测；无法执行的项完整列缺口，不静默视为通过。"
          />
          {metadataError && (
            <Alert type="warning" title={metadataError} showIcon />
          )}
          <Input
            aria-label="复测准备名称"
            value={name}
            maxLength={200}
            placeholder="本次复测准备名称"
            onChange={(event) => setName(event.target.value)}
            disabled={command.pending}
          />
          <Collapse
            items={(target?.issues ?? []).map((issue) => {
              const row = choices[issue.id];
              const data = row?.requirementVersionId
                ? (assets[`${row.kind}:${row.requirementVersionId}`] ?? [])
                : [];
              return {
                key: issue.id,
                label: `${issue.number} ${issue.title} · 固定缺陷基准v${issue.rowVersion}`,
                children: row ? (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                      <Select
                        aria-label={`${issue.number} 复测类型`}
                        value={row.kind}
                        disabled={command.pending}
                        options={[
                          { value: 'UI', label: '用户本地UI复测' },
                          { value: 'API', label: '平台接口复测' },
                        ]}
                        onChange={(kind: Choice['kind']) =>
                          update(issue.id, {
                            kind,
                            caseIds: [],
                            scenarioIds: [],
                          })
                        }
                      />
                      <Select
                        aria-label={`${issue.number} 范围层级`}
                        value={row.level}
                        disabled={command.pending}
                        options={[
                          { value: 'case', label: '用例级' },
                          { value: 'scenario', label: '场景级' },
                        ]}
                        onChange={(level: Choice['level']) =>
                          update(issue.id, {
                            level,
                            caseIds: [],
                            scenarioIds: [],
                          })
                        }
                      />
                    </Space>
                    <Select
                      aria-label={`${issue.number} 明确环境`}
                      style={{ width: '100%' }}
                      value={row.environmentId}
                      disabled={command.pending}
                      placeholder="明确选择环境（必填）"
                      options={environments.map((environment) => ({
                        value: environment.id,
                        label: environment.content.name,
                      }))}
                      onChange={(environmentId: string) =>
                        update(issue.id, { environmentId })
                      }
                    />
                    <Input
                      aria-label={`${issue.number} 被测构建`}
                      value={row.productBuild}
                      maxLength={200}
                      placeholder="产品构建版本（可留空）"
                      disabled={command.pending}
                      onChange={(event) =>
                        update(issue.id, { productBuild: event.target.value })
                      }
                    />
                    <Select
                      aria-label={`${issue.number} 需求版本`}
                      style={{ width: '100%' }}
                      value={row.requirementVersionId}
                      allowClear
                      disabled={command.pending}
                      placeholder="不指定时仅尝试可唯一追溯的原版本"
                      options={(
                        requirements.find(
                          (requirement) =>
                            requirement.id === issue.requirementId,
                        )?.versions ?? []
                      ).map((value) => ({
                        value: value.id,
                        label: `v${value.versionNo} · ${value.id}`,
                      }))}
                      onChange={(requirementVersionId: string | undefined) =>
                        update(issue.id, {
                          requirementVersionId: requirementVersionId ?? null,
                          caseIds: [],
                          scenarioIds: [],
                        })
                      }
                    />
                    <Select
                      aria-label={`${issue.number} 明确映射范围`}
                      mode="multiple"
                      style={{ width: '100%' }}
                      value={
                        row.level === 'case' ? row.caseIds : row.scenarioIds
                      }
                      disabled={command.pending || !row.requirementVersionId}
                      placeholder="可显式选择该版本范围；留空只尝试原关联，缺口如实返回"
                      options={data
                        .filter((asset) => asset.targetType === row.level)
                        .map((asset) => ({
                          value: asset.id,
                          label: `${asset.title} · r${asset.revisionNo} · ${asset.reviewState}`,
                        }))}
                      onChange={(ids: string[]) =>
                        update(
                          issue.id,
                          row.level === 'case'
                            ? { caseIds: ids }
                            : { scenarioIds: ids },
                        )
                      }
                    />
                    <Input
                      aria-label={`${issue.number} 复测上下文说明`}
                      value={row.contextLabel}
                      maxLength={2000}
                      placeholder="额外上下文说明（可留空，不替代缺口）"
                      disabled={command.pending}
                      onChange={(event) =>
                        update(issue.id, { contextLabel: event.target.value })
                      }
                    />
                  </Space>
                ) : null,
              };
            })}
          />
        </Space>
      )}
    </CommandDialog>
  );
}

export function RetestHistory({
  project,
  open,
  onClose,
  initialCommandId,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  initialCommandId?: string;
}) {
  const [rows, setRows] = useState<
    z.infer<typeof retestPreparationListSchema>['preparations']
  >([]);
  const [selected, setSelected] = useState<Preparation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  async function load(signal?: AbortSignal) {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const response = await api(
        `/projects/${project.id}/retests`,
        signal ? { signal } : {},
        retestPreparationListSchema,
      );
      if (!signal?.aborted && epoch === generation.current) {
        setRows(response.preparations);
        setError(undefined);
      }
    } catch (failure) {
      if (!signal?.aborted && epoch === generation.current)
        setError(describeError(failure));
    } finally {
      if (!signal?.aborted && epoch === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSelected(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [open, project.id]);
  async function read(id: string) {
    const epoch = ++generation.current;
    setLoading(true);
    setSelected(null);
    try {
      const response = await api(
        `/projects/${project.id}/retests/${id}`,
        {},
        retestPreparationSchema,
      );
      if (epoch === generation.current) setSelected(response);
    } catch (failure) {
      if (epoch === generation.current) setError(describeError(failure));
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  return (
    <Drawer
      open={open}
      title="固定复测范围与原开始回执"
      width={1250}
      onClose={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Button loading={loading} onClick={() => void load()}>
          只读刷新准备历史
        </Button>
        {error && <Alert type="error" title={error} showIcon />}
        <RetestReceiptLookup
          key={`${project.id}:${initialCommandId ?? ''}`}
          projectId={project.id}
          {...(initialCommandId ? { initialId: initialCommandId } : {})}
        />
        <Table
          rowKey="id"
          pagination={{ pageSize: 10 }}
          loading={loading}
          dataSource={rows}
          scroll={{ x: 800 }}
          columns={[
            {
              title: '固定准备',
              render: (_, row) => (
                <Button type="link" onClick={() => void read(row.id)}>
                  {row.name}
                </Button>
              ),
            },
            { title: '准备ID', dataIndex: 'id' },
            { title: '原创建人', dataIndex: 'createdBy' },
            { title: '时间', dataIndex: 'createdAt' },
          ]}
        />
        {selected && (
          <RetestScopeView project={project} preparation={selected} />
        )}
      </Space>
    </Drawer>
  );
}
