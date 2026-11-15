import { ToolOutlined } from '@ant-design/icons';
import type { TaskGuidanceEntry } from './task-guidance';
import { WorkspaceReferenceChip } from './workspace-composer-references';
import './workspace-process-references.css';

export function WorkspaceToolBadge({
  name,
  external,
}: {
  name: string;
  external: boolean;
}) {
  const official = name.startsWith('ath_');
  return (
    <WorkspaceReferenceChip
      kind="plugin"
      label={name}
      title={name}
      icon={
        official ? (
          <img src="/brand-f-color.png" alt="" />
        ) : external ? undefined : (
          <ToolOutlined />
        )
      }
      className="workspace-process-reference"
    />
  );
}

export function WorkspaceGuidanceRecord({
  entry,
}: {
  entry: TaskGuidanceEntry;
}) {
  return (
    <span
      className="workspace-guidance-record"
      data-guidance-state={entry.status}
    >
      <WorkspaceReferenceChip
        kind="skill"
        label={entry.name}
        className="workspace-process-reference"
      />
      <span className="workspace-guidance-record-meta">
        {entry.status === 'bound'
          ? `已固定 v${entry.version}${entry.available ? '' : ' · 不可用'}（未读取）`
          : entry.status === 'loaded'
            ? `已读取平台指引 · v${entry.version} · ${entry.section}（仅指引）`
            : `平台指引不可用 · ${entry.section} · ${entry.code}`}
      </span>
    </span>
  );
}
