import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/base.js';
import { uiOutcomeSchema } from '../../../packages/contracts/src/domain.js';
import type { ActorContext } from '../../../packages/contracts/src/identity.js';
import { reportFactsSchema } from '../../../packages/contracts/src/ui-results.js';
import { DomainError } from '../../../packages/application/src/errors.js';
import type { ReportService } from '../../../packages/application/src/reports/service.js';
import type { ResultService } from '../../../packages/application/src/results/service.js';
import type { BusinessToolRegistry } from '../../../packages/application/src/tool-registry/registry.js';

const toolName = 'ath_reports';
export const reportToolDescription =
  '查询测试报告。get/get-revision 先返回报告修订、统计与少量用例索引。用本次返回的 report id 和 revisionId 调用 page-items、get-item 或 page-evidence 再读明细；page-revisions 可查历史修订。offset 使用上一页的 nextOffset。核对结论请引用返回的报告链接和用例。';
const target = { projectId: idSchema, id: idSchema };
const revisionTarget = { ...target, revisionId: idSchema };
const offsetSchema = z.number().int().min(0).max(1_000_000).default(0);
const pageSize = 6;

type Facts = z.infer<typeof reportFactsSchema>;
type Item = Facts['items'][number];

function page<T>(items: readonly T[], offset: number) {
  return {
    items: items.slice(offset, offset + pageSize),
    total: items.length,
    nextOffset: offset + pageSize < items.length ? offset + pageSize : null,
  };
}

function textPage(value: string | null, offset: number, size: number) {
  if (value === null) return null;
  let end = Math.min(offset + size, value.length);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1)))
    end--;
  return {
    text: value.slice(offset, end),
    nextOffset: end < value.length ? end : null,
  };
}

function revisionPage(
  history: Awaited<ReturnType<ReportService['detail']>>['report']['history'],
  offset: number,
) {
  const selected = page(history, offset);
  return {
    ...selected,
    items: selected.items.map(({ id, revisionNo, reason, createdAt }) => ({
      id,
      revisionNo,
      reason: textPage(reason, 0, 160)?.text,
      createdAt,
    })),
  };
}

function reportLink(
  projectId: string,
  id: string,
  revisionId: string,
  resultId?: string,
) {
  return `/#reports?${new URLSearchParams({ projectId, reportId: id, revisionId, ...(resultId ? { resultId } : {}) })}`;
}

function indexItem({ scopeItem, result }: Item) {
  return {
    runItemId: scopeItem.runItemId,
    caseId: scopeItem.caseId,
    title: scopeItem.content.title,
    scenario: scopeItem.scenario.title,
    requirementVersionId: scopeItem.requirementVersionId,
    resultId: result?.id ?? null,
    initialOutcome: result?.initialOutcome ?? null,
    reportedOutcome: result?.reportedOutcome ?? 'notReported',
    finalOutcome: result?.finalOutcome ?? null,
    effectiveOutcome: result?.effectiveOutcome ?? 'notReported',
  };
}

function summary(facts: Facts, id: string, revisionId: string) {
  const uncategorized = facts.items.slice(0, pageSize);
  const attention = facts.items
    .filter(({ result }) =>
      ['failed', 'blocked', 'inconclusive'].includes(
        result?.reportedOutcome ?? '',
      ),
    )
    .slice(0, pageSize);
  return {
    id,
    revisionId,
    reportLink: reportLink(facts.projectId, id, revisionId),
    runId: facts.runId,
    kind: facts.kind,
    sourceType: facts.scope.sourceType,
    sourceRevisionId: facts.scope.sourceRevisionId,
    title: facts.scope.sourceType === 'uiArchive' ? facts.scope.title : null,
    productBuild: facts.scope.productBuild,
    executionState: facts.executionState,
    deliveryStatus: facts.deliveryStatus,
    capturedAt: facts.capturedAt,
    statistics: facts.statistics,
    evidenceCount: facts.evidence.length,
    missingEvidenceCount: facts.missingFileIds.length,
    itemPreview: (attention.length ? attention : uncategorized).map(indexItem),
  };
}

const itemDetail = z.discriminatedUnion('section', [
  z.strictObject({ section: z.literal('overview') }),
  z.strictObject({ section: z.literal('steps'), offset: offsetSchema }),
  z.strictObject({
    section: z.literal('text'),
    field: z.enum(['actual', 'expected', 'testPoint', 'reason']),
    offset: offsetSchema,
  }),
  z.strictObject({
    section: z.literal('step-text'),
    ordinal: z.number().int().min(1).max(1000),
    field: z.enum(['action', 'expected', 'actual']),
    offset: offsetSchema,
  }),
]);

