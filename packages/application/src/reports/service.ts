import { randomUUID } from 'node:crypto';
import {
  resultItemSchema,
  evidenceManifestItemSchema,
} from '../../../contracts/src/domain.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type {
  Database,
  SqlExecutor,
} from '../../../persistence/src/database.js';
import { requireProject } from '../access/policy.js';
import { DomainError } from '../errors.js';
import { readRun } from '../ui-executions/service.js';
import { recordRetestVerifications } from '../retests/verifications.js';
import { reportFactsSchema } from '../../../contracts/src/ui-results.js';
import { reportExecutionScopeSchema } from '../../../contracts/src/ui-archives.js';
import { audit } from '../events.js';
import { executionRecords } from './records.js';
import { reportHandling } from './handling.js';
import { reportHandlingSchema } from '../../../contracts/src/report-handling.js';
import {
  uiDeliveryGate,
  deliveryMissingFiles,
  linkUiDeliverySourcesToReport,
  projectUiDelivery,
} from '../results/delivery-state.js';

interface ResultFactRow {
  id: string;
  run_item_id: string;
  current_revision_id: string;
  content: unknown;
  initial_content: unknown;
  revision_no: number;
  cleanup_state: string;
  assessment_id: string | null;
  assessment_basis_revision_id: string | null;
  final_outcome: string | null;
  assessment_reason: string | null;
}
const emptyCounts = () => ({
  passed: 0,
  failed: 0,
  blocked: 0,
  inconclusive: 0,
  notExecuted: 0,
  notReported: 0,
});

