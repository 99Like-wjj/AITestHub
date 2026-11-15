import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  CloseOutlined,
  ExperimentOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ConversationReferenceInput } from '../../../packages/contracts/src/conversations';
import type { WorkspaceAccessMode } from '../../../packages/contracts/src/workspace-access';
import type { PreparedReference } from './workspace-references';
import { WorkspaceReferencePreview } from './workspace-reference-preview';
import './workspace-composer-references.css';

export type WorkspaceReferenceKind =
  ConversationReferenceInput['kind'] | 'skill' | 'plugin';

export function WorkspaceReferenceIcon({
  kind,
  icon,
}: {
  kind: WorkspaceReferenceKind;
  icon?: ReactNode;
}) {
  let fallback: ReactNode;
  switch (kind) {
    case 'knowledge':
      fallback = <BookOutlined />;
      break;
    case 'skill':
      fallback = <ExperimentOutlined />;
      break;
    case 'plugin':
    case 'externalMcpConnection':
    case 'externalMcpInvocation':
      fallback = <ApiOutlined />;
      break;
    case 'conversation':
      fallback = <MessageOutlined />;
      break;
    case 'requirementVersion':
      fallback = <FileTextOutlined />;
      break;
    case 'resource':
      fallback = <PaperClipOutlined />;
      break;
    default:
      fallback = <AppstoreOutlined />;
  }
  return (
    <span className="workspace-reference-brand-icon" aria-hidden="true">
      {icon || fallback}
    </span>
  );
}

export function WorkspaceReferenceChip({
  label,
  kind,
  icon,
  title,
  trailing,
  className = '',
}: {
  label: string;
  kind: WorkspaceReferenceKind;
  icon?: ReactNode;
  title?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`workspace-reference-chip ${className}`} title={title}>
      <WorkspaceReferenceIcon kind={kind} icon={icon} />
      <span className="workspace-reference-chip-label">{label}</span>
      {trailing}
    </span>
  );
}

function FileReferenceIcon({ name }: { name: string }) {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(extension))
    return <FileImageOutlined />;
  if (extension === 'pdf') return <FilePdfOutlined />;
  if (['doc', 'docx', 'odt'].includes(extension)) return <FileWordOutlined />;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension))
    return <FileExcelOutlined />;
  if (['zip', '7z', 'rar', 'gz', 'tar'].includes(extension))
    return <FileZipOutlined />;
  if (['md', 'txt', 'json', 'html', 'yaml', 'yml', 'xml'].includes(extension))
    return <FileTextOutlined />;
  return <FileOutlined />;
}

function RemoveReference({
  reference,
  disabled,
  onRemove,
}: {
  reference: PreparedReference;
  disabled: boolean;
  onRemove: (reference: PreparedReference) => void;
}) {
  return (
    <button
      type="button"
      className="workspace-reference-remove"
      aria-label={`移除引用：${reference.label}`}
      title={`移除引用：${reference.label}`}
      disabled={disabled}
      onClick={() => onRemove(reference)}
    >
      <CloseOutlined aria-hidden="true" />
    </button>
  );
}

export interface WorkspaceComposerUpload {
  id: string;
  name: string;
  state: string;
  error?: string;
}

export function WorkspaceComposerReferences({
  refs,
  uploading,
  disabled,
  accessMode,
  onRemove,
}: {
  refs: readonly PreparedReference[];
  uploading: readonly WorkspaceComposerUpload[];
  disabled: boolean;
  accessMode: WorkspaceAccessMode;
  onRemove: (reference: PreparedReference) => void;
}) {
  if (!refs.length && !uploading.length) return null;
  const files = refs.filter(
    (reference) => reference.reference.kind === 'resource',
  );
  const other = refs.filter(
    (reference) => reference.reference.kind !== 'resource',
  );
  return (
    <div className="workspace-composer-references" aria-label="附件与引用">
      {(files.length > 0 || uploading.length > 0) && (
        <div
          className="workspace-composer-file-cards"
          role="list"
          aria-label="已选附件"
        >
          {files.map((reference) => (
            <div
              className="workspace-composer-file-card"
              key={reference.id}
              role="listitem"
              aria-label={reference.label}
              aria-description={reference.note}
            >
              <WorkspaceReferencePreview
                fileId={
                  reference.reference.kind === 'resource'
                    ? reference.reference.resourceId
                    : null
                }
                label={reference.label}
                description={reference.note}
                fallback={<FileReferenceIcon name={reference.label} />}
                enabled={accessMode === 'full'}
              />
              <span
                className="workspace-composer-file-name"
                title={reference.label}
              >
                <FileReferenceIcon name={reference.label} />
                <span>{reference.label}</span>
              </span>
              <RemoveReference
                reference={reference}
                disabled={disabled}
                onRemove={onRemove}
              />
            </div>
          ))}
          {uploading.map((upload) => (
            <div
              className={`workspace-composer-file-card workspace-composer-upload${upload.error ? ' has-error' : ''}`}
              key={upload.id}
              role="listitem"
              title={`${upload.name}；${upload.error ?? upload.state}`}
            >
              <span className="workspace-reference-preview" aria-hidden="true">
                {upload.error ? <WarningOutlined /> : <LoadingOutlined />}
              </span>
              <span className="workspace-composer-upload-state" role="status">
                {upload.state}
              </span>
              <span
                className="workspace-composer-file-name"
                title={upload.name}
              >
                <FileReferenceIcon name={upload.name} />
                <span>{upload.name}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {other.length > 0 && (
        <div
          className="workspace-composer-reference-chips"
          role="list"
          aria-label="已选资料引用"
        >
          {other.map((reference) => (
            <span role="listitem" key={reference.id}>
              <WorkspaceReferenceChip
                kind={reference.reference.kind}
                label={reference.label}
                title={`${reference.note}；${accessMode === 'restricted' ? '受限访问不发送' : '发送时按当前权限读取'}`}
                trailing={
                  <RemoveReference
                    reference={reference}
                    disabled={disabled}
                    onRemove={onRemove}
                  />
                }
              />
            </span>
          ))}
        </div>
      )}
      {accessMode === 'restricted' && (
        <p className="workspace-composer-reference-note">
          受限访问不发送这些附件与引用。
        </p>
      )}
    </div>
  );
}