function readItem(item: Item, detail: z.infer<typeof itemDetail>) {
  const { scopeItem, result } = item;
  const { content } = scopeItem;
  const expected = 'expected' in content ? content.expected : null;
  const testPoint = 'testPoint' in content ? content.testPoint : null;
  const steps =
    content.kind === 'UI' && 'steps' in content ? content.steps : [];
  const observations = result?.content.stepObservations ?? [];
  const actions = result?.content.actualActions ?? [];
  const totalSteps = Math.max(
    steps?.length ?? 0,
    actions.length,
    ...observations.map(({ ordinal }) => ordinal),
  );
  switch (detail.section) {
    case 'overview':
      return {
        resultRevisionId: result?.revisionId ?? null,
        expected: textPage(expected, 0, 800),
        actual: textPage(result?.content.actualObservations ?? null, 0, 1600),
        reason: textPage(result?.content.reason ?? null, 0, 600),
        sideEffectCertainty: result?.content.sideEffectCertainty ?? null,
        evidenceReferenceCount: result?.content.evidenceRefs.length ?? 0,
        evidenceGapCount: result?.content.evidenceGaps?.length ?? 0,
        totalSteps,
      };
    case 'text': {
      const fields = {
        expected,
        testPoint,
        actual: result?.content.actualObservations ?? null,
        reason: result?.content.reason ?? null,
      };
      return textPage(fields[detail.field], detail.offset, 3000);
    }
    case 'steps': {
      const ordinals = Array.from({ length: totalSteps }, (_, i) => i + 1);
      const selected = page(ordinals, detail.offset);
      return {
        ...selected,
        items: selected.items.map((ordinal) => {
          const step = steps?.[ordinal - 1];
          const observed = observations.find((row) => row.ordinal === ordinal);
          return {
            ordinal,
            action: textPage(
              step?.action ?? actions[ordinal - 1] ?? null,
              0,
              300,
            ),
            expected: textPage(step?.expected ?? null, 0, 300),
            actual: textPage(observed?.actual ?? null, 0, 400),
            outcome: observed?.outcome ?? null,
            evidenceReferenceCount: observed?.evidenceRefs.length ?? 0,
          };
        }),
      };
    }
    case 'step-text': {
      const step = steps?.[detail.ordinal - 1];
      const fields = {
        action: step?.action ?? actions[detail.ordinal - 1] ?? null,
        expected: step?.expected ?? null,
        actual:
          observations.find((row) => row.ordinal === detail.ordinal)?.actual ??
          null,
      };
      return textPage(fields[detail.field], detail.offset, 3000);
    }
  }
}

function requireReportItem(facts: Facts, runItemId: string): Item {
  const item = facts.items.find((row) => row.scopeItem.runItemId === runItemId);
  if (!item)
    throw new DomainError('NOT_FOUND', '此报告修订没有该执行项。', 404);
  return item;
}

