import { z } from 'zod';
import type { Capability } from './identity.js';

export const mcpToolNameSchema = z.enum([
  'ath_projects',
  'ath_requirements',
  'ath_requirement_materials',
  'ath_requirement_membership',
  'ath_requirement_state',
  'ath_assets',
  'ath_reviews',
  'ath_plans',
  'ath_api_runs',
  'ath_schedules',
  'ath_test_configuration',
  'ath_database_connections',
  'ath_ui_executions',
  'ath_file_transfers',
  'ath_results',
  'ath_reports',
  'ath_problems',
  'ath_issues',
  'ath_retests',
  'ath_issue_lifecycle',
  'ath_knowledge',
  'ath_knowledge_changes',
  'ath_operation_status',
]);
export type McpToolName = z.infer<typeof mcpToolNameSchema>;
export type McpConfirmation =
  | 'precise-scope'
  | 'explicit-selection'
  | 'impact'
  | 'manual-overlap'
  | 'human-decision';
export interface McpOperationDeclaration {
  readonly op: string;
  readonly capability: Capability;
  readonly access: 'read' | 'write';
  readonly confirmation?: McpConfirmation;
  readonly confirmationCondition?:
    'multiple-objects' | 'overlapping-active-run' | 'always';
}
export interface McpToolDeclaration {
  readonly name: McpToolName;
  readonly description: string;
  readonly operations: readonly McpOperationDeclaration[];
  // Declaration is distinct from registration. A transport must register only wired operations.
  readonly implementationStatus: 'declared';
}
const read = (
  op: string,
  capability: Capability = 'project.read',
): McpOperationDeclaration => ({
  op,
  capability,
  access: 'read',
});
const write = (
  op: string,
  capability: Capability,
  confirmation?: McpConfirmation,
): McpOperationDeclaration =>
  confirmation === undefined
    ? { op, capability, access: 'write' }
    : {
        op,
        capability,
        access: 'write',
        confirmation,
        confirmationCondition:
          confirmation === 'precise-scope'
            ? 'multiple-objects'
            : confirmation === 'manual-overlap'
              ? 'overlapping-active-run'
              : 'always',
      };
const declareTool = (
  name: McpToolName,
  description: string,
  operations: readonly McpOperationDeclaration[],
): McpToolDeclaration => ({
  name,
  description,
  operations,
  implementationStatus: 'declared',
});

