import type { ReactNode } from 'react';
import type {
  DeliveryStatus,
  IssueSeverity,
  ReviewState,
  RunState,
} from '../../../packages/contracts/src/domain';
import type { Issue, Problem } from '../../../packages/contracts/src/issues';
import {
  issueStateLabels,
  problemStateLabels,
  severityLabels,
} from './issue-context';
import './semantic-status.css';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export function StatusTag({
  tone = 'neutral',
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className={`semantic-status semantic-status-${tone}`}>
      {children}
    </span>
  );
}

export const reviewLabels: Record<ReviewState, string> = {
  pending: '待确认',
  needsOptimization: '需要优化',
  aiOptimized: 'AI 已优化（仍待人工）',
  approved: '通过',
};
const reviewTones: Record<ReviewState, StatusTone> = {
  pending: 'warning',
  needsOptimization: 'error',
  aiOptimized: 'info',
  approved: 'success',
};
export function ReviewStateTag({ state }: { state: ReviewState }) {
  return <StatusTag tone={reviewTones[state]}>{reviewLabels[state]}</StatusTag>;
}

const issueTones: Record<Issue['state'], StatusTone> = {
  pending: 'warning',
  inProgress: 'info',
  awaitingRetest: 'warning',
  closed: 'neutral',
};
export function IssueStateTag({ state }: { state: Issue['state'] }) {
  return (
    <StatusTag tone={issueTones[state]}>{issueStateLabels[state]}</StatusTag>
  );
}

export function IssueSeverityTag({ severity }: { severity: IssueSeverity }) {
  return (
    <StatusTag tone={severity === 'severe' ? 'error' : 'neutral'}>
      {severityLabels[severity]}
    </StatusTag>
  );
}

const problemTones: Record<Problem['state'], StatusTone> = {
  pendingConfirmation: 'warning',
  confirmed: 'info',
  dismissed: 'neutral',
};
export function ProblemStateTag({ state }: { state: Problem['state'] }) {
  return (
    <StatusTag tone={problemTones[state]}>
      {problemStateLabels[state]}
    </StatusTag>
  );
}

export const executionStateLabels: Record<RunState, string> = {
  prepared: '已准备',
  queued: '排队中',
  running: '执行中',
  stopping: '终止中',
  completed: '执行完成',
  terminated: '已终止',
  interrupted: '已中断',
  recoveryRequired: '需核对恢复',
};
const executionTones: Record<RunState, StatusTone> = {
  prepared: 'neutral',
  queued: 'info',
  running: 'info',
  stopping: 'warning',
  completed: 'success',
  terminated: 'neutral',
  interrupted: 'error',
  recoveryRequired: 'warning',
};
export function ExecutionStateTag({ state }: { state: RunState }) {
  return (
    <StatusTag tone={executionTones[state]}>
      {executionStateLabels[state]}
    </StatusTag>
  );
}

export const deliveryStatusLabels: Record<DeliveryStatus, string> = {
  notSubmitted: '交付尚未提交',
  receiving: '交付接收中',
  incomplete: '交付待补齐',
  complete: '交付完整',
};
const deliveryTones: Record<DeliveryStatus, StatusTone> = {
  notSubmitted: 'neutral',
  receiving: 'info',
  incomplete: 'warning',
  complete: 'success',
};
export function DeliveryStatusTag({ status }: { status: DeliveryStatus }) {
  return (
    <StatusTag tone={deliveryTones[status]}>
      {deliveryStatusLabels[status]}
    </StatusTag>
  );
}
