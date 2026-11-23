import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Select, Space, Tabs, Tag } from 'antd';
import type { AssetContent } from '../../../packages/contracts/src/assets';

export type UiCaseRevision = {
  id: string;
  revisionNo: number;
  content: AssetContent;
};

type UiCase = Extract<AssetContent, { kind: 'UI'; testPoint: string }>;
type Step = NonNullable<UiCase['steps']>[number];
type Assertion = NonNullable<UiCase['assertions']>[number];

function uiCase(content: AssetContent): UiCase | undefined {
  return 'testPoint' in content && content.kind === 'UI' ? content : undefined;
}

export function UiCaseText({ content }: { content: AssetContent }) {
  const value = uiCase(content);
  if (!value) return null;
  return (
    <dl className="ui-review-case-text">
      <div>
        <dt>测试点</dt>
        <dd>{value.testPoint}</dd>
      </div>
      {value.preconditions.length > 0 && (
        <div>
          <dt>前置条件</dt>
          <dd>
            <ul>
              {value.preconditions.map((condition, index) => (
                <li key={index}>{condition}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      <div>
        <dt>参考路径与逐步预期</dt>
        <dd>
          {value.steps?.length ? (
            <ol className="ui-case-steps">
              {value.steps.map((step, index) => (
                <li key={index} className="ui-case-step-text">
                  <span aria-hidden="true">{index + 1}</span>
                  <div>
                    {step.action}
                    {step.expected && (
                      <div className="muted">预期 {step.expected}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <span className="muted">该修订未记录参考路径</span>
          )}
        </dd>
      </div>
      <div>
        <dt>业务断言与取证参考</dt>
        <dd>
          {value.assertions?.length ? (
            <ul className="ui-case-assertion-list">
              {value.assertions.map((assertion) => (
                <li key={assertion.id}>
                  <span className="caption">{assertion.id}</span>
                  {' · '}
                  {assertion.expected}
                  {assertion.evidenceHint && (
                    <div className="muted">
                      取证参考 · {assertion.evidenceHint}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">
              待完善 · 该修订未单列可独立核对的业务断言。
            </span>
          )}
        </dd>
      </div>
      <div className="ui-case-expected-block">
        <dt>用例整体预期</dt>
        <dd>{value.expected}</dd>
      </div>
      {value.basisRefs.length > 0 && (
        <div>
          <dt>需求依据</dt>
          <dd>
            <ul>
              {value.basisRefs.map((ref, index) => (
                <li key={index}>{ref.description}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}

function stepText(step: Step | undefined) {
  return step
    ? [step.action, step.expected].filter(Boolean).join('\n预期 ')
    : '';
}

function assertionText(assertion: Assertion | undefined) {
  if (!assertion) return '';
  return [
    assertion.expected,
    assertion.evidenceHint && '取证参考 · ' + assertion.evidenceHint,
  ]
    .filter(Boolean)
    .join('\n');
}

function changedOrder(before: Step[], after: Step[]) {
  const uniquePositions = (steps: Step[]) => {
    const result = new Map<string, number | null>();
    steps.forEach((step, index) => {
      const key = JSON.stringify([step.action, step.expected]);
      result.set(key, result.has(key) ? null : index);
    });
    return result;
  };
  const left = uniquePositions(before);
  const right = uniquePositions(after);
  const common = [...left].flatMap(([key, index]) => {
    const next = right.get(key);
    return typeof index === 'number' && typeof next === 'number'
      ? [{ index, next }]
      : [];
  });
  return common.filter(
    ({ index, next }) =>
      index !== next &&
      common.some((other) => (other.index - index) * (other.next - next) < 0),
  );
}

function RevisionCompare({
  revisions,
  defaultFrom,
  defaultTo,
}: {
  revisions: UiCaseRevision[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const baseline = revisions.find((entry) => entry.id === from);
  const returned = revisions.find((entry) => entry.id === to);
  const before = baseline && uiCase(baseline.content);
  const after = returned && uiCase(returned.content);
  const options = revisions.map((entry) => ({
    value: entry.id,
    label: 'r' + entry.revisionNo,
  }));
  if (!before || !after)
    return <Empty description="未读取到可比较的两份修订。" />;
  const beforeSteps = before.steps ?? [];
  const afterSteps = after.steps ?? [];
  const beforeAssertions = new Map(
    before.assertions?.map((item) => [item.id, item]),
  );
  const afterAssertions = new Map(
    after.assertions?.map((item) => [item.id, item]),
  );
  const fields = [
    ['标题', before.title, after.title],
    ['测试点', before.testPoint, after.testPoint],
    [
      '前置条件',
      before.preconditions.join('\n'),
      after.preconditions.join('\n'),
    ],
    ...Array.from(
      { length: Math.max(beforeSteps.length, afterSteps.length) },
      (_, i) => [
        '步骤 ' + (i + 1),
        stepText(beforeSteps[i]),
        stepText(afterSteps[i]),
      ],
    ),
    ['整体预期', before.expected, after.expected],
    ...[
      ...new Set([...beforeAssertions.keys(), ...afterAssertions.keys()]),
    ].map((id) => [
      '业务断言 ' + id,
      assertionText(beforeAssertions.get(id)),
      assertionText(afterAssertions.get(id)),
    ]),
    [
      '需求依据',
      before.basisRefs.map((ref) => ref.description).join('\n'),
      after.basisRefs.map((ref) => ref.description).join('\n'),
    ],
  ];
  const changes = fields.filter(([, a, b]) => a !== b);
  const unchanged = fields.filter(([, a, b]) => a === b);
  const reordered = changedOrder(beforeSteps, afterSteps);
  return (
    <div className="ui-case-compare">
      <Space wrap>
        <span>基准</span>
        <Select
          aria-label="基准修订"
          value={from}
          options={options}
          onChange={setFrom}
        />
        <span>对比</span>
        <Select
          aria-label="对比修订"
          value={to}
          options={options}
          onChange={setTo}
        />
      </Space>
      {!!reordered.length && (
        <Alert
          type="info"
          showIcon
          title={`相同步骤的相对顺序发生变化 ${reordered.map(({ index, next }) => `${index + 1} → ${next + 1}`).join('、')}`}
        />
      )}
      {changes.length ? (
        changes.map(([label, a, b]) => (
          <article className="ui-case-diff" key={label}>
            <strong>
              {label} · {a && b ? '已修改' : b ? '新增' : '已删除'}
            </strong>
            <div className="ui-review-compare">
              <div>
                <b>基准</b>
                <pre>{a || '该修订未记录'}</pre>
              </div>
              <div>
                <b>对比</b>
                <pre>{b || '该修订未记录'}</pre>
              </div>
            </div>
          </article>
        ))
      ) : (
        <p className="caption">所选修订未发现字段差异。</p>
      )}
      {!!unchanged.length && (
        <details className="ui-review-diff">
          <summary>查看未变字段 · {unchanged.length} 项</summary>
          {unchanged.map(([label, value]) => (
            <div key={label}>
              <strong>{label}</strong>
              <p className="preserve-lines">{value || '该修订未记录'}</p>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function UiCaseReader({
  revisions,
  currentRevisionId,
  revisionId,
  onRevision,
  timeline,
  frozen,
  comparison,
}: {
  revisions: UiCaseRevision[];
  currentRevisionId: string;
  revisionId: string;
  onRevision: (id: string) => void;
  timeline?: ReactNode;
  frozen: boolean;
  comparison?: { from: string; to: string; key: string } | undefined;
}) {
  const [tab, setTab] = useState('body');
  useEffect(() => {
    if (comparison) setTab('diff');
  }, [comparison]);
  const current = revisions.find((entry) => entry.id === currentRevisionId);
  const selected = revisions.find((entry) => entry.id === revisionId);
  if (!current || !selected)
    return <Empty description="未读取到所选用例修订。" />;
  const historical = selected.id !== currentRevisionId;
  const baseline =
    revisions.find((entry) => entry.id === comparison?.from) ??
    (historical
      ? selected
      : (revisions.find((entry) => entry.revisionNo < current.revisionNo) ??
        current));
  const target =
    revisions.find((entry) => entry.id === comparison?.to) ?? current;
  return (
    <>
      <Space wrap className="ui-case-revision-controls">
        <b>用例修订</b>
        <Select
          aria-label="用例修订"
          size="small"
          disabled={revisions.length < 2}
          value={selected.id}
          options={revisions.map((entry) => ({
            value: entry.id,
            label: `r${entry.revisionNo}（${entry.id === currentRevisionId ? (frozen ? '会话保存' : '当前') : '历史修订'}）`,
          }))}
          onChange={(id) => {
            onRevision(id);
            setTab('body');
          }}
        />
        {(frozen || historical) && <Tag>只读</Tag>}
        {historical && (
          <Button
            size="small"
            onClick={() => {
              onRevision(currentRevisionId);
              setTab('body');
            }}
          >
            {frozen ? '返回会话保存修订' : '返回当前修订'}
          </Button>
        )}
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'body',
            label: '用例正文',
            children: <UiCaseText content={selected.content} />,
          },
          {
            key: 'diff',
            label: '修订对比',
            children: (
              <RevisionCompare
                key={
                  baseline.id + ':' + target.id + ':' + (comparison?.key ?? '')
                }
                revisions={revisions}
                defaultFrom={baseline.id}
                defaultTo={target.id}
              />
            ),
          },
          {
            key: 'history',
            label: '评审记录',
            children: timeline ?? (
              <Empty description="当前范围暂无可展示的评审记录。" />
            ),
          },
        ]}
      />
    </>
  );
}