export async function reportFacts(
  tx: SqlExecutor,
  projectId: string,
  runId: string,
) {
  const run = await readRun(tx, projectId, runId, 'share');
  const scope = reportExecutionScopeSchema.parse(run.scope_snapshot);
  const environment = (
    await tx.query<{ name: string | null }>(
      `SELECT content->>'name' name FROM app.test_configuration_revisions
       WHERE id=$1 AND configuration_id=$2 AND project_id=$3 AND kind='environment'`,
      [scope.environmentRevisionId, scope.environmentId, projectId],
    )
  ).rows[0];
  const rows = await tx.query<ResultFactRow>(
    `SELECT r.id,r.run_item_id,r.current_revision_id,v.content,v.revision_no,i.content initial_content,
     a.id assessment_id,a.result_revision_id assessment_basis_revision_id,a.final_outcome,a.reason assessment_reason,ri.cleanup_state FROM app.results r
     JOIN app.run_items ri ON ri.id=r.run_item_id
     JOIN app.result_revisions v ON v.id=r.current_revision_id JOIN app.result_revisions i ON i.result_id=r.id AND i.revision_no=1
     LEFT JOIN app.result_assessments a ON a.id=r.current_assessment_revision_id WHERE r.project_id=$1 AND r.run_id=$2`,
    [projectId, runId],
  );
  const evidenceRows = await tx.query<{
    id: string;
    local_evidence_id: string;
    file_id: string;
    manifest: unknown;
    status: string;
    deleted_at: Date | null;
    original_name: string;
  }>(
    `SELECT e.id,e.local_evidence_id,e.file_id,e.manifest,f.status,f.deleted_at,f.original_name FROM app.run_evidence e
     JOIN app.file_resources f ON f.id=e.file_id WHERE e.run_id=$1 ORDER BY e.created_at,e.id`,
    [runId],
  );

  const stepEvidence = new Map<
    string,
    Array<{ evidenceId: string; stepOrdinal: number }>
  >();
  const scoped = await tx.query<{
    result_id: string;
    evidence_id: string;
    step_ordinal: number;
  }>(
    `SELECT e.result_id,e.evidence_id,e.step_ordinal FROM app.result_step_evidence_links e
     JOIN app.results r ON r.id=e.result_id AND r.current_revision_id=e.result_revision_id
     WHERE r.project_id=$1 AND r.run_id=$2 ORDER BY e.result_id,e.step_ordinal,e.evidence_id`,
    [projectId, runId],
  );
  for (const link of scoped.rows) {
    const entries = stepEvidence.get(link.result_id) ?? [];
    entries.push({
      evidenceId: link.evidence_id,
      stepOrdinal: link.step_ordinal,
    });
    stepEvidence.set(link.result_id, entries);
  }
  const byItem = new Map(rows.rows.map((row) => [row.run_item_id, row]));
  const original = emptyCounts();
  const reported = emptyCounts();
  const final = { ...emptyCounts(), notAssessed: 0 };
  const effective = emptyCounts();
  const items = scope.items.map((scopeItem) => {
    const row = byItem.get(scopeItem.runItemId);
    if (!row) {
      original.notReported++;
      reported.notReported++;
      final.notReported++;
      effective.notReported++;
      return { scopeItem, result: null };
    }
    const initial = resultItemSchema.parse(row.initial_content);
    const content = resultItemSchema.parse(row.content);
    const finalOutcome = row.final_outcome
      ? resultItemSchema.shape.originalOutcome.parse(row.final_outcome)
      : null;
    const effectiveOutcome = finalOutcome ?? content.originalOutcome;
    original[initial.originalOutcome]++;
    reported[content.originalOutcome]++;
    effective[effectiveOutcome]++;
    if (finalOutcome) final[finalOutcome]++;
    else final.notAssessed++;
    return {
      scopeItem,
      result: {
        id: row.id,
        revisionId: row.current_revision_id,
        revisionNo: row.revision_no,
        initialOutcome: initial.originalOutcome,
        reportedOutcome: content.originalOutcome,
        finalOutcome,
        effectiveOutcome,
        cleanupState: row.cleanup_state,
        content,
        ...(stepEvidence.has(row.id)
          ? { manualStepEvidence: stepEvidence.get(row.id)! }
          : {}),
        assessmentRevisionId: row.assessment_id,
        assessmentReason: row.assessment_reason,
        assessmentBasisRevisionId: row.assessment_basis_revision_id,
        assessmentBasisChanged:
          row.assessment_basis_revision_id !== null &&
          row.assessment_basis_revision_id !== row.current_revision_id,
        manuallyAssessed: row.assessment_id !== null,
      },
    };
  });
  const missingFileIds =
    run.kind === 'UI'
      ? await deliveryMissingFiles(tx, runId)
      : [
          ...new Set(
            evidenceRows.rows
              .filter(
                (row) => row.status !== 'verified' || row.deleted_at !== null,
              )
              .map((row) => row.file_id),
          ),
        ].sort();
  const gate = run.kind === 'UI' ? await uiDeliveryGate(tx, runId) : undefined;
  const deliveryStatus =
    projectUiDelivery(
      gate,
      rows.rows.length,
      scope.items.length,
      missingFileIds.length,
    ) ??
    (rows.rows.length === scope.items.length && missingFileIds.length === 0
      ? ('complete' as const)
      : ('incomplete' as const));
  return {
    runId,
    projectId,
    ...(environment?.name ? { environmentName: environment.name } : {}),
    kind: run.kind,
    executionState: run.state,
    cleanupState: run.cleanup_state,
    executionProvenance: run.execution_provenance,
    scope,
    items,
    statistics: {
      denominator: scope.items.length,
      reportedItems: rows.rows.length,
      original,
      reported,
      final,
      effective,
    },
    evidence: evidenceRows.rows.map((row) => ({
      id: row.id,
      localEvidenceId: row.local_evidence_id,
      fileId: row.file_id,
      manifest: evidenceManifestItemSchema.parse(row.manifest),
      lastKnownFileStatus: row.status,
      fileAvailable: row.status === 'verified' && row.deleted_at === null,
      originalName: row.original_name,
      downloadPath: `/api/v1/files/${row.file_id}/content`,
    })),
    missingFileIds,
    deliveryStatus,
    capturedAt: new Date().toISOString(),
  };
}

