import { ApiError } from './api';
import {
  currentIdentityOwner,
  identityContextEpoch,
  subscribeIdentityChanges,
} from './identity-context';

export type FilePreviewKind =
  | 'markdown'
  | 'html'
  | 'code'
  | 'structured'
  | 'table'
  | 'office'
  | 'pdf'
  | 'image'
  | 'svg'
  | 'video'
  | 'audio'
  | 'zip'
  | 'unsupported';
export const previewTextMaximumBytes = 2 * 1024 * 1024;
export function fileExtension(name: string) {
  return name.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
}
const groups: Readonly<
  Record<Exclude<FilePreviewKind, 'unsupported'>, readonly string[]>
> = {
  markdown: ['md', 'markdown'],
  html: ['html', 'htm'],
  code: [
    'txt',
    'log',
    'py',
    'java',
    'js',
    'ts',
    'tsx',
    'jsx',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'go',
    'rs',
    'sql',
    'sh',
    'ps1',
    'css',
    'vue',
  ],
  structured: ['json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini'],
  table: ['xlsx', 'csv', 'tsv', 'ods'],
  office: ['docx', 'pptx', 'odt', 'odp'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'],
  svg: ['svg'],
  video: ['mp4', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'm4a'],
  zip: ['zip'],
};
export function previewKind(name: string, mediaType = ''): FilePreviewKind {
  const extension = fileExtension(name);
  for (const [kind, extensions] of Object.entries(groups))
    if (extensions.includes(extension))
      return kind as Exclude<FilePreviewKind, 'unsupported'>;
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('image/') && mediaType !== 'image/svg+xml')
    return 'image';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('text/')) return 'code';
  return 'unsupported';
}
export function humanFileSize(value: string | number) {
  const size = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(size)) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
export function decodePreviewText(bytes: ArrayBuffer) {
  if (bytes.byteLength > previewTextMaximumBytes)
    throw new Error('文本超过2MiB预览范围，请下载原件查看。');
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '');
  } catch {
    throw new Error('文件不是有效的UTF-8文本，请下载原件并选择对应编码查看。');
  }
}

/** Deterministic RFC4180-style field parsing; formulas remain literal source strings. */
export function parseDelimited(
  text: string,
  delimiter = ',',
  maxRows = 5000,
  maxColumns = 256,
) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    afterQuote = false,
    truncated = false;
  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else truncated = true;
    field = '';
    afterQuote = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += char;
      continue;
    }
    if (char === '"' && !field && !afterQuote) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      pushField();
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) {
        truncated = index < text.length - 1;
        break;
      }
      continue;
    }
    if (afterQuote && char !== ' ' && char !== '\t')
      throw new Error('表格引号后的内容不符合CSV格式，请查看源码。');
    if (!afterQuote) field += char;
  }
  if (quoted) throw new Error('CSV存在未闭合的引号，请查看实际源码。');
  if ((field || row.length || afterQuote) && rows.length < maxRows) {
    pushField();
    rows.push(row);
  }
  return { rows, truncated, maxRows, maxColumns };
}

/** Central directory only: no decompression, execution or filesystem extraction. */
export function zipDirectory(buffer: ArrayBuffer) {
  if (buffer.byteLength < 22) throw new Error('ZIP文件过短，中央目录缺失。');
  const view = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  let end = -1;
  for (
    let offset = Math.max(0, bytes.length - 22);
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  )
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  if (end < 0) throw new Error('ZIP中央目录缺失或损坏。');
  if (end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    throw new Error('ZIP结束记录的注释长度无效。');
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  )
    throw new Error('暂不预览分卷ZIP。');
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 8, true) !== count)
    throw new Error('ZIP目录条目数量不一致。');
  if (count === 65535 || start === 0xffffffff || directorySize === 0xffffffff)
    throw new Error('ZIP64超出目录预览范围。');
  if (count > 10000 || start + directorySize > end)
    throw new Error('ZIP目录超过10000项或记录范围无效。');
  const entries: {
    name: string;
    bytes: number;
    compressedBytes: number;
    directory: boolean;
    encrypted: boolean;
    unsafePath: boolean;
  }[] = [];
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw new Error('ZIP目录记录损坏。');
    const flags = view.getUint16(offset + 8, true),
      nameLength = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true),
      next = offset + 46 + nameLength + extra + comment;
    if (next > start + directorySize)
      throw new Error('ZIP文件名记录超出目录范围。');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch {
      name = new TextDecoder('windows-1252').decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      );
    }
    entries.push({
      name,
      bytes: view.getUint32(offset + 24, true),
      compressedBytes: view.getUint32(offset + 20, true),
      directory: name.endsWith('/'),
      encrypted: Boolean(flags & 1),
      unsafePath:
        /^(?:\/|[a-z]:)|\\|(?:^|\/)\.\.(?:\/|$)|[\u0000-\u001f]/i.test(name),
    });
    offset = next;
  }
  if (offset !== start + directorySize)
    throw new Error('ZIP目录长度与实际条目不一致。');
  return entries;
}

