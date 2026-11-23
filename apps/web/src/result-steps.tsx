import { useState } from 'react';
import { Alert, Card, Collapse, Tag, Typography } from 'antd';
import type { z } from 'zod';
import type {
  resultItemSchema,
  resultEvidenceGapSchema,
} from '../../../packages/contracts/src/domain';
import type { resultScopeItemSchema } from '../../../packages/contracts/src/ui-results';
import { EvidenceGallery } from './evidence-gallery';
import type { EvidenceGalleryItem } from './evidence-gallery';
import { StatusTag } from './semantic-status';

type Content = z.infer<typeof resultItemSchema>;
type Scope = z.infer<typeof resultScopeItemSchema>;
type Gap = z.infer<typeof resultEvidenceGapSchema>;

export const outcomeLabels: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
  inconclusive: '证据不足',
  notExecuted: '未执行',
  notReported: '未回传',
  notAssessed: '尚无人工最终结论',
};
const gapLabels: Record<Gap['state'], string> = {
  notCaptured: '未采集',
  pendingUpload: '已采集待上传',
  uploadFailed: '上传失败',
};
export function ResultOutcomeTag({ outcome }: { outcome: string }) {
  return (
    <StatusTag
      tone={
        outcome === 'passed'
          ? 'success'
          : outcome === 'failed'
            ? 'error'
            : outcome === 'blocked' || outcome === 'inconclusive'
              ? 'warning'
              : 'neutral'
      }
    >
      {outcomeLabels[outcome] ?? outcome}
    </StatusTag>
  );
}

export function EvidenceGapList({ gaps }: { gaps: readonly Gap[] }) {
  if (!gaps.length) return null;
  return (
    <div className="result-evidence-gaps">
      {gaps.map((gap, index) => (
        <article className="result-evidence-gap" key={index}>
          <Tag
            color={
              gap.state === 'uploadFailed'
                ? 'error'
                : gap.state === 'pendingUpload'
                  ? 'processing'
                  : 'warning'
            }
          >
            {gapLabels[gap.state]}
          </Tag>
          <strong>{gap.label}</strong>
          {gap.ordinal && (
            <span className="result-review-muted">步骤 {gap.ordinal}</span>
          )}
          {gap.assertionIds?.length ? (
            <span className="result-review-muted">
              断言 {gap.assertionIds.join('、')}
            </span>
          ) : null}
          <p className="result-review-lines">{gap.reason}</p>
        </article>
      ))}
    </div>
  );
}

function BusinessAssertions({
  scope,
  content,
  evidence,
  onOpen,
}: {
  scope: Scope | undefined;
  content: Content;
  evidence: readonly EvidenceGalleryItem[];
  onOpen: (item: EvidenceGalleryItem) => void;
}) {
  const records = content.observations ?? [];
  const assertions = scope?.assertions ?? [];
  const looseRecords = records.filter(
    (entry) => !entry.assertionIds?.length && !entry.stepOrdinals?.length,
  );
  if (!assertions.length && !looseRecords.length) return null;
  return (
    <section
      className="result-business-assertions"
      aria-label="业务断言与实际观察"
    >
      <h3>业务断言与实际观察</h3>
      {assertions.map((assertion, index) => {
        const judgment = content.assertionResults?.find(
          (entry) => entry.assertionId === assertion.id,
        );
        const observations = records.filter((entry) =>
          entry.assertionIds?.includes(assertion.id),
        );
        const refs = new Set(
          observations.flatMap((entry) => entry.evidenceRefs ?? []),
        );
        const gaps = (content.evidenceGaps ?? []).filter((entry) =>
          entry.assertionIds?.includes(assertion.id),
        );
        return (
          <article className="result-review-panel" key={assertion.id}>
            <div className="result-review-header">
              <span className="result-review-muted">断言 {index + 1}</span>
              {judgment ? (
                <ResultOutcomeTag outcome={judgment.outcome} />
              ) : (
                <Tag>未记录断言结论</Tag>
              )}
            </div>
            <div className="result-review-comparison">
              <div>
                <span className="result-review-muted">可核对预期</span>
                <p className="result-review-lines">{assertion.expected}</p>
              </div>
              <div
                className={
                  judgment?.outcome === 'failed'
                    ? 'result-review-actual-failed'
                    : undefined
                }
              >
                <span className="result-review-muted">实际观察</span>
                {observations.length ? (
                  observations.map((entry, ordinal) => (
                    <div key={ordinal} className="result-review-lines">
                      <p>{entry.actual}</p>
                      {!!entry.actionOrdinals?.length && (
                        <small className="caption">
                          实际操作 {entry.actionOrdinals.join('、')}
                        </small>
                      )}
                    </div>
                  ))
                ) : (
                  <p>{judgment?.reason || '该断言没有对应实际观察。'}</p>
                )}
              </div>
            </div>
            {judgment?.reason && observations.length > 0 && (
              <p className="result-review-lines caption">{judgment.reason}</p>
            )}
            <EvidenceGallery
              items={evidence.filter((item) =>
                refs.has(item.manifest.localEvidenceId),
              )}
              onOpen={onOpen}
              emptyText="该断言没有关联原件"
            />
            <EvidenceGapList gaps={gaps} />
          </article>
        );
      })}
      {looseRecords.map((entry, index) => (
        <article key={index} className="result-review-panel">
          <h4>其它现场观察</h4>
          <p className="result-review-lines">{entry.actual}</p>
          <EvidenceGallery
            items={evidence.filter((item) =>
              entry.evidenceRefs?.includes(item.manifest.localEvidenceId),
            )}
            onOpen={onOpen}
            emptyText="该观察没有关联原件"
          />
        </article>
      ))}
    </section>
  );
}