export async function persistReportRevision(
  tx: SqlExecutor,
  actor: ActorContext,
  projectId: string,
  runId: string,
  reason: string,
) {
  await readRun(tx, projectId, runId, true);
  const facts = await reportFacts(tx, projectId, runId);
  await recordRetestVerifications(tx, projectId, runId);
  // Progress or file transfer alone never generates a report.
  if (facts.statistics.reportedItems === 0)
    return { reportId: null, reportUrl: null, facts, handlingAtCapture: null };
  let report = (
    await tx.query<{ id: string }>(
      'SELECT id FROM app.reports WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
      [projectId, runId],
    )
  ).rows[0];
  if (!report && facts.kind === 'UI') {
    const gate = await uiDeliveryGate(tx, runId);
    if (gate.versioned && !gate.currentEnded)
      return {
        reportId: null,
        reportUrl: null,
        facts,
        handlingAtCapture: null,
      };
  }
  const handlingAtCapture = await reportHandling(tx, projectId, runId);
  const revisionId = randomUUID();
  if (!report) {
    report = { id: randomUUID() };
    await tx.query(
      'INSERT INTO app.reports(id,project_id,run_id,current_revision_id) VALUES($1,$2,$3,$4)',
      [report.id, projectId, runId, revisionId],
    );
    await audit(tx, actor, 'report.ready', report.id, projectId, { runId });
  }
  if (facts.kind === 'UI')
    await linkUiDeliverySourcesToReport(
      tx,
      actor.userId,
      projectId,
      runId,
      report.id,
    );
  const prior = (
    await tx.query<{ revision_no: number }>(
      'SELECT COALESCE(max(revision_no),0)::integer revision_no FROM app.report_revisions WHERE report_id=$1',
      [report.id],
    )
  ).rows[0];
  await tx.query(
    'INSERT INTO app.report_revisions(id,report_id,revision_no,reason,facts,actor_id,handling_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      revisionId,
      report.id,
      (prior?.revision_no ?? 0) + 1,
      reason,
      JSON.stringify(facts),
      actor.userId,
      JSON.stringify(handlingAtCapture),
    ],
  );
  await tx.query('UPDATE app.reports SET current_revision_id=$2 WHERE id=$1', [
    report.id,
    revisionId,
  ]);
  await tx.query('UPDATE app.runs SET delivery_status=$2 WHERE id=$1', [
    runId,
    facts.deliveryStatus,
  ]);
  return {
    reportId: report.id,
    reportUrl: `/api/v1/projects/${projectId}/reports/${report.id}`,
    facts,
    handlingAtCapture,
  };
}