/** This registry belongs to the AI worker. Web and official MCP keep full reports. */
export function registerModelReportReads(
  registry: BusinessToolRegistry,
  reports: ReportService,
  results: ResultService,
) {
  const entry = registry.tools.get(toolName);
  if (!entry) throw new Error('Report reads require the business registry');
  entry.description = reportToolDescription;
  for (const op of ['get', 'get-revision']) entry.operations.delete(op);

  const add = <S extends z.ZodType>(
    op: string,
    schema: S,
    execute: (actor: ActorContext, input: z.infer<S>) => Promise<unknown>,
  ) =>
    registry.add(
      toolName,
      reportToolDescription,
      op,
      schema,
      'read',
      execute,
      undefined,
      true,
    );

  add(
    'get',
    z.strictObject({ op: z.literal('get'), ...target }),
    async (actor, input) => {
      const { report } = await reports.detail(actor, input.projectId, input.id);
      return {
        report: summary(
          reportFactsSchema.parse(report.facts),
          report.id,
          report.revisionId,
        ),
        history: revisionPage(report.history, 0),
        currentHandlingStatistics: report.currentHandling.statistics,
      };
    },
  );
  add(
    'page-revisions',
    z.strictObject({
      op: z.literal('page-revisions'),
      ...target,
      offset: offsetSchema,
    }),
    async (actor, input) => {
      const { report } = await reports.detail(actor, input.projectId, input.id);
      return {
        reportId: report.id,
        ...revisionPage(report.history, input.offset),
      };
    },
  );
  add(
    'get-revision',
    z.strictObject({ op: z.literal('get-revision'), ...revisionTarget }),
    async (actor, input) => {
      const revision = await reports.revision(
        actor,
        input.projectId,
        input.id,
        input.revisionId,
      );
      return {
        report: summary(
          reportFactsSchema.parse(revision.facts),
          input.id,
          revision.revisionId,
        ),
        revisionNo: revision.revisionNo,
        handlingAtCaptureStatistics:
          revision.handlingAtCapture?.statistics ?? null,
        currentHandlingStatistics: revision.currentHandling.statistics,
      };
    },
  );
  add(
    'page-items',
    z.strictObject({
      op: z.literal('page-items'),
      ...revisionTarget,
      offset: offsetSchema,
      outcome: z.union([uiOutcomeSchema, z.literal('notReported')]).optional(),
      search: z.string().trim().min(1).max(200).optional(),
    }),
    async (actor, input) => {
      const revision = await reports.revision(
        actor,
        input.projectId,
        input.id,
        input.revisionId,
      );
      const query = input.search?.toLocaleLowerCase();
      const items = reportFactsSchema
        .parse(revision.facts)
        .items.filter(
          ({ scopeItem, result }) =>
            (!input.outcome ||
              (result?.reportedOutcome ?? 'notReported') === input.outcome) &&
            (!query ||
              [
                scopeItem.content.title,
                scopeItem.scenario.title,
                result?.content.actualObservations,
              ].some((value) => value?.toLocaleLowerCase().includes(query))),
        );
      const selected = page(items, input.offset);
      return {
        reportId: input.id,
        revisionId: input.revisionId,
        ...selected,
        items: selected.items.map(indexItem),
      };
    },
  );
  add(
    'get-item',
    z.strictObject({
      op: z.literal('get-item'),
      ...revisionTarget,
      runItemId: idSchema,
      detail: itemDetail.default({ section: 'overview' }),
    }),
    async (actor, input) => {
      const revision = await reports.revision(
        actor,
        input.projectId,
        input.id,
        input.revisionId,
      );
      const item = requireReportItem(
        reportFactsSchema.parse(revision.facts),
        input.runItemId,
      );
      return {
        reportId: input.id,
        revisionId: input.revisionId,
        reportLink: reportLink(
          input.projectId,
          input.id,
          input.revisionId,
          item.result?.id,
        ),
        item: indexItem(item),
        section: input.detail.section,
        detail: readItem(item, input.detail),
      };
    },
  );
  add(
    'page-evidence',
    z.strictObject({
      op: z.literal('page-evidence'),
      ...revisionTarget,
      runItemId: idSchema.optional(),
      offset: offsetSchema,
    }),
    async (actor, input) => {
      const revision = await reports.revision(
        actor,
        input.projectId,
        input.id,
        input.revisionId,
      );
      const facts = reportFactsSchema.parse(revision.facts);
      const item = input.runItemId
        ? requireReportItem(facts, input.runItemId)
        : null;
      const refs = new Set(item?.result?.content.evidenceRefs);
      const linkedIds = new Set(
        item?.result
          ? (
              await results.detail(actor, input.projectId, item.result.id)
            ).result.evidence.map((file) => file.id)
          : [],
      );
      const selected = page(
        item
          ? facts.evidence.filter(
              (file) =>
                refs.has(file.localEvidenceId) || linkedIds.has(file.id),
            )
          : facts.evidence,
        input.offset,
      );
      return {
        reportId: input.id,
        revisionId: input.revisionId,
        association: item
          ? 'result-evidence-in-report-revision'
          : 'report-wide',
        reportLink: reportLink(
          input.projectId,
          input.id,
          input.revisionId,
          item?.result?.id,
        ),
        ...selected,
        items: selected.items.map((file) => ({
          fileId: file.fileId,
          name: file.originalName,
          type: file.manifest.type,
          completeness: file.manifest.captureCompleteness,
          source: file.manifest.source,
          statusAtCapture: file.lastKnownFileStatus,
          downloadPath: file.downloadPath,
        })),
      };
    },
  );
}