export function ResultUiSteps({
  content,
  scope,
  evidence,
  initialStep,
  onStepSelect,
  onOpen,
}: {
  content: Content;
  scope?: Scope | undefined;
  evidence: readonly EvidenceGalleryItem[];
  initialStep?: number | undefined;
  onStepSelect?: ((ordinal: number) => void) | undefined;
  onOpen: (item: EvidenceGalleryItem) => void;
}) {
  const steps = scope?.steps ?? [];
  const observations = content.stepObservations ?? [];
  const observedOnly = steps.length === 0 && observations.length > 0;
  const entries = steps.length
    ? steps.map((step, index) => ({ ordinal: index + 1, label: step.action }))
    : [...observations]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((step) => ({
          ordinal: step.ordinal,
          label: `实际步骤 ${step.ordinal}`,
        }));
  const originalStep =
    initialStep ??
    observations.find((step) => step.outcome === 'failed')?.ordinal ??
    entries[0]?.ordinal ??
    1;
  const [activeOrdinal, setActiveOrdinal] = useState(originalStep);
  const ordinal = onStepSelect ? (initialStep ?? activeOrdinal) : activeOrdinal;
  function setOrdinal(value: number) {
    setActiveOrdinal(value);
    onStepSelect?.(value);
  }
  const step = steps[ordinal - 1];
  const observation = observations.find((record) => record.ordinal === ordinal);
  const linked = (content.observations ?? []).filter((entry) =>
    entry.stepOrdinals?.includes(ordinal),
  );
  const observedStep = observedOnly && observation;
  const refs = new Set([
    ...(observation?.evidenceRefs ?? []),
    ...linked.flatMap((entry) => entry.evidenceRefs ?? []),
  ]);
  return (
    <div className="result-review-content">
      {scope && (scope.preconditions.length > 0 || scope.expected) && (
        <Collapse
          items={[
            {
              key: 'scope',
              label: '冻结用例的前置条件与整体预期',
              children: (
                <div className="result-review-content">
                  {scope.preconditions.length > 0 && (
                    <div>
                      <strong>前置条件</strong>
                      <ul>
                        {scope.preconditions.map((condition, index) => (
                          <li key={index}>{condition}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {scope.expected && (
                    <div>
                      <strong>整体预期</strong>
                      <p className="result-review-lines">{scope.expected}</p>
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
      {!!content.actualActions?.length && (
        <Card title="本轮实际操作" size="small">
          <ol className="result-review-lines">
            {content.actualActions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ol>
        </Card>
      )}
      <BusinessAssertions
        scope={scope}
        content={content}
        evidence={evidence}
        onOpen={onOpen}
      />
      {entries.length > 0 ? (
        <div className="result-review-layout">
          <aside className="result-review-panel" aria-label="执行步骤">
            <div className="result-review-header">
              <h3>{observedOnly ? '实录步骤' : '参考步骤'}</h3>
              <small className="result-review-muted">
                共 {entries.length} 步
              </small>
            </div>
            <ol className="result-review-ordered">
              {entries.map((entry) => {
                const number = entry.ordinal;
                const outcome = observations.find(
                  (record) => record.ordinal === number,
                )?.outcome;
                return (
                  <li key={number}>
                    <button
                      type="button"
                      className="result-review-step-button"
                      aria-current={ordinal === number ? 'step' : undefined}
                      onClick={() => setOrdinal(number)}
                    >
                      <span className="result-review-step-number">
                        {number}
                      </span>
                      <strong>{entry.label}</strong>
                      {outcome && <ResultOutcomeTag outcome={outcome} />}
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>
          <section
            className="result-review-panel result-review-content"
            aria-label="步骤观察"
          >
            {step || observedStep ? (
              <>
                <div className="result-review-header">
                  <div>
                    <small className="result-review-muted">
                      {observedOnly ? '归档观察' : '冻结步骤'} · 步骤 {ordinal}
                    </small>
                    <h3>{step?.action ?? `实际步骤 ${ordinal}`}</h3>
                  </div>
                  {observation?.outcome && (
                    <ResultOutcomeTag outcome={observation.outcome} />
                  )}
                </div>
                <div className="result-review-comparison">
                  {step && (
                    <div>
                      <span className="result-review-muted">预期结果</span>
                      <p className="result-review-lines">
                        {step.expected ?? '该步骤没有单独预期'}
                      </p>
                    </div>
                  )}
                  <div
                    className={
                      observation?.outcome === 'failed'
                        ? 'result-review-actual-failed'
                        : undefined
                    }
                  >
                    <span className="result-review-muted">实际观察</span>
                    {observation && (
                      <p className="result-review-lines">
                        {observation.actual}
                      </p>
                    )}
                    {linked.map((entry, index) => (
                      <p key={index} className="result-review-lines">
                        {entry.actual}
                      </p>
                    ))}
                    {!observation && !linked.length && (
                      <p>没有单独记录该步骤的实际观察</p>
                    )}
                  </div>
                </div>
                <h3>步骤证据</h3>
                <EvidenceGallery
                  items={evidence.filter((item) =>
                    refs.has(item.manifest.localEvidenceId),
                  )}
                  onOpen={onOpen}
                  emptyText="该步骤没有关联文件"
                />
                <EvidenceGapList
                  gaps={(content.evidenceGaps ?? []).filter(
                    (gap) => gap.ordinal === ordinal,
                  )}
                />
              </>
            ) : (
              <Alert
                type="warning"
                showIcon
                title={`原链接指向步骤 ${ordinal}，该步骤没有留档。`}
                description="可从侧栏浏览此结果留档的步骤。"
              />
            )}
          </section>
        </div>
      ) : (
        <Alert
          type="info"
          showIcon
          title="原版本未记录分步"
          description="此结果保留整体观察和原执行动作。"
        />
      )}
      <OverallObservation content={content} hideActions />
    </div>
  );
}

export function OverallObservation({
  content,
  hideActions = false,
}: {
  content: Content;
  hideActions?: boolean;
}) {
  return (
    <Card
      size="small"
      title={hideActions ? '用例级整体观察' : '整体观察与实际动作'}
    >
      <Typography.Paragraph className="message-prose">
        {content.actualObservations}
      </Typography.Paragraph>
      {content.reason && (
        <Typography.Paragraph className="message-prose">
          {content.reason}
        </Typography.Paragraph>
      )}
      {!hideActions && content.actualActions?.length ? (
        <ol>
          {content.actualActions.map((action, index) => (
            <li className="result-review-lines" key={index}>
              {action}
            </li>
          ))}
        </ol>
      ) : null}
      {content.basis?.length ? (
        <Collapse
          items={[
            {
              key: 'basis',
              label: '资料依据',
              children: (
                <pre className="message-code">
                  {JSON.stringify(content.basis, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      ) : null}
    </Card>
  );
}
