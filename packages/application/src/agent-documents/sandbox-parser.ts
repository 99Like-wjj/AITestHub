import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  documentMediaTypes,
  documentReadQuerySchema,
  sandboxDocumentReadResultSchema,
  type DocumentParserPort,
  type DocumentReadQuery,
  type DocumentParserResult,
} from '../../../contracts/src/agent-documents.js';
import type {
  AgentSandboxPort,
  SandboxFile,
} from '../../../contracts/src/agent-sandbox.js';
import { DomainError } from '../errors.js';
import { documentParserCode } from './parser-code.js';

export const maximumDocumentBytes = 12 * 1024 * 1024;
const cacheMaximumBytes = 32 * 1024 * 1024;
const cacheMaximumEntries = 16;
const cacheTtlMs = 120_000;
interface CachedDocument {
  result: DocumentParserResult;
  bytes: number;
  expiresAt: number;
}
interface PendingDocument {
  promise: Promise<DocumentParserResult>;
  controller: AbortController;
  subscribers: Set<symbol>;
  settled: boolean;
}
const parserWireSchema = sandboxDocumentReadResultSchema
  .omit({ images: true })
  .extend({
    images: z
      .array(
        z.strictObject({
          path: z.string().regex(/^outputs\/image-\d{2}\.jpg$/),
          mediaType: z.literal('image/jpeg'),
          location: z.string().max(1000),
        }),
      )
      .max(6),
  });

export class SandboxDocumentParser implements DocumentParserPort {
  private readonly cache = new Map<string, CachedDocument>();
  private readonly pending = new Map<string, PendingDocument>();
  private cachedBytes = 0;
  constructor(
    readonly sandbox: AgentSandboxPort,
    readonly now: () => number = Date.now,
  ) {}

