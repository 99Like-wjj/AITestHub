import type { AiTaskEvent } from '../../../packages/contracts/src/conversations';

type GuidanceReceipt = Extract<
  AiTaskEvent,
  { type: 'ai.guidance.loaded' }
>['payload']['receipt'];
const names = {
  'ath-case-design': '用例设计与优化',
  'ath-project-knowledge': '项目知识管理',
  'ath-api-regression': '接口自动化测试',
} satisfies Record<GuidanceReceipt['skillId'], string>;
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
  generation: '生成',
  'native-api': '原生 API',
  'maintenance-and-recovery': '维护与恢复',
  'platform-debug': '平台排障',
} satisfies Record<GuidanceReceipt['section'], string>;

export interface TaskGuidanceEntry {
  skillId: GuidanceReceipt['skillId'];
  name: string;
  status: 'bound' | 'loaded' | 'unavailable';
  available: boolean;
  version: string | null;
  section: string | null;
  code: string | null;
}

/** Metadata records distinguish a pinned release from a rule that was read. */
export function taskGuidanceEntries(event: AiTaskEvent): TaskGuidanceEntry[] {
  if (event.type === 'ai.guidance.bound')
    return event.payload.snapshot.releases.map((release) => ({
      skillId: release.skillId,
      name: names[release.skillId],
      status: 'bound',
      available: release.available,
      version: release.version,
      section: null,
      code: null,
    }));
  if (event.type !== 'ai.guidance.loaded') return [];
  const receipt = event.payload.receipt;
  return [
    {
      skillId: receipt.skillId,
      name: names[receipt.skillId],
      status: receipt.status,
      available: receipt.status === 'loaded',
      version: receipt.version,
      section: sections[receipt.section],
      code: receipt.status === 'unavailable' ? receipt.code : null,
    },
  ];
}

/** Select known metadata; never stringify a rule receipt or render a rule body. */
export function taskGuidanceLabel(event: AiTaskEvent): string | null {
  const entries = taskGuidanceEntries(event);
  if (event.type === 'ai.guidance.bound')
    return `已固定平台规则：${entries.map((entry) => `${entry.name} v${entry.version}${entry.available ? '' : '（不可用）'}`).join('；')}`;
  const entry = entries[0];
  if (!entry) return null;
  return entry.status === 'loaded'
    ? `已读取平台指引：${entry.name} v${entry.version} · ${entry.section}（仅指引）`
    : `平台指引不可用：${entry.name} · ${entry.section} · ${entry.code}`;
}