/** V3/engineering 04 §4 capability declarations; no handler is implied by this catalog. */
export const MCP_TOOL_CATALOG: readonly McpToolDeclaration[] = [
  declareTool('ath_projects', '查询当前有权项目，不提供项目管理。', [
    read('list'),
    read('get'),
  ]),
  declareTool(
    'ath_requirements',
    '明确项目范围内查询需求和版本，查找未完成须明确状态。',
    [
      read('find'),
      read('get'),
      read('list'),
      read('list-page'),
      write('semantic-candidates', 'requirements.write'),
      read('auxiliary-status'),
      read('auxiliary-by-command'),
      read('auxiliary-preflight'),
    ],
  ),
  declareTool(
    'ath_requirement_materials',
    '读取材料清单或提交确切材料版本，文件通过专门通道上传。',
    [
      read('get-manifest'),
      read('prepare-version', 'requirements.write'),
      write('commit-version', 'requirements.write'),
    ],
  ),
  declareTool(
    'ath_requirement_membership',
    '维护需求参与名单，不授予项目成员资格或业务角色。',
    [read('get'), write('set', 'requirements.participants.write')],
  ),
  declareTool(
    'ath_requirement_state',
    '管理需求状态及归档，只有无历史需求可删除。',
    [
      write('lifecycle', 'requirements.write'),
      write('archive', 'requirements.write'),
      read('delete-preview', 'requirements.write'),
      read('deletion-receipt', 'requirements.write'),
      write('delete-if-no-history', 'requirements.write', 'impact'),
    ],
  ),
  declareTool(
    'ath_assets',
    '按类型、需求版本和批次查询或维护独立资产，提交含基准。',
    [
      read('list'),
      read('get'),
      write('create-set', 'assets.write'),
      write('create-scenario', 'assets.write'),
      write('create-case', 'assets.write'),
      write('submit', 'assets.write'),
      write('revise', 'assets.write'),
      write('explicit-remove', 'assets.write', 'impact'),
      write('sql-review-request', 'assets.write'),
      read('auxiliary-status'),
      read('auxiliary-by-command'),
      read('auxiliary-preflight'),
    ],
  ),
  declareTool('ath_reviews', '评审意见和人工批准；AI优化说明不构成批准。', [
    read('opinions'),
    write('add-opinion', 'assets.write'),
    write('remove-opinion', 'reviews.approve'),
    write('optimization-notes', 'assets.write'),
    read('preview-approve', 'reviews.approve'),
    write('approve', 'reviews.approve', 'precise-scope'),
  ]),
  declareTool(
    'ath_plans',
    '创建和修订UI/API计划；UI固定批准范围，不启动本地浏览器。',
    [
      read('get'),
      read('list'),
      write('create', 'plans.write'),
      write('revise', 'plans.write'),
    ],
  ),
  declareTool(
    'ath_api_runs',
    '平台接口执行、事件和停止后续；未知结果先查状态，人工新轮不重试原轮。',
    [
      read('start-preview', 'runs.organize'),
      write('start', 'runs.organize', 'manual-overlap'),
      read('status'),
      read('events'),
      read('attempt-detail'),
      write('debug-start', 'runs.organize'),
      read('debug-trace'),
      write('stop-after-current', 'runs.organize'),
      write('manual-new-run', 'runs.organize', 'manual-overlap'),
    ],
  ),
  declareTool('ath_schedules', '管理带时区的未来定时，恢复不补跑过去时点。', [
    read('list'),
    read('preview', 'plans.write'),
    read('get'),
    write('create', 'plans.write'),
    write('revise', 'plans.write'),
    write('pause', 'plans.write'),
    write('resume', 'plans.write'),
    write('copy', 'plans.write'),
    read('occurrences'),
  ]),
  declareTool(
    'ath_test_configuration',
    '项目环境、用途、绑定和认证配置，仅返回非秘密元数据。',
    [
      read('list', 'test-configuration.read'),
      read('get', 'test-configuration.read'),
      write('create', 'test-configuration.write'),
      write('update', 'test-configuration.write'),
      write('disable', 'test-configuration.write'),
    ],
  ),
  declareTool(
    'ath_database_connections',
    '数据库连接定义和元数据，不执行任意SQL。',
    [
      read('list', 'database-connections.metadata.read'),
      read('metadata', 'database-connections.metadata.read'),
      write('create', 'database-connections.write'),
      write('update', 'database-connections.write'),
      write('disable', 'database-connections.write'),
    ],
  ),
  declareTool(
    'ath_ui_executions',
    '领取或恢复固定本地范围、汇报进度；关闭进度不会停止本地AI。',
    [
      write('prepare', 'runs.organize'),
      write('claim', 'runs.organize'),
      read('resume', 'runs.organize'),
      read('get-scope', 'runs.organize'),
      read('status', 'project.read'),
      write('declare-end', 'results.submit'),
      write('declare-resume', 'results.submit'),
      write('progress', 'runs.organize'),
      write('close-progress', 'runs.organize'),
      read('preview-close-progress-batch', 'runs.organize'),
      write('close-progress-batch', 'runs.organize'),
      read('get-close-progress-batch', 'project.read'),
    ],
  ),
  declareTool(
    'ath_file_transfers',
    '登记完整文件通道、校验和查询回执；本地路径不表示已上传。',
    [
      write('prepare-ticket', 'files.transfer'),
      write('verify', 'files.transfer'),
      read('receipt', 'files.transfer'),
      read('missing', 'files.transfer'),
      read('capabilities', 'files.transfer'),
      read('submission-capabilities', 'results.submit'),
    ],
  ),
  declareTool(
    'ath_results',
    '幂等接收真实明细，缺文件与原始业务结论分开，修订须显式。',
    [
      read('prepare', 'results.submit'),
      write('commit', 'results.submit'),
      write('submit-file', 'results.submit'),
      read('prepare-ui-batch', 'results.submit'),
      write('receive-ui-batch', 'results.submit'),
      write('receive-ui-batch-file', 'results.submit'),
      read('ui-batch-receipt', 'results.submit'),
      read('ui-delivery-status', 'project.read'),
      read('resource-capabilities', 'results.submit'),
      write('seal-ui-delivery', 'results.submit'),
      read('receipt', 'results.submit'),
      write('explicit-amendment', 'results.submit'),
      read('get'),
      // V3 02 §3 explicitly includes manual results; model text alone is not a human decision.
      write('assess', 'results.assess', 'human-decision'),
    ],
  ),
  declareTool(
    'ath_reports',
    '查询受权报告事实、当前人工处理和导出引用，无匿名分享。',
    [
      read('list'),
      read('list-executions'),
      read('get-revision'),
      read('get'),
      read('search-in-scope'),
      read('export-reference'),
    ],
  ),
  declareTool('ath_problems', '问题由测试确认或判为非缺陷，确认幂等。', [
    read('list'),
    read('get'),
    write('report-extra', 'results.submit'),
    write('confirm', 'reviews.approve'),
    write('dismiss', 'reviews.approve'),
    read('preview-confirm-batch', 'reviews.approve'),
    write('confirm-batch', 'reviews.approve', 'precise-scope'),
  ]),
  declareTool('ath_issues', '按角色创建、认领和转交正式缺陷；开发无创建权。', [
    read('get'),
    read('list'),
    write('create', 'issues.create'),
    write('assign', 'issues.lifecycle'),
    write('claim', 'issues.handle'),
    write('transfer', 'issues.handle'),
    write('return', 'issues.handle'),
    write('takeover', 'issues.handle'),
    write('start-processing', 'issues.handle'),
    write('ready-for-retest', 'issues.handle'),
    write('edit', 'issues.create'),
    write('severity', 'issues.handle'),
    write('advice-request', 'project.read'),
    read('auxiliary-status'),
    read('auxiliary-by-command'),
    read('auxiliary-preflight'),
  ]),
  declareTool(
    'ath_retests',
    '原需求版本下准备最新已审固定复测范围，保留缺口与多缺陷关联。',
    [
      read('list'),
      read('group', 'runs.organize'),
      read('start-preview', 'runs.organize'),
      write('prepare', 'runs.organize'),
      write('start-api', 'runs.organize', 'manual-overlap'),
      write('prepare-scope', 'runs.organize'),
      read('get'),
      write('record-manual-result', 'results.assess', 'human-decision'),
      write('associate-run', 'runs.organize'),
    ],
  ),
  declareTool(
    'ath_issue_lifecycle',
    '人工关闭、重开和合并历史；不伪造复测结果。',
    [
      read('preview-close', 'issues.lifecycle'),
      write('close', 'issues.lifecycle', 'precise-scope'),
      write('reopen', 'issues.lifecycle'),
      write('merge', 'issues.lifecycle', 'impact'),
      write('unmerge', 'issues.lifecycle', 'impact'),
    ],
  ),
  declareTool(
    'ath_knowledge',
    '按需查询项目知识索引、正文与历史，不默认加载全库。',
    [
      read('spaces'),
      read('list-index'),
      read('get'),
      read('search'),
      read('history'),
      read('export'),
    ],
  ),
  declareTool(
    'ath_knowledge_changes',
    '比较后按人工明确选择提交，基准冲突不覆盖，缺席不删。',
    [
      write('create-space', 'knowledge.write'),
      write('revise-space', 'knowledge.write'),
      write('create', 'knowledge.write'),
      write('revise', 'knowledge.write'),
      write('explicit-delete', 'knowledge.write', 'impact'),
      read('compare', 'knowledge.write'),
      read('get-comparison', 'knowledge.write'),
      read('get-selection-receipts', 'knowledge.write'),
      write(
        'commit-explicit-selection',
        'knowledge.write',
        'explicit-selection',
      ),
      write('restore', 'knowledge.write', 'explicit-selection'),
    ],
  ),
  declareTool(
    'ath_operation_status',
    '查询本人有权命令、提交和上传的原回执，支持断线查证。',
    [read('get'), read('command'), read('submission'), read('upload')],
  ),
];

export function findMcpOperation(
  toolName: string,
  op: string,
): McpOperationDeclaration | undefined {
  return MCP_TOOL_CATALOG.find(
    (tool) => tool.name === toolName,
  )?.operations.find((operation) => operation.op === op);
}

export function mcpOperationNames(toolName: McpToolName): readonly string[] {
  return (
    MCP_TOOL_CATALOG.find((tool) => tool.name === toolName)?.operations.map(
      (operation) => operation.op,
    ) ?? []
  );
}