  private prune() {
    for (const [key, value] of this.cache)
      if (value.expiresAt <= this.now()) {
        this.cache.delete(key);
        this.cachedBytes -= value.bytes;
      }
  }
  private store(key: string, result: DocumentParserResult) {
    this.prune();
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > cacheMaximumBytes) return;
    while (
      this.cache.size >= cacheMaximumEntries ||
      this.cachedBytes + bytes > cacheMaximumBytes
    ) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cachedBytes -= oldest[1].bytes;
    }
    this.cache.set(key, {
      result: structuredClone(result),
      bytes,
      expiresAt: this.now() + cacheTtlMs,
    });
    this.cachedBytes += bytes;
  }
  private subscribe(
    pending: PendingDocument,
    signal?: AbortSignal,
  ): Promise<DocumentParserResult> {
    return new Promise((resolve, reject) => {
      const subscriber = Symbol();
      let done = false;
      pending.subscribers.add(subscriber);
      const release = () => {
        pending.subscribers.delete(subscriber);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (done) return;
        done = true;
        release();
        if (!pending.settled && !pending.subscribers.size)
          pending.controller.abort();
        reject(
          new DomainError('PRECONDITIONS_MISSING', '本次文档读取已取消。', 422),
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      pending.promise.then(
        (result) => {
          if (done) return;
          done = true;
          release();
          resolve(structuredClone(result));
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          release();
          reject(error);
        },
      );
      if (signal?.aborted) abort();
    });
  }
  async read(
    bytes: Uint8Array,
    mediaType: (typeof documentMediaTypes)[number],
    rawQuery: DocumentReadQuery,
    signal?: AbortSignal,
  ) {
    if (bytes.byteLength > maximumDocumentBytes)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '文档超过本次12MiB解析上限，请拆分文档后继续。',
        422,
      );
    const query = documentReadQuerySchema.parse(rawQuery);
    if (signal?.aborted)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '本次文档读取已取消。',
        422,
      );
    this.prune();
    const key = createHash('sha256')
      .update(bytes)
      .update(mediaType)
      .update(JSON.stringify(query))
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return structuredClone(cached.result);
    }
    let pending = this.pending.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const fresh: PendingDocument = {
        promise: this.readUncached(bytes, mediaType, query, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) this.store(key, result);
            return result;
          })
          .finally(() => {
            fresh.settled = true;
            if (this.pending.get(key) === fresh) this.pending.delete(key);
          }),
        controller,
        subscribers: new Set(),
        settled: false,
      };
      this.pending.set(key, fresh);
      pending = fresh;
    }
    return this.subscribe(pending, signal);
  }

  private async readUncached(
    bytes: Uint8Array,
    mediaType: (typeof documentMediaTypes)[number],
    query: DocumentReadQuery,
    signal: AbortSignal,
  ): Promise<DocumentParserResult> {
    const formats = ['pdf', 'docx', 'xlsx', 'pptx'] as const;
    const format = formats[documentMediaTypes.indexOf(mediaType)];
    if (!format)
      throw new DomainError('VALIDATION_ERROR', '文档格式不受支持。', 400);
    const source = Buffer.from(bytes);
    const files: SandboxFile[] = [];
    for (let offset = 0; offset < source.length; offset += 4 * 1024 * 1024)
      files.push({
        path: `inputs/source-${String(files.length).padStart(3, '0')}.bin`,
        contentBase64: source
          .subarray(offset, offset + 4 * 1024 * 1024)
          .toString('base64'),
      });
    const request = {
      parts: files.length,
      sha256: createHash('sha256').update(source).digest('hex'),
      format,
      query,
    };
    const code = `import json, re, sys\nREQUEST = json.loads(${JSON.stringify(JSON.stringify(request))})\ntry:\n${documentParserCode
      .split('\n')
      .map((line) => `    ${line}`)
      .join(
        '\n',
      )}\nexcept Exception as error:\n    code = 'DOCUMENT_RUNTIME_UNAVAILABLE' if isinstance(error, ImportError) else (str(error) if re.fullmatch(r'DOCUMENT_[A-Z_]+', str(error)) else 'DOCUMENT_PARSE_FAILED')\n    sys.stderr.write('ATH_DOCUMENT_ERROR:' + code + chr(10))\n    sys.exit(2)\n`;
    const result = await this.sandbox.execute(
      {
        runId: randomUUID(),
        language: 'python',
        code,
        files,
        timeoutMs: 60_000,
      },
      signal,
    );
    if (!result.cleanupConfirmed)
      throw new DomainError(
        'OPERATION_RESULT_UNKNOWN',
        '文档解析已停止等待沙箱清理确认，未将结果冒称可用。',
        409,
      );
    if (result.state !== 'completed') {
      const known = /(?:^|\n)ATH_DOCUMENT_ERROR:(DOCUMENT_[A-Z_]+)\s*$/.exec(
        result.stderr,
      )?.[1];
      if (known === 'DOCUMENT_RUNTIME_UNAVAILABLE')
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '文档执行镜像缺少所需解析依赖，请管理员核对已固定的文档镜像。',
          503,
        );
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        known === 'DOCUMENT_PDF_ENCRYPTED'
          ? '文档需要密码或使用不支持的加密方式，未读取正文。'
          : known === 'DOCUMENT_PDF_INVALID' ||
              known === 'DOCUMENT_PACKAGE_INVALID_OR_ENCRYPTED'
            ? '文档破损、加密或格式不受支持，未读取正文。'
            : known
              ? '文档结构、范围或展开大小不符合解析要求，未声称完整读取。'
              : '文档解析器不可用、超时或超过资源限制，未取得完整可用结果。',
        422,
      );
    }
    const exported = new Map(result.files.map((file) => [file.path, file]));
    const jsonFile = exported.get('outputs/document.json');
    if (!jsonFile)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '解析器未返回受控文档回执。',
        503,
      );
    const parsed = parserWireSchema.parse(
      JSON.parse(
        Buffer.from(jsonFile.contentBase64, 'base64').toString('utf8'),
      ),
    );
    let totalImageBytes = 0;
    const images = parsed.images.map((image) => {
      const file = exported.get(image.path);
      if (!file || file.sizeBytes > 4 * 1024 * 1024)
        throw new DomainError(
          'PRECONDITIONS_MISSING',
          '文档图像不完整或超过限制。',
          422,
        );
      totalImageBytes += file.sizeBytes;
      return {
        type: 'image' as const,
        mediaType: image.mediaType,
        data: file.contentBase64,
      };
    });
    if (
      totalImageBytes > 6 * 1024 * 1024 ||
      parsed.blocks.some((block) =>
        block.imageIndexes.some((index) => index >= images.length),
      )
    )
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '文档图像批次超过限制或定位无效，请缩小读取范围。',
        422,
      );
    return sandboxDocumentReadResultSchema.parse({ ...parsed, images });
  }
}
