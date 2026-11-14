import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, lstat, link, unlink, type FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type {
  FileChannelPort,
  FileDigest,
  RegisteredFile,
  ResultPort,
  ToolPort,
} from './ports.js';
import { ActorWorkspace, noLinks, platformOrigin } from './workspace.js';
import { LocalClientError, localFailure, platformFailure } from './errors.js';
import { validateComponent } from './contracts.js';
import {
  readResourceCapabilities,
  localFileBinaryEnvelope,
} from './capabilities.js';

const id = z.uuid(),
  digestSchema = z.strictObject({
    bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
const fileSchema = z
  .object({
    id,
    ownerScope: z.literal('project'),
    projectId: id,
    runId: id.nullable(),
    originalName: z.string(),
    mediaType: z.string(),
    bytes: digestSchema.shape.bytes,
    sha256: digestSchema.shape.sha256,
    status: z.enum(['pending', 'uploading', 'verified', 'failed']),
  })
  .passthrough();
const maximumUpload = Number(localFileBinaryEnvelope.maxFileBytes);
async function writeAll(fd: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await fd.write(bytes, offset, bytes.length - offset);
    if (written.bytesWritten <= 0)
      throw new Error('Incomplete private file write');
    offset += written.bytesWritten;
  }
}
export interface FileChannelHost {
  workspace: ActorWorkspace;
  tool: ToolPort;
  result: ResultPort;
  /** Trusted host supplies a Key for the same verified actor as the SDK transport. Never model JSON. */
  getBearerToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumDownloadBytes?: number;
}
async function hashFile(
  path: string,
  max = maximumUpload,
): Promise<FileDigest> {
  const hash = createHash('sha256');
  let count = 0;
  const fd = await open(path, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > max)
      throw localFailure('FILE_TOO_LARGE', '文件不是限额内普通文件。');
    for await (const raw of fd.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(raw);
      count += bytes.length;
      if (count > max)
        throw localFailure('FILE_TOO_LARGE', '文件读取超过限额。');
      hash.update(bytes);
    }
  } finally {
    await fd.close();
  }
  return { bytes: String(count), sha256: hash.digest('hex') };
}
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new LocalClientError(
      'INVALID_HTTP_RECEIPT',
      'unknown',
      '字节通道缺少回执。',
    );
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > 64 * 1024) {
        await reader.cancel();
        throw new LocalClientError(
          'INVALID_HTTP_RECEIPT',
          'unknown',
          '字节回执超出限额。',
        );
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
    );
  } catch {
    throw new LocalClientError(
      'INVALID_HTTP_RECEIPT',
      'unknown',
      '字节通道未返回有效UTF8 JSON。',
    );
  }
}
function safeError(
  error: unknown,
  identity?: { fileId?: string; localFileId?: string },
  remoteStarted = false,
): LocalClientError {
  if (error instanceof LocalClientError)
    return new LocalClientError(
      error.code,
      remoteStarted && error.certainty === 'notDispatched'
        ? 'unknown'
        : error.certainty,
      error.message,
      identity,
    );
  return new LocalClientError(
    'FILE_OUTCOME_UNKNOWN',
    'unknown',
    '原文件传输未取得可靠回执；保存原身份后查询，不自动重试。',
    identity,
  );
}
export class PlatformFileChannel implements FileChannelPort {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxDownload: number;
  readonly #host: FileChannelHost;
  constructor(host: FileChannelHost) {
    this.#host = host;
    this.fetcher = host.fetch ?? fetch;
    this.timeoutMs = host.timeoutMs ?? 600_000;
    this.maxDownload = host.maximumDownloadBytes ?? maximumUpload;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 600_000 ||
      !Number.isSafeInteger(this.maxDownload) ||
      this.maxDownload < 1 ||
      this.maxDownload > 1073741824
    )
      throw localFailure(
        'INVALID_HOST_CONFIG',
        '文件超时/限额须由可信host合理配置。',
      );
  }
  async inspectFile(absolutePath: string): Promise<FileDigest> {
    const path = await this.#host.workspace.authorizeReadFile(absolutePath);
    return hashFile(path);
  }
  private async headers(mediaType?: string): Promise<Headers> {
    platformOrigin(this.#host.workspace.origin);
    let token: string;
    try {
      token = await this.#host.getBearerToken();
    } catch {
      throw localFailure(
        'CREDENTIALS_UNAVAILABLE',
        '可信host未提供本身份的字节通道凭据。',
      );
    }
    if (!token || token.length > 505 || /[\s\x00-\x1f\x7f]/.test(token))
      throw localFailure('CREDENTIALS_UNAVAILABLE', '字节通道凭据格式无效。');
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (mediaType) headers.set('Content-Type', mediaType);
    return headers;
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const raw = await this.#host.tool.callTool(name, args),
      data = this.#host.result.read(raw);
    this.#host.result.assertSafe(data);
    return data;
  }
  private checkFile(
    file: z.infer<typeof fileSchema>,
    input: {
      projectId: string;
      runId?: string;
      originalName?: string;
      mediaType?: string;
    },
    expected: FileDigest,
    fileId?: string,
  ): void {
    if (
      file.projectId !== input.projectId ||
      file.runId !== (input.runId ?? null) ||
      (fileId && file.id !== fileId) ||
      file.bytes !== expected.bytes ||
      file.sha256 !== expected.sha256 ||
      (input.originalName !== undefined &&
        file.originalName !== input.originalName) ||
      (input.mediaType !== undefined && file.mediaType !== input.mediaType)
    )
      throw new LocalClientError(
        'FILE_RECEIPT_MISMATCH',
        'unknown',
        '文件回执身份、项目/运行或原字节不一致。',
        { fileId: file.id },
      );
  }
  async uploadFile(
    input: Parameters<FileChannelPort['uploadFile']>[0],
  ): ReturnType<FileChannelPort['uploadFile']> {
    id.parse(input.projectId);
    if (input.runId !== undefined) id.parse(input.runId);
    if (
      !input.localFileId ||
      input.localFileId.length > 200 ||
      !input.originalName ||
      input.originalName.length > 512 ||
      /[\/\\\x00-\x1f\x7f]/.test(input.originalName) ||
      !input.mediaType ||
      /[\r\n]/.test(input.mediaType)
    )
      throw localFailure('VALIDATION_ERROR', '文件身份、名称或媒体类型无效。');
    this.#host.result.assertSafe({
      projectId: input.projectId,
      localFileId: input.localFileId,
      originalName: input.originalName,
      mediaType: input.mediaType,
    });
    const source = await this.#host.workspace.authorizeReadFile(
        input.absolutePath,
      ),
      directory = await this.#host.workspace.transferDirectory(),
      spool = join(directory, `upload-${randomUUID()}.bin`),
      fd = await open(spool, 'wx', 0o600),
      hash = createHash('sha256');
    let bytes = 0,
      registered: RegisteredFile | undefined,
      remoteStarted = false;
    try {
      await noLinks(source);
      const sourceFd = await open(source, 'r');
      try {
        for await (const raw of sourceFd.createReadStream({
          autoClose: false,
        })) {
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > maximumUpload)
            throw localFailure(
              'FILE_TOO_LARGE',
              '原件超过本客户端256MiB流式表示范围。',
            );
          hash.update(chunk);
          await writeAll(fd, chunk);
        }
      } finally {
        await sourceFd.close();
        await fd.sync();
        await fd.close();
      }
      const actual = { bytes: String(bytes), sha256: hash.digest('hex') };
      if (input.expected !== undefined) {
        digestSchema.parse(input.expected);
        if (
          input.expected.bytes !== actual.bytes ||
          input.expected.sha256 !== actual.sha256
        )
          throw localFailure(
            'LOCAL_FILE_CHANGED',
            '当前原件与调用方保存的原字节摘要不同；未登记或上传。',
          );
      }
      remoteStarted = true;
      const ticket = await this.call('ath_file_transfers', {
          op: 'prepare-ticket',
          input: {
            ownerScope: 'project',
            projectId: input.projectId,
            ...(input.runId ? { runId: input.runId } : {}),
            localFileId: input.localFileId,
            originalName: input.originalName,
            mediaType: input.mediaType,
            ...actual,
          },
        }),
        parsed = z
          .object({ file: fileSchema, fullUploadPath: z.string().optional() })
          .parse(ticket);
      this.checkFile(parsed.file, input, actual);
      registered = {
        fileId: parsed.file.id,
        localFileId: input.localFileId,
        ...actual,
      };
      await input.onRegistered(registered);
      const path = `/api/v1/files/${registered.fileId}/content`;
      if (parsed.fullUploadPath !== undefined && parsed.fullUploadPath !== path)
        throw new LocalClientError(
          'UNSAFE_FILE_CHANNEL',
          'unknown',
          '服务返回未知上传路径；未跟随该地址。',
          registered,
        );
      if (parsed.file.status === 'verified') {
        await unlink(spool);
        return { ...registered, status: 'verified' };
      }
      // Inspect the actual accepted file identity. An active lowering must not
      // pre-empt an older legal registration, and 403 never expands a key.
      const capabilities = await readResourceCapabilities(
        this.#host.tool,
        this.#host.result,
        { target: 'file', fileId: registered.fileId },
      );
      if (BigInt(actual.bytes) > BigInt(capabilities.limits.maxFileBytes))
        throw new LocalClientError(
          'FILE_ACCEPTED_LIMIT_MISMATCH',
          'unknown',
          '原件与服务端原受理限额不符；保留原fileId，不上传或重试。',
          registered,
        );
      const headers = await this.headers('application/octet-stream');
      headers.set('Content-Length', actual.bytes);
      const outgoing = createReadStream(spool),
        body = Readable.toWeb(outgoing) as unknown as BodyInit;
      let response: Response;
      try {
        response = await this.fetcher(
          new URL(path, this.#host.workspace.origin),
          {
            method: 'PUT',
            headers,
            body,
            duplex: 'half',
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: AbortSignal.timeout(this.timeoutMs),
          } as RequestInit & { duplex: 'half' },
        );
      } finally {
        outgoing.destroy();
      }
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new LocalClientError(
          'REDIRECT_REJECTED',
          'unknown',
          '字节通道不跟随重定向。',
          registered,
        );
      const data = await responseJson(response);
      try {
        this.#host.result.assertSafe(data);
      } catch {
        throw new LocalClientError(
          'UNSAFE_HTTP_RECEIPT',
          'unknown',
          '文件回执不安全；不能推断写未发生。',
        );
      }
      if (!response.ok) {
        const error = z
          .object({ error: z.object({ code: z.string() }) })
          .safeParse(data);
        throw error.success
          ? platformFailure(error.data.error.code)
          : new LocalClientError(
              'FILE_OUTCOME_UNKNOWN',
              'unknown',
              '文件服务未确认本次上传。',
            );
      }
      const uploaded = z.object({ file: fileSchema }).parse(data).file;
      this.checkFile(uploaded, input, actual, registered.fileId);
      if (uploaded.status !== 'verified')
        throw new LocalClientError(
          'FILE_NOT_VERIFIED',
          'unknown',
          '没有真实verified文件回执。',
          registered,
        );
      await unlink(spool);
      return { ...registered, status: 'verified' };
    } catch (error) {
      await fd.close().catch(() => undefined);
      if (
        error instanceof LocalClientError &&
        error.certainty !== 'unknown' &&
        !remoteStarted
      )
        await unlink(spool).catch(() => undefined);
      throw safeError(
        error,
        registered ?? { localFileId: input.localFileId },
        remoteStarted,
      );
    }
  }
  private downloadUrl(
    projectId: string,
    sourcePath: string,
  ): { url: URL; fileId?: string } {
    id.parse(projectId);
    if (/[\x00-\x20\x7f\\]/.test(sourcePath))
      throw localFailure('UNSAFE_FILE_CHANNEL', '下载路径包含不可接受字符。');
    let url: URL;
    try {
      url = new URL(sourcePath, this.#host.workspace.origin);
    } catch {
      throw localFailure('UNSAFE_FILE_CHANNEL', '下载来源无效。');
    }
    if (
      url.origin !== this.#host.workspace.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw localFailure(
        'UNSAFE_FILE_CHANNEL',
        '下载只接受可信平台同源固定通道。',
      );
    const file = /^\/api\/v1\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (file) {
      id.parse(file[1]);
      if (url.search)
        throw localFailure(
          'UNSAFE_FILE_CHANNEL',
          '文件字节通道不接受任意query或签名URL。',
        );
      return { url, fileId: file[1]! };
    }
    const knowledge = /^\/api\/v1\/mcp\/knowledge-exports\/([^/]+)$/.exec(
      url.pathname,
    );
    if (knowledge) {
      if (
        id.parse(knowledge[1]) !== projectId ||
        [...url.searchParams.keys()].some((k) => k !== 'selection') ||
        url.searchParams.getAll('selection').length !== 1
      )
        throw localFailure('UNSAFE_FILE_CHANNEL', '知识导出项目或参数不符。');
      let selection: unknown;
      try {
        selection = JSON.parse(url.searchParams.get('selection')!);
      } catch {
        throw localFailure('VALIDATION_ERROR', '知识选择不是有效JSON。');
      }
      this.#host.result.assertSafe(selection);
      validateComponent('knowledge.knowledgeExportSelectionSchema', selection);
      return { url };
    }
    const report =
      /^\/api\/v1\/mcp\/report-exports\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        url.pathname,
      );
    if (report) {
      if (id.parse(report[1]) !== projectId || url.search)
        throw localFailure(
          'UNSAFE_FILE_CHANNEL',
          '固定报告项目/修订参数不符。',
        );
      id.parse(report[2]);
      id.parse(report[3]);
      return { url };
    }
    throw localFailure(
      'UNSAFE_FILE_CHANNEL',
      '该路径不是已核对的平台文件/固定导出通道。',
    );
  }
  async downloadToFile(
    input: Parameters<FileChannelPort['downloadToFile']>[0],
  ): ReturnType<FileChannelPort['downloadToFile']> {
    const route = this.downloadUrl(input.projectId, input.sourcePath),
      destination = await this.#host.workspace.authorizeDestination(
        input.destinationPath,
      );
    let expected = input.expected;
    if (expected !== undefined) digestSchema.parse(expected);
    if (route.fileId) {
      const data = await this.call('ath_file_transfers', {
          op: 'receipt',
          fileId: route.fileId,
        }),
        file = z.object({ file: fileSchema }).parse(data).file;
      if (
        file.id !== route.fileId ||
        file.projectId !== input.projectId ||
        file.status !== 'verified'
      )
        throw localFailure(
          'FILE_SCOPE_MISMATCH',
          '下载原件项目或可用状态不符。',
        );
      if (
        expected &&
        (expected.bytes !== file.bytes || expected.sha256 !== file.sha256)
      )
        throw localFailure(
          'FILE_RECEIPT_MISMATCH',
          '调用方原摘要与平台原件不同。',
        );
      expected = { bytes: file.bytes, sha256: file.sha256 };
    }
    const temporary = destination + `.download-${randomUUID()}.tmp`;
    let fd;
    try {
      const response = await this.fetcher(route.url, {
        method: 'GET',
        headers: await this.headers(),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new LocalClientError(
          'REDIRECT_REJECTED',
          'unknown',
          '下载通道不跟随重定向。',
        );
      if (!response.ok) {
        const value = await responseJson(response),
          failure = z
            .object({ error: z.object({ code: z.string() }) })
            .safeParse(value);
        throw failure.success
          ? platformFailure(failure.data.error.code)
          : new LocalClientError(
              'DOWNLOAD_UNCONFIRMED',
              'unknown',
              '下载请求未成功。',
            );
      }
      if (response.status !== 200)
        throw new LocalClientError(
          'UNEXPECTED_DOWNLOAD_STATUS',
          'unknown',
          '完整下载不接受部分响应或后台受理状态。',
        );
      if (!response.body)
        throw new LocalClientError(
          'DOWNLOAD_UNCONFIRMED',
          'unknown',
          '下载缺少字节流。',
        );
      const length = response.headers.get('Content-Length');
      if (
        length !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(length) ||
          BigInt(length) > BigInt(this.maxDownload))
      )
        throw localFailure('FILE_TOO_LARGE', '下载声明超过host限额。');
      fd = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256'),
        reader = response.body.getReader();
      let count = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          count += next.value.length;
          if (count > this.maxDownload) {
            await reader.cancel();
            throw localFailure('FILE_TOO_LARGE', '下载流超过host限额。');
          }
          hash.update(next.value);
          await writeAll(fd, next.value);
        }
      } finally {
        reader.releaseLock();
      }
      await fd.sync();
      await fd.close();
      fd = undefined;
      const actual = { bytes: String(count), sha256: hash.digest('hex') };
      if (
        (length !== null && actual.bytes !== length) ||
        (expected &&
          (expected.bytes !== actual.bytes ||
            expected.sha256 !== actual.sha256))
      )
        throw new LocalClientError(
          'DOWNLOAD_INTEGRITY_MISMATCH',
          'unknown',
          '下载字节与已知原摘要不一致；未发布目标文件。',
        );
      await noLinks(dirname(destination));
      await link(temporary, destination);
      await unlink(temporary);
      return {
        ...actual,
        absolutePath: destination,
        expectedIntegrityMatched: expected ? true : null,
      };
    } catch (error) {
      await fd?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw safeError(error);
    }
  }
}
