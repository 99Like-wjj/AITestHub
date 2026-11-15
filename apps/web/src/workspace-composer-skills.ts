export {
  serializeComposerSkills,
  splitComposerSkills,
} from '../../../packages/contracts/src/composer-skills';
const skillLabels: Readonly<Record<string, string>> = {
  'ath-case-design': 'AITestHub 用例设计',
  'ath-project-knowledge': 'AITestHub 项目知识',
  'ath-api-regression': 'AITestHub 接口测试',
};

export function workspaceSkillLabel(id: string): string {
  return Object.hasOwn(skillLabels, id) ? (skillLabels[id] ?? id) : id;
}
