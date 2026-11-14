import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from 'antd';
import { z } from 'zod';
import { planReceiptSchema } from '../../../packages/contracts/src/plans';
import { testConfigurationListSchema } from '../../../packages/contracts/src/test-configuration';
import {
  createScheduleInputSchema,
  reviseScheduleInputSchema,
  copyScheduleInputSchema,
  scheduleReceiptSchema,
  schedulePreviewSchema,
  schedulePreviewInputSchema,
  scheduleDetailSchema,
  scheduleTimelineSchema,
  type ScheduleRule,
} from '../../../packages/contracts/src/schedules';
import { api, describeError } from './api';
import { PlanningRecovery, usePlanningCommand } from './planning-command';
import { uiLayers } from './ui-layers';

type Plan = z.infer<typeof planReceiptSchema>['plan'];
export type Schedule = z.infer<typeof scheduleReceiptSchema>['schedule'];
type Timeline = z.infer<typeof scheduleTimelineSchema>;
type Detail = z.infer<typeof scheduleDetailSchema>;
type Preview = z.infer<typeof schedulePreviewSchema>;
const frequency = { once: '单次', daily: '每天', weekly: '每周' };
const stateLabels = {
  queued: '已排队',
  started: '已开始',
  completed: '已完成',
  overlapSkipped: '重叠跳过',
  missedOffline: '停机未执行',
  preconditionsMissing: '条件不满足',
  creatorUnavailable: '创建人失效',
  dstNonexistent: '时区跳时未执行',
  cancelled: '已取消',
  expired: '已过期',
};
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}
function ModalFrame({
  title,
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
  zIndex = uiLayers.dialog,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  zIndex?: number;
}) {
  return (
    <Modal
      open
      title={title}
      centered
      width={wide ? 1030 : 610}
      zIndex={zIndex}
      rootClassName="plans-page planning-modal"
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
      footer={
        footer ?? (
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      {children}
    </Modal>
  );
}
function Point({ point }: { point: Preview['points'][number] }) {
  return (
    <span>
      {point.wallDate} {point.wallTime} · {point.timeZone}
      {point.resolution === 'gap' ? (
        <>
          <br />
          <span className="caption">
            该本地时间不存在，将记录未执行，不平移时点。
          </span>
        </>
      ) : (
        <>
          <br />
          <span className="caption">
            {point.plannedAt ? `UTC ${point.plannedAt}` : '无执行时点'} ·{' '}
            {point.offset}
            {point.resolution === 'foldEarlier'
              ? `，重复时间固定较早偏移（另一个：${point.alternateOffset}）`
              : ''}
          </span>
        </>
      )}
    </span>
  );
}
function Occurrences({ items }: { items: Timeline['occurrences'] }) {
  return (
    <div className="timeline">
      {items.map((item) => (
        <span key={item.id}>
          <span
            className={`badge ${['overlapSkipped', 'missedOffline', 'preconditionsMissing', 'creatorUnavailable', 'dstNonexistent', 'expired'].includes(item.state) ? 'amber' : ''}`}
          >
            {stateLabels[item.state]}
          </span>{' '}
          <span className="muted">
            {item.point.wallDate} {item.point.wallTime} · {item.point.timeZone}
          </span>
          <br />
          <span className="caption">
            {item.reasonCode}
            {item.runId ? ` · 执行 ${item.runId}` : ''}
            {item.requestId ? ` · 请求 ${item.requestId}` : ''}
          </span>
        </span>
      ))}
    </div>
  );
}
function ScheduleHistory({
  projectId,
  schedule,
  onClose,
}: {
  projectId: string;
  schedule: Schedule;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [timeline, setTimeline] = useState<Timeline>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api(
        `/projects/${projectId}/schedules/${schedule.id}`,
        { signal: abort.signal },
        scheduleDetailSchema,
      ),
      api(
        `/projects/${projectId}/schedules/${schedule.id}/timeline`,
        { signal: abort.signal },
        scheduleTimelineSchema,
      ),
    ])
      .then(([d, t]) => {
        if (!abort.signal.aborted) {
          setDetail(d);
          setTimeline(t);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(describeError(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, schedule.id]);
  async function more() {
    if (!timeline?.nextBefore) return;
    setLoading(true);
    try {
      const next = await api(
        `/projects/${projectId}/schedules/${schedule.id}/timeline?before=${encodeURIComponent(timeline.nextBefore)}`,
        {},
        scheduleTimelineSchema,
      );
      setTimeline({
        occurrences: [...timeline.occurrences, ...next.occurrences],
        nextBefore: next.nextBefore,
      });
    } catch (error) {
      setError(describeError(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <ModalFrame title="定时修订与触发时间线" wide onClose={onClose}>
      <p className="caption">
        {schedule.planName} · 定时 {schedule.id}
      </p>
      <div className="notice mt">
        每条记录保留当时的修订和时区规则。完成只通知创建人；未执行和重叠跳过均不自动补跑。
      </div>
      {error && (
        <div className="notice red mt" role="alert">
          {error}
        </div>
      )}
      {loading && !detail && (
        <p className="caption mt" role="status">
          读取真实时间线…
        </p>
      )}
      {detail && (
        <>
          <h3 className="mt">不可变定时修订</h3>
          {detail.revisions.map((revision) => (
            <div className="listrow" key={revision.id}>
              <div className="grow">
                <b className="small">
                  r{revision.revisionNo} · {frequency[revision.rule.frequency]}{' '}
                  {revision.rule.time} · {revision.rule.timeZone}
                </b>
                <p className="caption">
                  起始 {revision.rule.date} · 计划修订 {revision.planRevisionId}
                  <br />
                  环境 {revision.environmentId} · {date(revision.createdAt)}
                </p>
              </div>
            </div>
          ))}
        </>
      )}
      <h3 className="mt">已记录时点</h3>
      {timeline?.occurrences.length ? (
        <Occurrences items={timeline.occurrences} />
      ) : (
        !loading && (
          <p className="caption mt">
            暂无已记录触发时点；不代表定时已实际执行。
          </p>
        )
      )}
      {timeline?.nextBefore && (
        <button
          className="btn mt"
          disabled={loading}
          onClick={() => void more()}
        >
          读取更早记录
        </button>
      )}
    </ModalFrame>
  );
}
function ScheduleEditor({
  projectId,
  plan,
  schedule,
  mode,
  onClose,
  onSaved,
}: {
  projectId: string;
  plan: Plan;
  schedule: Schedule | null;
  mode: 'create' | 'revise' | 'copy';
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rule, setRule] = useState<ScheduleRule>(() =>
    mode === 'copy'
      ? {
          frequency: schedule?.rule.frequency ?? 'daily',
          date: '',
          time: '',
          timeZone: schedule?.rule.timeZone ?? 'Asia/Shanghai',
        }
      : (schedule?.rule ?? {
          frequency: 'daily',
          date: today(),
          time: '09:00:00',
          timeZone: 'Asia/Shanghai',
        }),
  );
  const [revisionId, setRevisionId] = useState(
      schedule?.planRevisionId ?? plan.planRevisionId,
    ),
    [environmentId, setEnvironmentId] = useState(
      schedule?.environmentId ?? plan.environmentId,
    ),
    [name, setName] = useState(`${plan.name} · 我的定时`),
    [enabled, setEnabled] = useState(true),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [preview, setPreview] = useState<Preview>(),
    [previewing, setPreviewing] = useState(false),
    [error, setError] = useState('');
  const [environments, setEnvironments] = useState<
    z.infer<typeof testConfigurationListSchema>['configurations']
  >([]);
  const command = usePlanningCommand(
      projectId,
      `${projectId}:${mode}:${schedule?.id ?? plan.id}`,
    ),
    operation = `schedules.${mode}`;
  const locked = command.pending || command.uncertain;
  useEffect(() => {
    const abort = new AbortController();
    void api(
      `/projects/${projectId}/test-configuration?kind=environment`,
      { signal: abort.signal },
      testConfigurationListSchema,
    )
      .then((value) => {
        if (!abort.signal.aborted) setEnvironments(value.configurations);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(describeError(error));
      });
    return () => abort.abort();
  }, [projectId]);
  function change(next: Partial<ScheduleRule>) {
    setRule({ ...rule, ...next });
    setPreview(undefined);
    setDirty(true);
    setError('');
  }
  function close() {
    if (command.pending) return;
    if (dirty && !command.uncertain) setDiscard(true);
    else onClose();
  }
  async function future() {
    setPreviewing(true);
    setError('');
    try {
      const body = schedulePreviewInputSchema.parse({ rule, count: 5 });
      setPreview(
        await api(
          `/projects/${projectId}/schedules/preview`,
          { method: 'POST', body },
          schedulePreviewSchema,
        ),
      );
    } catch (error) {
      setPreview(undefined);
      setError(
        error instanceof z.ZodError
          ? '请填写完整的周期、起始日期、时间与IANA时区。'
          : describeError(error),
      );
    } finally {
      setPreviewing(false);
    }
  }
  async function saved() {
    setDirty(false);
    await onSaved();
    onClose();
  }
  async function save() {
    if (!preview || previewing || locked) return;
    const value = await command.run(
      operation,
      plan.id,
      mode === 'copy' ? '复制为本人定时计划' : '保存定时配置',
      (key) => {
        const common = { commandId: key, environmentId, rule };
        const body =
          mode === 'copy' && schedule
            ? copyScheduleInputSchema.parse({
                ...common,
                rowVersion: schedule.rowVersion,
                name,
                enabled,
              })
            : mode === 'revise' && schedule
              ? reviseScheduleInputSchema.parse({
                  ...common,
                  rowVersion: schedule.rowVersion,
                  baseRevisionId: schedule.revisionId,
                  planRevisionId: revisionId,
                })
              : createScheduleInputSchema.parse({
                  ...common,
                  planId: plan.id,
                  planRevisionId: revisionId,
                  enabled,
                });
        return api(
          `/projects/${projectId}/schedules${mode === 'create' ? '' : `/${schedule!.id}${mode === 'copy' ? '/copy' : ''}`}`,
          { method: mode === 'revise' ? 'PUT' : 'POST', body },
          scheduleReceiptSchema,
        );
      },
    );
    if (value) await saved();
  }
  const revisionOptions = [
    {
      id: plan.planRevisionId,
      environmentId: plan.environmentId,
      label: '当前计划修订',
    },
    ...(schedule && schedule.planRevisionId !== plan.planRevisionId
      ? [
          {
            id: schedule.planRevisionId,
            environmentId: schedule.environmentId,
            label: '定时当前绑定的历史修订',
          },
        ]
      : []),
  ];
  return (
    <>
      <ModalFrame
        title={
          mode === 'copy'
            ? '复制为我的接口定时计划'
            : mode === 'create'
              ? '配置接口定时回归'
              : '编辑定时回归'
        }
        wide
        onClose={close}
        busy={command.pending}
        footer={
          <>
            <button className="btn" disabled={command.pending} onClick={close}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={
                locked ||
                !preview ||
                previewing ||
                (preview.noFuturePoint && enabled)
              }
              onClick={() => void save()}
            >
              {command.pending
                ? '保存中…'
                : mode === 'copy'
                  ? '创建本人新计划与定时'
                  : '保存定时配置'}
            </button>
          </>
        }
      >
        <p className="caption">
          {plan.name} · {plan.id}
        </p>
        <div className="notice mt">
          定时只按绑定的确切计划修订与环境运行；开始时重检完整范围。修改普通计划不会自动更新定时。暂停、恢复只考虑未来时点，不补跑过去的时点。
        </div>
        {mode === 'copy' && (
          <div className="notice amber mt">
            将新建归你创建的独立接口计划与定时，原计划及其创建人保留。请明确设置一个未来的起始日期和时间。
            <p className="caption">
              来源定时 r{schedule?.revisionNo} · 固定计划修订{' '}
              {schedule?.planRevisionId}
              ；复制其原逻辑用例范围，不改用当前普通计划的新范围。
            </p>
          </div>
        )}
        {(error || command.error) && (
          <div className="notice red mt" role="alert">
            {error || command.error}
          </div>
        )}
        <PlanningRecovery
          projectId={projectId}
          operation={operation}
          command={command}
          schema={scheduleReceiptSchema}
          onRecovered={() => void saved()}
        />
        <fieldset
          disabled={locked || previewing}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <div className="formgrid mt">
            {mode === 'copy' ? (
              <label className="field-label">
                新计划名称
                <input
                  className="field"
                  value={name}
                  maxLength={200}
                  onChange={(event) => {
                    setName(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
            ) : (
              <label className="field-label">
                固定计划修订
                <select
                  value={revisionId}
                  onChange={(event) => {
                    const selected = revisionOptions.find(
                      (item) => item.id === event.target.value,
                    );
                    if (selected) {
                      setRevisionId(selected.id);
                      setEnvironmentId(selected.environmentId);
                      setDirty(true);
                    }
                  }}
                >
                  {revisionOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {item.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field-label">
              目标环境
              {mode === 'copy' ? (
                <select
                  value={environmentId}
                  onChange={(event) => {
                    setEnvironmentId(event.target.value);
                    setDirty(true);
                  }}
                >
                  <option value="">请选择</option>
                  {environments.map((env) => (
                    <option
                      key={env.id}
                      value={env.id}
                      disabled={'active' in env.content && !env.content.active}
                    >
                      {env.content.name}
                      {'active' in env.content && !env.content.active
                        ? '（已停用）'
                        : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field"
                  readOnly
                  value={
                    environments.find((env) => env.id === environmentId)
                      ?.content.name ?? environmentId
                  }
                />
              )}
            </label>
            <label className="field-label">
              周期
              <select
                value={rule.frequency}
                onChange={(event) =>
                  change({
                    frequency: event.target.value as ScheduleRule['frequency'],
                  })
                }
              >
                <option value="once">单次</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
            </label>
            <label className="field-label">
              时间
              <input
                className="field"
                type="time"
                step="1"
                value={rule.time}
                onChange={(event) => change({ time: event.target.value })}
              />
            </label>
            <label className="field-label">
              {rule.frequency === 'weekly'
                ? '起始日期（按此星期重复）'
                : '起始日期'}
              <input
                className="field"
                type="date"
                value={rule.date}
                onChange={(event) => change({ date: event.target.value })}
              />
            </label>
            <label className="field-label">
              IANA时区
              <input
                className="field"
                list="planning-time-zones"
                value={rule.timeZone}
                maxLength={100}
                onChange={(event) => change({ timeZone: event.target.value })}
              />
              <datalist id="planning-time-zones">
                {[
                  'Asia/Shanghai',
                  'UTC',
                  'America/New_York',
                  'Europe/London',
                ].map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
          </div>
          {mode !== 'revise' && (
            <label className="checkrow mt">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setDirty(true);
                }}
              />
              <span>
                保存后启用定时<small>取消时只保存为暂停状态。</small>
              </span>
            </label>
          )}
          <div className="row wrap mt">
            <button
              className="btn"
              disabled={previewing}
              onClick={() => void future()}
            >
              {previewing ? '计算中…' : '预览未来触发时点'}
            </button>
            <span className="caption">
              按所填时区计算，保存后仍由服务选择未来时点。
            </span>
          </div>
        </fieldset>
        {preview && (
          <>
            <h3 className="mt">未来预览</h3>
            {preview.noFuturePoint ? (
              <div className="notice amber mt">
                没有未来时点；不会补跑过去的单次任务。
              </div>
            ) : (
              <div className="timeline">
                {preview.points.map((point, index) => (
                  <Point key={`${point.wallDate}:${index}`} point={point} />
                ))}
              </div>
            )}
          </>
        )}
        {mode === 'revise' && (
          <p className="caption mt">
            保存配置保留当前暂停/启用状态；失效创建人的旧定时不能用编辑或恢复绕过，请复制为本人新计划。
          </p>
        )}
      </ModalFrame>
      {discard && (
        <ModalFrame
          title="有未保存的定时设置"
          zIndex={uiLayers.confirmation}
          onClose={() => setDiscard(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDiscard(false)}>
                继续编辑
              </button>
              <button className="btn danger" onClick={onClose}>
                放弃本地修改
              </button>
            </>
          }
        >
          <p>放弃只清除本地输入，不改变已保存的定时和历史记录。</p>
        </ModalFrame>
      )}
    </>
  );
}

export function PlanScheduleSection({
  projectId,
  plan,
  schedule,
  tester,
  locked = false,
  onSaved,
}: {
  projectId: string;
  plan: Plan;
  schedule: Schedule | null;
  tester: boolean;
  locked?: boolean;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'create' | 'revise' | 'copy' | null>(null),
    [history, setHistory] = useState(false),
    [timeline, setTimeline] = useState<Timeline>(),
    [error, setError] = useState('');
  const [action, setAction] = useState<'pause' | 'resume'>('pause');
  const command = usePlanningCommand(
    projectId,
    `${projectId}:${schedule?.id ?? plan.id}:${schedule?.rowVersion ?? 0}`,
  );
  useEffect(() => {
    setTimeline(undefined);
    setError('');
    if (!schedule) return;
    const abort = new AbortController();
    void api(
      `/projects/${projectId}/schedules/${schedule.id}/timeline`,
      { signal: abort.signal },
      scheduleTimelineSchema,
    )
      .then((value) => {
        if (!abort.signal.aborted) setTimeline(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(describeError(error));
      });
    return () => abort.abort();
  }, [projectId, schedule?.id, schedule?.rowVersion]);
  async function toggle() {
    if (!schedule) return;
    const next = schedule.status === 'active' ? 'pause' : 'resume';
    setAction(next);
    const receipt = await command.run(
      `schedules.${next}`,
      plan.id,
      next === 'pause' ? '暂停定时' : '恢复定时',
      (key) =>
        api(
          `/projects/${projectId}/schedules/${schedule.id}/${next}`,
          {
            method: 'POST',
            body: { commandId: key, rowVersion: schedule.rowVersion },
          },
          scheduleReceiptSchema,
        ),
    );
    if (receipt) await onSaved();
  }
  return (
    <>
      <div className="divider" />
      <div className="between">
        <div>
          <b className="small">定时回归</b>
          <p className="caption">
            {schedule
              ? `${schedule.status === 'active' ? '已启用' : schedule.status === 'completed' ? '周期已结束' : '已暂停'} · ${frequency[schedule.rule.frequency]} ${schedule.rule.time} · ${schedule.rule.timeZone}`
              : '未配置定时'}
            {schedule?.pauseReason
              ? ` · ${schedule.pauseReason === 'creatorUnavailable' ? '创建人失效，需复制为本人新计划' : schedule.pauseReason === 'manual' ? '手动暂停' : schedule.pauseReason}`
              : ''}
          </p>
        </div>
        <div className="row wrap">
          {schedule && (
            <button className="btn small" onClick={() => setHistory(true)}>
              时间线
            </button>
          )}
          {tester &&
            (schedule ? (
              <>
                <button
                  className="btn small"
                  disabled={
                    locked ||
                    command.pending ||
                    command.uncertain ||
                    (schedule.status !== 'active' &&
                      schedule.pauseReason === 'creatorUnavailable')
                  }
                  onClick={() => void toggle()}
                >
                  {command.pending
                    ? '处理中…'
                    : schedule.status === 'active'
                      ? '暂停定时'
                      : '恢复定时'}
                </button>
                <button
                  className="btn small"
                  disabled={locked || command.pending || command.uncertain}
                  onClick={() => setMode('revise')}
                >
                  编辑定时
                </button>
                <button
                  className="btn small"
                  disabled={locked || command.pending || command.uncertain}
                  onClick={() => setMode('copy')}
                >
                  复制为我的计划
                </button>
              </>
            ) : (
              <button
                className="btn small"
                disabled={locked}
                onClick={() => setMode('create')}
              >
                配置定时
              </button>
            ))}
        </div>
      </div>
      {schedule && (
        <p className="caption">
          固定计划修订 {schedule.planRevisionId} · 环境 {schedule.environmentId}
          {schedule.status === 'paused'
            ? ' · 暂停中，恢复时只考虑未来时点'
            : schedule.status === 'active' && schedule.nextPoint
              ? ` · 下一${schedule.nextPoint.resolution === 'gap' ? '记录时点（时间不存在，不执行）' : '时点'} ${schedule.nextPoint.wallDate} ${schedule.nextPoint.wallTime} (${schedule.nextPoint.timeZone})`
              : ' · 无待触发时点'}
        </p>
      )}
      {schedule && schedule.planRevisionId !== plan.planRevisionId && (
        <div className="notice amber mt">
          普通计划已有新修订，定时继续使用原固定修订。可在编辑定时中明确选择当前计划修订。
        </div>
      )}
      {(error || command.error) && (
        <div className="notice red mt" role="alert">
          {error || command.error}
        </div>
      )}
      <PlanningRecovery
        projectId={projectId}
        operation={`schedules.${action}`}
        command={command}
        schema={scheduleReceiptSchema}
        onRecovered={() => void onSaved()}
      />
      {timeline && timeline.occurrences.length > 0 && (
        <Occurrences items={timeline.occurrences.slice(0, 3)} />
      )}
      <p className="caption mt">
        完成只通知创建人；漏触发不自动补跑，重叠定时跳过并记录。
      </p>
      {mode && (
        <ScheduleEditor
          projectId={projectId}
          plan={plan}
          schedule={schedule}
          mode={mode}
          onClose={() => setMode(null)}
          onSaved={onSaved}
        />
      )}
      {history && schedule && (
        <ScheduleHistory
          projectId={projectId}
          schedule={schedule}
          onClose={() => setHistory(false)}
        />
      )}
    </>
  );
}
