import { z } from 'zod';
import {
  actionIntentPresentationSchema,
  type ActionIntent,
} from '../../../contracts/src/action-intents.js';

type Presentation = z.infer<typeof actionIntentPresentationSchema>;
type ResultView = NonNullable<ActionIntent['resultPresentation']>;
const dictionary: Record<string, string> = {
  approved: '已批准',
  closed: '已关闭',
  resolved: '已解决',
  pending: '待处理',
  passing: '通过',
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
  inconclusive: '待核实',
  fixed: '已修复',
  skipped: '未执行',
  conflict: '版本冲突',
  notReported: '未上报',
  notExecuted: '未执行',
  created: '已创建',
  updated: '已更新',
  revised: '已修订',
  removed: '已移除',
  accepted: '已受理',
  completed: '已完成',
  declined: '已取消',
  dismissed: '已排除',
  unchanged: '无改动',
  retained: '保留原内容',
  alreadyApproved: '早已批准',
  waiting: '待复测',
  reproduced: '已复现',
  notReproduced: '未复现',
  needsOptimization: '待优化',
  tester: '测试人员',
  developer: '开发人员',
  product: '产品人员',
  saveDraft: '保存草稿',
  finalize: '提交定稿',
  resolve: '确认解决',
  return: '退回处理',
  inProgress: '进行中',
  archived: '已归档',
  paused: '已暂停',
  active: '启用',
  disabled: '停用',
};
const actionTitles: Record<string, string> = {
  'ath_reviews.approve': '批准用例',
  'ath_assets.import-ui': '导入 UI 用例',
  'ath_assets.remove-scoped-scene': '移除 UI 场景',
  'ath_results.add-evidence': '补充测试证据',
  'ath_results.assess': '保存人工判定',
  'ath_results.record-human-retest': '登记人工复测',
  'ath_issues.file-from-report': '从报告登记缺陷',
  'ath_issue_lifecycle.close': '关闭缺陷',
  'ath_platform_admin.create-project': '创建项目',
  'ath_platform_admin.update-user': '调整账号状态',
  'ath_platform_admin.remove-user': '停用并移除账号',
  'ath_platform_admin.update-model': '修改模型服务配置',
  'ath_platform_admin.update-auxiliary': '修改辅助模型配置',
  'ath_platform_admin.update-external': '修改外部服务配置',
  'ath_test_configuration.disable': '停用测试配置',
  'ath_database_connections.disable': '停用数据库连接',
  'ath_requirement_state.delete-if-no-history': '删除需求',
  'ath_problems.dismiss': '排除候选问题',
  'ath_problems.confirm': '确认为缺陷',
  'ath_personal_workspace.delete': '删除本人资料',
};
const knownErrors: Record<string, string> = {
  STALE_BASE_REVISION: '资料已经修改，请重新核对当前内容。',
  FORBIDDEN: '当前账号没有执行权限。',
  PRECONDITIONS_MISSING: '当前对象尚未满足操作条件。',
  NOT_FOUND: '当前对象已经不可访问。',
  BUSINESS_CONFLICT: '实际状态与所选范围不一致。',
  NOT_ELIGIBLE: '当前对象未满足操作条件。',
  PRECONDITIONS_CHANGED: '操作条件已改变，请重新核对范围。',
};
function object(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).safeParse(value).data ?? {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function labels(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\s+/gu, ' ');
  if (
    !clean ||
    /^[\[{]/u.test(clean) ||
    /^[a-f\d-]{32,64}$/iu.test(clean) ||
    /\bath_(?:key|session|reset)_[a-z0-9_-]{12,}/iu.test(clean)
  )
    return null;
  return (dictionary[clean] ?? clean).slice(0, limit);
}
export function actionDisplayValue(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => labels(item, 160))
      .filter((item) => item !== null);
    return items.length ? items.join('、').slice(0, 2000) : null;
  }
  return labels(value, 2000);
}
function name(data: Record<string, unknown>): string | null {
  return labels(data.title ?? data.displayName ?? data.name, 250);
}
function selectedTargets(
  tool: string,
  op: string,
  scope: Record<string, unknown>,
) {
  if (
    (tool === 'ath_reviews' && op === 'approve') ||
    (tool === 'ath_issue_lifecycle' && op === 'close')
  ) {
    const selected = Array.isArray(scope.selectedIds)
      ? new Set(scope.selectedIds)
      : null;
    const items =
      tool === 'ath_reviews' ? scope.items : object(scope.preview).items;
    return rows(items).filter((item) => !selected || selected.has(item.id));
  }
  if (tool === 'ath_assets' && op === 'import-ui') {
    const packages = rows(object(scope.preview).packages);
    return rows(scope.selection).map((selection) => {
      const pkg = packages.find(
        (item) => item.packageIndex === selection.packageIndex,
      );
      const children = rows(pkg?.scenes).flatMap((item) => rows(item.cases));
      return (
        children.find((item) => item.caseLocalId === selection.caseLocalId) ??
        {}
      );
    });
  }
  return rows(scope.items).slice(0, 10000);
}
function readableReason(row: Record<string, unknown>) {
  const detailed =
    row.message ??
    row.reason ??
    (Array.isArray(row.reasons) ? row.reasons[0] : null);
  const supplied = labels(object(detailed).message ?? detailed, 1000);
  return (
    supplied ??
    (typeof row.code === 'string' ? (knownErrors[row.code] ?? null) : null)
  );
}
export function actionIntentDisplay(data: {
  tool: string;
  op: string;
  input: unknown;
  proposal: unknown;
  state: ActionIntent['status'];
  response: unknown;
  presentation: unknown;
}): Presentation & { targets: string[]; resultPresentation?: ResultView } {
  const stored = actionIntentPresentationSchema.safeParse(data.presentation)
    .data ?? {
    title: '操作确认',
    summary: '',
    projectName: null,
    changes: [],
    details: [],
  };
  const scope = object(object(data.proposal).scope);
  const args = object(data.input);
  const input = object(args.input ?? args);
  const selected = selectedTargets(data.tool, data.op, scope);
  const proposed = selected
    .map((item) => name(item))
    .filter((item) => item !== null);
  const target = name(scope) ?? name(object(scope.current)) ?? name(input);
  const key = data.tool + '.' + data.op;
  const title = actionTitles[key] ?? stored.title;
  const memberLabel = (value: string) =>
    data.tool === 'ath_project_members'
      ? value.replace(/（[a-z0-9._-]{3,64}）/giu, '')
      : value;

  const summary =
    key === 'ath_reviews.approve' && selected.length
      ? '准备批准 ' + selected.length + ' 个评审对象。'
      : key === 'ath_issue_lifecycle.close' && selected.length
        ? '准备关闭 ' + selected.length + ' 个缺陷。'
        : key === 'ath_assets.import-ui' && selected.length
          ? '准备导入 ' + selected.length + ' 条用例。'
          : (labels(memberLabel(stored.summary), 1000) ?? '请核对以下变更。');
  const targets = proposed.length ? proposed : target ? [target] : [];
  const changes = stored.changes
    .map(({ label, before, after }) => ({
      label,
      before: labels(before, 2000),
      after: labels(after, 2000),
    }))
    .filter((item) => item.before !== null || item.after !== null);
  const seen = new Set<string>();
  let countShown = false;
  const details = stored.details.flatMap((detail) => {
    const value = labels(memberLabel(detail.value), 2000);
    if (!value || detail.label === '项目' || targets.includes(value)) return [];
    if (selected.length && detail.label === '相关对象') return [];
    if (detail.label === '所选对象数量') {
      if (countShown || targets.length) return [];
      countShown = true;
    }
    const key = detail.label + '\n' + value;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label: detail.label, value }];
  });
  let resultPresentation: ResultView | undefined;
  if (data.state === 'completed') {
    const raw = object(data.response);
    const actual = rows(raw.results ?? raw.items);
    if (actual.length) {
      const names = new Map(
        selected
          .filter((item) => typeof item.id === 'string')
          .map((item) => [item.id, name(item)]),
      );
      const items = actual.slice(0, 10000).map((item, index) => {
        const issue = object(item.issue);
        const status =
          key === 'ath_issue_lifecycle.close' && item.status === 'accepted'
            ? issue.state
            : item.status;
        return {
          subject:
            name(item) ??
            name(issue) ??
            names.get(item.id ?? item.objectId) ??
            (key === 'ath_assets.import-ui'
              ? name(selected[index] ?? {})
              : null) ??
            '第 ' + (index + 1) + ' 项',
          outcome:
            typeof status === 'string'
              ? (dictionary[status] ?? '已返回结果')
              : '已返回结果',
          detail: readableReason(item),
        };
      });
      const totals = new Map<string, number>();
      for (const item of items)
        totals.set(item.outcome, (totals.get(item.outcome) ?? 0) + 1);
      resultPresentation = {
        summary:
          [...totals]
            .map(([word, count]) => word + ' ' + count + ' 项')
            .join('，') + '。',
        items,
      };
    } else {
      const resultTarget =
        name(object(raw.project)) ??
        name(object(raw.issue)) ??
        name(object(raw.configuration)) ??
        target;
      resultPresentation = {
        summary: resultTarget
          ? '已完成「' + resultTarget + '」的' + title + '操作。'
          : '已完成本次' + title + '。',
        items: [],
      };
    }
  } else if (data.state === 'declined') {
    resultPresentation = { summary: '已取消本次变更。', items: [] };
  } else if (data.state === 'failed') {
    resultPresentation = {
      summary:
        readableReason(object(object(data.response).error)) ??
        '本次变更未完成，请核对当前状态。',
      items: [],
    };
  }
  return {
    title,
    summary,
    projectName: stored.projectName,
    changes,
    details,
    targets,
    ...(resultPresentation ? { resultPresentation } : {}),
  };
}