export class ReportService {
  constructor(readonly db: Database) {}
  async records(actor: ActorContext, projectId: string, raw: unknown = {}) {
    return executionRecords(this.db, actor, projectId, raw);
  }
  async list(actor: ActorContext, projectId: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const rows = await tx.query<{
        id: string;
        run_id: string;
        current_revision_id: string;
        created_at: Date;
        kind: string;
        state: string;
      }>(
        `SELECT r.id,r.run_id,r.current_revision_id,r.created_at,u.kind,u.state FROM app.reports r JOIN app.runs u ON u.id=r.run_id
         WHERE r.project_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 200`,
        [projectId],
      );
      return {
        reports: rows.rows.map((row) => ({
          id: row.id,
          runId: row.run_id,
          revisionId: row.current_revision_id,
          createdAt: row.created_at.toISOString(),
          kind: row.kind,
          executionState: row.state,
        })),
      };
    });
  }
  async detail(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      const member = await requireProject(tx, actor, projectId, 'project.read');
      const report = (
        await tx.query<{
          run_id: string;
        }>('SELECT run_id FROM app.reports WHERE project_id=$1 AND id=$2', [
          projectId,
          id,
        ])
      ).rows[0];
      if (!report)
        throw new DomainError('NOT_FOUND', '此项目内没有该报告。', 404);
      await readRun(tx, projectId, report.run_id, 'share');
      const current = (
        await tx.query<{ current_revision_id: string }>(
          'SELECT current_revision_id FROM app.reports WHERE project_id=$1 AND id=$2',
          [projectId, id],
        )
      ).rows[0];
      if (!current)
        throw new DomainError('NOT_FOUND', '此项目内没有该报告。', 404);
      const history = await tx.query<{
        id: string;
        revision_no: number;
        reason: string;
        created_at: Date;
        actor_id: string;
      }>(
        'SELECT id,revision_no,reason,created_at,actor_id FROM app.report_revisions WHERE report_id=$1 ORDER BY revision_no DESC',
        [id],
      );
      // Current delivery is derived independently; later file completion never changes recorded verdicts.
      return {
        report: {
          id,
          revisionId: current.current_revision_id,
          facts: await reportFacts(tx, projectId, report.run_id),
          currentHandling: await reportHandling(tx, projectId, report.run_id),
          ...(actor.entrypoint === 'web'
            ? { canReview: member.roles.includes('tester') }
            : {}),
          history: history.rows.map((row) => ({
            id: row.id,
            revisionNo: row.revision_no,
            reason: row.reason,
            createdAt: row.created_at.toISOString(),
            actorId: row.actor_id,
          })),
        },
      };
    });
  }
  async revision(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = (
        await tx.query<{
          facts: unknown;
          revision_no: number;
          reason: string;
          run_id: string;
          handling_snapshot: unknown | null;
        }>(
          `SELECT v.facts,v.revision_no,v.reason,r.run_id,v.handling_snapshot FROM app.report_revisions v JOIN app.reports r ON r.id=v.report_id
         WHERE r.project_id=$1 AND r.id=$2 AND v.id=$3`,
          [projectId, id, revisionId],
        )
      ).rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '没有此报告修订。', 404);
      return {
        revisionId,
        revisionNo: row.revision_no,
        reason: row.reason,
        facts: row.facts,
        handlingAtCapture:
          row.handling_snapshot === null
            ? null
            : reportHandlingSchema.parse(row.handling_snapshot),
        currentHandling: await reportHandling(tx, projectId, row.run_id),
      };
    });
  }
  async captureExport(actor: ActorContext, projectId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const row = (
        await tx.query<{ run_id: string }>(
          'SELECT run_id FROM app.reports WHERE project_id=$1 AND id=$2',
          [projectId, id],
        )
      ).rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '此项目内没有该报告。', 404);
      const captured = await persistReportRevision(
        tx,
        actor,
        projectId,
        row.run_id,
        'authorized-export-snapshot',
      );
      const current = (
        await tx.query<{ current_revision_id: string }>(
          'SELECT current_revision_id FROM app.reports WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!current) throw new Error('Report export revision missing');
      return {
        revisionId: current.current_revision_id,
        facts: captured.facts,
        handlingAtCapture: captured.handlingAtCapture,
      };
    });
  }
  async exportHtml(
    actor: ActorContext,
    projectId: string,
    id: string,
    revisionId?: string,
  ): Promise<string> {
    const report = revisionId
      ? await this.db.transaction(async (tx) => {
          await requireProject(tx, actor, projectId, 'project.read');
          const revision = (
            await tx.query<{
              facts: unknown;
              handling_snapshot: unknown | null;
            }>(
              `SELECT v.facts,v.handling_snapshot FROM app.report_revisions v JOIN app.reports r ON r.id=v.report_id
        WHERE r.project_id=$1 AND r.id=$2 AND v.id=$3`,
              [projectId, id, revisionId],
            )
          ).rows[0];
          if (!revision)
            throw new DomainError(
              'NOT_FOUND',
              '此报告没有该固定导出修订。',
              404,
            );
          return {
            revisionId,
            facts: reportFactsSchema.parse(revision.facts),
            handlingAtCapture:
              revision.handling_snapshot === null
                ? null
                : reportHandlingSchema.parse(revision.handling_snapshot),
          };
        })
      : await this.captureExport(actor, projectId, id);
    const escape = (value: unknown) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c] ?? c,
      );
    const facts = report.facts;
    const scope = facts.scope;
    // Resolve only the immutable revision identified by the saved report scope.
    // Current configuration names must never fill a historical export.
    const environmentName = await this.db.transaction(async (tx) => {
      await requireProject(tx, actor, projectId, 'project.read');
      const revision = (
        await tx.query<{ name: string | null }>(
          `SELECT content->>'name' name FROM app.test_configuration_revisions
           WHERE id=$1 AND configuration_id=$2 AND project_id=$3 AND kind='environment'`,
          [scope.environmentRevisionId, scope.environmentId, projectId],
        )
      ).rows[0];
      return revision?.name ?? '未记录';
    });
    const contextHtml = `<h2>冻结的执行上下文</h2><dl><dt>运行</dt><dd>${escape(scope.runId)}</dd><dt>环境</dt><dd>${escape(environmentName)} · ${escape(scope.environmentId)}</dd><dt>环境修订</dt><dd>${escape(scope.environmentRevisionId)}</dd><dt>构建标识</dt><dd>${escape(scope.productBuild?.trim() ? scope.productBuild : '未登记')}</dd><dt>范围来源</dt><dd>${escape(scope.sourceType)} · ${escape(scope.sourceRevisionId)}</dd><dt>范围摘要</dt><dd>${escape(scope.snapshotDigest)}</dd></dl>`;
    const handling = report.handlingAtCapture;
    const handlingHtml = handling
      ? `<h2>导出时的人工处理</h2><p>截取时间 ${escape(handling.capturedAt)}；问题 ${handling.statistics.problemCount} 项（待确认 ${handling.statistics.pendingProblemCount}），关联缺陷记录 ${handling.statistics.issueCount} 条（未关闭 ${handling.statistics.openIssueCount}、已合并 ${handling.statistics.mergedIssueCount}）。这些数量不等同失败用例数或根因数。</p><ul>${handling.problems.map((p) => `<li>问题：${escape(p.title)} · ${escape(p.state)}</li>`).join('')}${handling.issues.map((i) => `<li>${escape(i.number)}：${escape(i.title)} · ${escape(i.state)} · ${escape(i.assignee?.displayName ?? '待认领')}${i.mergedIntoId ? ' · 已合并' : ''}${i.latestVerification ? ` · 最近复测 ${escape(i.latestVerification.method)}/${escape(i.latestVerification.outcome)}` : ''}</li>`).join('')}</ul>`
      : '<h2>人工处理</h2><p>此历史修订未记录处理快照，不能用当前状态回填旧存档。登录平台可查看最新处理。</p>';
    const provenance =
      scope.sourceType === 'uiArchive'
        ? `独立归档 · ${facts.executionProvenance}`
        : facts.kind === 'API'
          ? '平台受控接口执行'
          : `${facts.executionProvenance}（客户端声明；合成协议验证不等于真实UI执行）`;
    const rows = facts.items
      .map(
        ({ scopeItem, result }) =>
          `<tr><td>${escape(scopeItem.scenario?.title ?? '独立单接口用例')}</td><td>${escape(scopeItem.content.title)}${'dataRow' in scopeItem && scopeItem.dataRow ? `<br>数据行：${escape(scopeItem.dataRow.name)} · ${escape(scopeItem.dataRow.id)}` : ''}<br>需求版本：${escape(scopeItem.requirementVersionId ?? '未关联需求')}<br>批准快照：${escape(scopeItem.approvalSnapshotId)}</td><td>${escape(result?.initialOutcome ?? 'notReported')}</td><td>${escape(result?.reportedOutcome ?? 'notReported')}</td><td>${escape(result ? (result.finalOutcome ?? '尚无人工最终结论') : 'notReported')}</td><td><pre>${escape(result?.content.actualObservations)}</pre></td></tr>`,
      )
      .join('');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AITestHub 执行报告</title><style>body{font:15px system-ui;margin:32px;color:#172b27;background:#fff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #b9c9c4;padding:9px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}h1{color:#14756b}</style><h1>AITestHub 执行报告</h1><p>报告 ${escape(id)} · 导出修订 ${escape(report.revisionId)} · 生成时间 ${escape(facts.capturedAt)}</p><p>来源 ${escape(provenance)} · 执行 ${escape(facts.executionState)} · 声明数据交付 ${escape(facts.deliveryStatus)}</p><p>固定范围 ${facts.statistics.denominator}，已报告 ${facts.statistics.reportedItems}，未报告 ${facts.statistics.reported.notReported}，待传文件 ${facts.missingFileIds.length}。人工结论不覆盖原始判断，不自动改变缺陷状态。</p>${contextHtml}<table><thead><tr><th>场景</th><th>用例</th><th>初始判断</th><th>当前上报判断</th><th>人工最终结论</th><th>实际观察</th></tr></thead><tbody>${rows}</tbody></table>${handlingHtml}<h2>文件清单</h2><ul>${facts.evidence.map((file) => `<li>${escape(file.originalName)} · ${escape(file.lastKnownFileStatus)} · ${escape(file.manifest.captureCompleteness)} · ${escape(file.fileId)}</li>`).join('')}</ul><p>此导出包含文本事实和文件标识，证据原件仍经平台当前授权下载；没有匿名分享。</p></html>`;
  }
}
