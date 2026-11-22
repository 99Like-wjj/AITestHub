import { StatusTag, type StatusTone } from './semantic-status';

export const fileKindLabels = {
  original: '原始资料',
  artifact: 'AI 成果',
  legacy: '历史文件',
} as const;

const evidenceSourceLabels = {
  original: '原件',
  manualAddition: '人工补证',
  derived: '派生证据',
} as const;

export type EvidenceSource = keyof typeof evidenceSourceLabels;

export function EvidenceSourceTag({ source }: { source: EvidenceSource }) {
  return (
    <StatusTag tone={source === 'original' ? 'neutral' : 'info'}>
      {evidenceSourceLabels[source]}
    </StatusTag>
  );
}

export function FileKindTag({ kind }: { kind: keyof typeof fileKindLabels }) {
  return (
    <StatusTag tone={kind === 'artifact' ? 'info' : 'neutral'}>
      {fileKindLabels[kind]}
    </StatusTag>
  );
}

const fileStatusLabels: Record<string, { label: string; tone: StatusTone }> = {
  verified: { label: '已核验', tone: 'success' },
  pending: { label: '待上传', tone: 'warning' },
  uploading: { label: '上传中', tone: 'info' },
  failed: { label: '上传失败', tone: 'error' },
  deleted: { label: '已删除', tone: 'neutral' },
  available: { label: '可查看', tone: 'success' },
  unavailable: { label: '暂不可查看', tone: 'warning' },
};

export function FileStatusTag({ status }: { status?: string | undefined }) {
  const state =
    status && Object.hasOwn(fileStatusLabels, status)
      ? fileStatusLabels[status]
      : undefined;
  return state ? (
    <StatusTag tone={state.tone}>{state.label}</StatusTag>
  ) : (
    <StatusTag tone="neutral">{status ?? '查询状态中'}</StatusTag>
  );
}
