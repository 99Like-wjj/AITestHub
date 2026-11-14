import type { AiTaskEvent } from '../../../packages/contracts/src/conversations';
const names = {
  'ath-case-design': '用例设计与优化',
  'ath-project-knowledge': '项目知识管理',
};
const sections = {
  entry: '入口',
  'business-rules': '业务规则',
  coverage: '覆盖',
  contracts: '契约',
  review: '评审',
  'platform-adapter': '平台适配',
  'content-and-sources': '内容与来源',
  'platform-workflow': '平台流程',
  runtime: '运行边界',
};
/** Select known metadata; never stringify a rule receipt or render a rule body. */
export function taskGuidanceLabel(event: AiTaskEvent): string | null {
  if (event.type === 'ai.guidance.bound')
    return `已固定平台规则：${event.payload.snapshot.releases.map((release) => `${names[release.skillId]} v${release.version}${release.available ? '' : '（不可用）'}`).join('；')}`;
  if (event.type === 'ai.guidance.loaded') {
    const receipt = event.payload.receipt;
    return receipt.status === 'loaded'
      ? `已读取平台指引：${names[receipt.skillId]} v${receipt.version} · ${sections[receipt.section]}（仅指引）`
      : `平台指引不可用：${names[receipt.skillId]} · ${sections[receipt.section]} · ${receipt.code}`;
  }
  return null;
}