interface CacheItem {
  blob: Blob;
  usedAt: number;
}
const cache = new Map<string, CacheItem>();
const activeReads = new Set<AbortController>();
let active = 0;
const waiting: {
  start: () => void;
  signal: AbortSignal;
  reject: (error: Error) => void;
}[] = [];
export function clearFilePreviewCache() {
  for (const controller of activeReads) controller.abort();
  activeReads.clear();
  cache.clear();
  for (const item of waiting)
    item.reject(new Error('身份已变化，已停止旧预览读取。'));
  waiting.length = 0;
}
let subscribed = false;
function listen() {
  if (subscribed) return;
  subscribed = true;
  subscribeIdentityChanges(clearFilePreviewCache);
}
async function slot(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (active < 2) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const item = {
      signal,
      reject,
      start: () => {
        signal.removeEventListener('abort', abort);
        active++;
        resolve();
      },
    };
    const abort = () => {
      const index = waiting.indexOf(item);
      if (index >= 0) waiting.splice(index, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    waiting.push(item);
  });
}
function release() {
  active--;
  for (;;) {
    const next = waiting.shift();
    if (!next) break;
    if (!next.signal.aborted) {
      next.start();
      break;
    }
  }
}
export async function readPreviewBlob(
  path: string,
  cacheIdentity: string,
  signal: AbortSignal,
) {
  listen();
  const internal = new AbortController();
  activeReads.add(internal);
  const activeSignal = AbortSignal.any([signal, internal.signal]);
  const epoch = identityContextEpoch(),
    owner = currentIdentityOwner();
  if (
    !path.startsWith('/api/v1/') ||
    path.includes('://') ||
    path.includes('..')
  ) {
    activeReads.delete(internal);
    throw new Error('预览地址不合法。');
  }
  // The caller revalidates entry metadata on each open; byte cache does not grant access.
  const key = `${owner}:${epoch}:${cacheIdentity}`,
    cached = cache.get(key);
  if (cached && Date.now() - cached.usedAt < 60_000 && !activeSignal.aborted) {
    activeReads.delete(internal);
    cached.usedAt = Date.now();
    return cached.blob;
  }
  try {
    await slot(activeSignal);
  } catch (error: unknown) {
    activeReads.delete(internal);
    throw error;
  }
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: activeSignal,
    });
    if (!response.ok) {
      cache.delete(key);
      throw new ApiError(
        `文件读取失败（HTTP ${response.status}），请重新核对当前权限。`,
        response.status,
        'FILE_PREVIEW_READ_FAILED',
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 256 * 1024 * 1024)
      throw new Error('文件超过256MiB浏览器预览范围，请下载原件。');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('文件没有可读字节。');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 256 * 1024 * 1024)
          throw new Error('文件超过256MiB浏览器预览范围。');
        chunks.push(new Uint8Array(next.value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (
      epoch !== identityContextEpoch() ||
      owner !== currentIdentityOwner() ||
      activeSignal.aborted
    )
      throw new Error('身份或所选文件已变化，未采用旧文件字节。');
    const blob = new Blob(chunks, {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
    if (blob.size <= 16 * 1024 * 1024) {
      cache.set(key, { blob, usedAt: Date.now() });
      while (
        cache.size > 8 ||
        [...cache.values()].reduce((sum, item) => sum + item.blob.size, 0) >
          32 * 1024 * 1024
      ) {
        const oldest = [...cache].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!oldest) break;
        cache.delete(oldest[0]);
      }
    }
    return blob;
  } finally {
    activeReads.delete(internal);
    release();
  }
}
