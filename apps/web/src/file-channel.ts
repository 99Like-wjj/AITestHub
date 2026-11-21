import { api, ApiError } from './api';
import { identityContextEpoch } from './identity-context';
import { fileReceiptSchema } from '../../../packages/contracts/src/files';
import type { FileMetadata } from '../../../packages/contracts/src/files';
import { previewUploadMediaType } from '../../../packages/contracts/src/file-preview';
import {
  readWebFileCapabilities,
  webFileBinaryMaximumBytes,
  type FileCapabilities,
} from './file-capabilities';
import { currentIdentityOwner } from './identity-context';

export interface UploadContext {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onRegistered?: (file: FileMetadata) => void | Promise<void>;
  onAccepted?: (
    file: FileMetadata,
    capabilities: FileCapabilities,
  ) => void | Promise<void>;
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  localFileId: string,
  runId?: string,
  context: UploadContext = {},
) {
  return uploadResource(
    file,
    localFileId,
    {
      ownerScope: 'project',
      projectId,
      ...(runId ? { runId } : {}),
    },
    context,
  );
}

export async function uploadPersonalFile(
  file: File,
  localFileId: string,
  context: UploadContext = {},
) {
  return uploadResource(file, localFileId, { ownerScope: 'personal' }, context);
}

async function uploadResource(
  file: File,
  localFileId: string,
  ownership: {
    ownerScope: 'personal' | 'project';
    projectId?: string;
    runId?: string;
  },
  context: UploadContext,
) {
  const epoch = identityContextEpoch(),
    owner = currentIdentityOwner();
  const assertCurrent = () => {
    if (
      context.signal?.aborted ||
      context.isCurrent?.() === false ||
      epoch !== identityContextEpoch() ||
      owner !== currentIdentityOwner()
    )
      throw new ApiError(
        '当前身份/项目已变化，旧文件操作已停止；已发出的原登记请核对原回执。',
        409,
        'UPLOAD_CONTEXT_CHANGED',
      );
  };
  assertCurrent();
  if (file.size > webFileBinaryMaximumBytes)
    throw new Error(
      '原件超过本浏览器通道256MiB结构护栏；实际限额以当前/原受理资源策略为准。',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  assertCurrent();
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const mediaType = previewUploadMediaType(file.name, file.type);
  const registration = await api(
    '/files/register',
    {
      method: 'POST',
      body: {
        ...ownership,
        localFileId,
        mediaType,
        originalName: file.name,
        bytes: String(file.size),
        sha256,
      },
      ...(context.signal ? { signal: context.signal } : {}),
    },
    fileReceiptSchema,
  );
  assertCurrent();
  const matches = (receipt: FileMetadata) =>
    receipt.ownerScope === ownership.ownerScope &&
    receipt.projectId === (ownership.projectId ?? null) &&
    receipt.runId === (ownership.runId ?? null) &&
    receipt.bytes === String(file.size) &&
    receipt.sha256 === sha256;
  if (!matches(registration.file))
    throw new ApiError(
      '文件登记回执不属于原项目/运行或原字节；未继续上传。',
      0,
      'FILE_RECEIPT_MISMATCH',
    );
  await context.onRegistered?.(registration.file);
  assertCurrent();
  if (registration.file.status === 'verified' && !context.onAccepted)
    return registration.file;
  const capabilities = await readWebFileCapabilities(
    { target: 'file', fileId: registration.file.id },
    context.signal,
  );
  assertCurrent();
  if (
    capabilities.policy.source === 'active' ||
    BigInt(file.size) > BigInt(capabilities.limits.maxFileBytes)
  )
    throw new ApiError(
      '原登记与服务端原受理文件限额不一致，未上传；请核对原fileId。',
      409,
      'FILE_ACCEPTED_LIMIT_MISMATCH',
    );
  await context.onAccepted?.(registration.file, capabilities);
  assertCurrent();
  if (registration.file.status === 'verified') return registration.file;
  const uploaded = await api(
    `/files/${encodeURIComponent(registration.file.id)}/content`,
    {
      method: 'PUT',
      rawBody: file,
      ...(context.signal ? { signal: context.signal } : {}),
    },
    fileReceiptSchema,
  );
  assertCurrent();
  if (uploaded.file.id !== registration.file.id || !matches(uploaded.file))
    throw new ApiError(
      '文件上传回执身份或摘要不匹配；请核对原登记，未自动重传。',
      0,
      'FILE_RECEIPT_MISMATCH',
    );
  if (uploaded.file.status !== 'verified')
    throw new Error('文件尚未通过字节验证，请查看文件状态后完整重传。');
  return uploaded.file;
}

export async function fetchPrivateFile(
  fileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const ownerEpoch = identityContextEpoch();
  let response: Response;
  const timeout = AbortSignal.timeout(180_000);
  try {
    response = await fetch(
      `/api/v1/files/${encodeURIComponent(fileId)}/content`,
      {
        credentials: 'same-origin',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
  } catch {
    throw new ApiError(
      '无法下载文件，请检查本地服务后重新读取。',
      0,
      'NETWORK_UNCONFIRMED',
    );
  }
  if (ownerEpoch !== identityContextEpoch())
    throw new ApiError(
      '当前身份已变化，旧身份文件读取已停止。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (ownerEpoch !== identityContextEpoch())
      throw new ApiError(
        '当前身份已变化，旧文件读取回执未采用。',
        409,
        'IDENTITY_CONTEXT_CHANGED',
      );
    let message = `文件读取未完成（HTTP ${response.status}）`;
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string'
    )
      message = body.error.message;
    if (response.status === 401)
      window.dispatchEvent(new Event('aitesthub:session-expired'));
    throw new ApiError(message, response.status, 'FILE_READ_FAILED');
  }
  const blob = await response.blob();
  if (ownerEpoch !== identityContextEpoch())
    throw new ApiError(
      '当前身份已变化，未展示或下载旧身份文件。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  return blob;
}

export async function downloadPrivateFile(fileId: string, name: string) {
  const ownerEpoch = identityContextEpoch();
  const blob = await fetchPrivateFile(fileId);
  if (ownerEpoch !== identityContextEpoch())
    throw new ApiError(
      '当前身份已变化，未开始旧身份文件下载。',
      409,
      'IDENTITY_CONTEXT_CHANGED',
    );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function isolatedHtml(source: string): string {
  const policy =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
  // Install the deny-by-default policy before the untrusted input is parsed.
  // Removing URL attributes afterwards alone would be too late for an engine
  // that loads subresources while constructing its otherwise inert document.
  const guard = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
  const document = new DOMParser().parseFromString(
    `${guard}${source}`,
    'text/html',
  );
  document
    .querySelectorAll(
      'script,iframe,frame,object,embed,base,meta[http-equiv],foreignObject,animate,animateMotion,animateTransform,set',
    )
    .forEach((element) => element.remove());
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.toLowerCase().startsWith('on') ||
        ['srcdoc', 'action', 'formaction', 'ping', 'xlink:href'].includes(
          attribute.name.toLowerCase(),
        )
      )
        element.removeAttribute(attribute.name);
      if (
        ['href', 'src', 'srcset'].includes(attribute.name.toLowerCase()) &&
        !(
          element.tagName === 'IMG' &&
          attribute.name === 'src' &&
          attribute.value.startsWith('data:image/')
        )
      )
        element.removeAttribute(attribute.name);
    }
  });
  return `${guard}${document.documentElement.outerHTML}`;
}
