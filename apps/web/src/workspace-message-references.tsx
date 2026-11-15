import { useEffect, useRef, useState } from 'react';
import {
  FileImageOutlined,
  FileOutlined,
  LoadingOutlined,
  ProjectOutlined,
} from '@ant-design/icons';
import type { ConversationMessage } from '../../../packages/contracts/src/conversations';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { api } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';
import { WorkspaceReferenceChip } from './workspace-composer-references';
import {
  WorkspaceReferencePreview,
  workspaceReferencePreviewAllowed,
} from './workspace-reference-preview';
import './workspace-message-references.css';

type FrozenReference = ConversationMessage['references'][number];
type ReferenceKind = Exclude<
  FrozenReference['reference']['kind'],
  'resource' | 'projectAccess'
>;
const referenceLabels = {
  conversation: '引用对话',
  requirementVersion: '需求版本',
  knowledge: '项目知识',
  externalMcpConnection: '外部 MCP 服务',
  externalMcpInvocation: '外部 MCP 结果',
} satisfies Record<ReferenceKind, string>;
type DisplayFile = Pick<
  FileMetadata,
  'originalName' | 'ownerScope' | 'status' | 'mediaType' | 'bytes'
>;
interface AttachmentState {
  fileId: string;
  ownerId: string;
  epoch: number;
  status: 'loading' | 'ready' | 'unavailable';
  file: DisplayFile | null;
}

function MessageAttachment({
  fileId,
  unavailable,
  ownerId,
  epoch,
}: {
  fileId: string;
  unavailable: boolean;
  ownerId: string | null;
  epoch: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [metadata, setMetadata] = useState<AttachmentState>();
  useEffect(() => {
    const element = card.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active) setInView(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: '0px', threshold: 0.01 },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    setMetadata(undefined);
    if (!inView || unavailable || !ownerId) return;
    const controller = new AbortController();
    const scope = { fileId, ownerId, epoch };
    const current = () =>
      !controller.signal.aborted &&
      currentIdentityOwner() === ownerId &&
      identityContextEpoch() === epoch;
    setMetadata({ ...scope, status: 'loading', file: null });
    void api(
      `/files/${encodeURIComponent(fileId)}`,
      { signal: controller.signal },
      fileReceiptSchema,
    )
      .then(({ file }) => {
        if (!current()) return;
        if (file.id !== fileId || file.status !== 'verified') {
          setMetadata({ ...scope, status: 'unavailable', file: null });
          return;
        }
        const { originalName, ownerScope, status, mediaType, bytes } = file;
        setMetadata({
          ...scope,
          status: 'ready',
          file: { originalName, ownerScope, status, mediaType, bytes },
        });
      })
      .catch(() => {
        // Names and provider errors are intentionally absent from denied/deleted placeholders.
        if (current())
          setMetadata({ ...scope, status: 'unavailable', file: null });
      });
    return () => controller.abort();
  }, [fileId, unavailable, ownerId, epoch, inView]);

  const visible =
    inView &&
    !unavailable &&
    metadata?.fileId === fileId &&
    metadata.ownerId === ownerId &&
    metadata.epoch === epoch &&
    currentIdentityOwner() === ownerId &&
    identityContextEpoch() === epoch
      ? metadata
      : undefined;
  const file = visible?.status === 'ready' ? visible.file : null;
  const missing = unavailable || visible?.status === 'unavailable';
  const label = file?.originalName ?? (missing ? '附件不可用' : '附件');
  const icon = file?.mediaType.startsWith('image/') ? (
    <FileImageOutlined />
  ) : (
    <FileOutlined />
  );
  return (
    <div
      ref={card}
      role="listitem"
      className="workspace-composer-file-card workspace-message-file-card"
      aria-label={label}
      aria-busy={visible?.status === 'loading' || undefined}
      title={label}
    >
      {visible?.status === 'loading' ? (
        <span className="workspace-reference-preview" aria-hidden="true">
          <LoadingOutlined />
        </span>
      ) : (
        <WorkspaceReferencePreview
          fileId={fileId}
          label={label}
          fallback={icon}
          enabled={Boolean(file && workspaceReferencePreviewAllowed(file))}
        />
      )}
      <span className="workspace-composer-file-name" title={label}>
        {icon}
        <span>{label}</span>
      </span>
    </div>
  );
}

/** Only direct user attachment references read file metadata/pixels. Nested
 * resourceIds remain frozen provenance; they never become implicit downloads. */
export function WorkspaceMessageReferences({
  references,
}: {
  references: ConversationMessage['references'];
}) {
  const [, refreshIdentity] = useState(0);
  useEffect(
    () =>
      subscribeIdentityChanges(() => refreshIdentity((version) => version + 1)),
    [],
  );
  const ownerId = currentIdentityOwner();
  const epoch = identityContextEpoch();
  if (!references.length) return null;
  const attachments = references.filter(
    (entry) => entry.reference.kind === 'resource',
  );
  const other = references.filter(
    (entry) => entry.reference.kind !== 'resource',
  );
  return (
    <div
      className="workspace-message-references"
      aria-label="发送时的附件与引用"
    >
      {attachments.length > 0 && (
        <div className="workspace-message-reference-cards" role="list">
          {attachments.map((entry, index) =>
            entry.reference.kind === 'resource' ? (
              <MessageAttachment
                key={`${entry.reference.resourceId}:${index}`}
                fileId={entry.reference.resourceId}
                unavailable={
                  entry.unavailableResourceIds?.includes(
                    entry.reference.resourceId,
                  ) ?? false
                }
                ownerId={ownerId}
                epoch={epoch}
              />
            ) : null,
          )}
        </div>
      )}
      {other.length > 0 && (
        <div className="workspace-message-reference-chips" role="list">
          {other.map(({ reference }, index) => (
            <span key={`${reference.kind}:${index}`} role="listitem">
              {reference.kind === 'projectAccess' ? (
                <WorkspaceReferenceChip
                  kind="plugin"
                  label="项目资料"
                  icon={<ProjectOutlined />}
                />
              ) : reference.kind !== 'resource' ? (
                <WorkspaceReferenceChip
                  kind={reference.kind}
                  label={referenceLabels[reference.kind]}
                />
              ) : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
