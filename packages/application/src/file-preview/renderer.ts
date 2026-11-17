import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  filePreviewQuerySchema,
  filePreviewResultSchema,
  type FilePreviewQuery,
  type FilePreviewRenderer,
  type FilePreviewResult,
} from '../../../contracts/src/file-preview.js';
import type { AgentSandboxPort } from '../../../contracts/src/agent-sandbox.js';
import { DomainError } from '../errors.js';
import { filePreviewProgram } from './program.js';

const supported = new Set([
  'docx',
  'pptx',
  'odt',
  'odp',
  'xlsx',
  'ods',
  'csv',
  'tsv',
]);
const messages: Record<string, string> = {
  PREVIEW_CONVERTER_UNAVAILABLE:
    '预览转换组件尚未部署，请管理员配置预览执行镜像。',
  PREVIEW_ENCRYPTED: '文件已加密，当前无法预览。',
  PREVIEW_INVALID_OR_ENCRYPTED: '文件损坏、已加密或不符合所选格式。',
  PREVIEW_ACTIVE_CONTENT: '文件含宏、活动内容或不支持的XML结构，无法安全预览。',
  PREVIEW_ENCODING: '当前表格不是有效UTF-8编码，请下载后转换编码。',
  PREVIEW_SHEET_NOT_FOUND: '所选工作表不存在。',
  PREVIEW_RESULT_LIMIT: '本次预览结果超过限制，请缩小预览范围或下载查看。',
  PREVIEW_CONVERSION_TIMEOUT: '预览转换超时，请下载原件查看。',
};

/** Fixed byte conversion only. The caller owns current authorization and caching. */
export class SandboxFilePreviewRenderer implements FilePreviewRenderer {
  constructor(readonly sandbox: AgentSandboxPort) {}
  async render(
    bytes: Uint8Array,
    filename: string,
    mediaType: string,
    rawQuery: FilePreviewQuery,
    signal?: AbortSignal,
  ): Promise<FilePreviewResult> {
    void mediaType;
    const format = extname(filename).slice(1).toLowerCase();
    if (!supported.has(format))
      throw new DomainError(
        'VALIDATION_ERROR',
        '该格式不使用办公文件预览。',
        400,
      );
    if (bytes.length > 12 * 1024 * 1024)
      throw new DomainError(
        'FILE_TOO_LARGE',
        '办公预览支持最多12MiB原件，请下载查看。',
        413,
      );
    const query = filePreviewQuerySchema.parse(rawQuery);
    const source = Buffer.from(bytes);
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const files = [];
    for (let offset = 0; offset < source.length; offset += 4 * 1024 * 1024)
      files.push({
        path: `inputs/part-${String(files.length).padStart(3, '0')}.bin`,
        contentBase64: source
          .subarray(offset, offset + 4 * 1024 * 1024)
          .toString('base64'),
      });
    const request = {
      format,
      query,
      sha256: sourceSha256,
      parts: files.length,
    };
    const code = `import json,re,sys\nREQUEST=json.loads(${JSON.stringify(JSON.stringify(request))})\ntry:\n${filePreviewProgram
      .split('\n')
      .map((line) => `    ${line}`)
      .join(
        '\n',
      )}\nexcept Exception as error:\n    code=str(error) if re.fullmatch(r'PREVIEW_[A-Z_]+',str(error)) else 'PREVIEW_CONVERSION_FAILED'\n    sys.stderr.write('ATH_PREVIEW_ERROR:'+code+'\\n')\n    sys.exit(2)\nfinally:\n    import pathlib,shutil\n    for item in pathlib.Path('/workspace').iterdir():\n        if item.name!='outputs':\n            if item.is_dir() and not item.is_symlink():shutil.rmtree(item)\n            else:item.unlink(missing_ok=True)\n`;
    const result = await this.sandbox.execute(
      {
        runId: randomUUID(),
        language: 'python',
        code,
        files,
        timeoutMs: 100_000,
      },
      signal,
    );
    if (!result.cleanupConfirmed)
      throw new DomainError(
        'OPERATION_RESULT_UNKNOWN',
        '预览沙箱清理尚未确认，未展示结果。',
        409,
      );
    if (result.state !== 'completed') {
      const known = /ATH_PREVIEW_ERROR:(PREVIEW_[A-Z_]+)/.exec(
        result.stderr,
      )?.[1];
      throw new DomainError(
        known === 'PREVIEW_CONVERTER_UNAVAILABLE'
          ? 'DEPENDENCY_UNAVAILABLE'
          : 'PRECONDITIONS_MISSING',
        known
          ? (messages[known] ?? '文件结构或展开大小超过预览边界，请下载查看。')
          : '预览转换失败或达到资源限制，请下载查看。',
        known === 'PREVIEW_CONVERTER_UNAVAILABLE' ? 503 : 422,
      );
    }
    const metadata = result.files.find(
      (file) => file.path === 'outputs/preview.json',
    );
    if (!metadata)
      throw new DomainError(
        'DEPENDENCY_UNAVAILABLE',
        '预览器未返回有效内容。',
        503,
      );
    let value: unknown = JSON.parse(
      Buffer.from(metadata.contentBase64, 'base64').toString('utf8'),
    );
    const parsed = filePreviewResultSchema.parse(value);
    if (
      parsed.sourceSha256 !== sourceSha256 ||
      parsed.sourceBytes !== source.length
    )
      throw new DomainError(
        'FILE_HASH_MISMATCH',
        '预览来源与原文件不一致。',
        503,
      );
    if (parsed.kind === 'pdf') {
      const pdf = result.files.find(
        (file) => file.path === 'outputs/source.pdf',
      );
      if (
        !pdf ||
        !Buffer.from(pdf.contentBase64, 'base64')
          .subarray(0, 5)
          .equals(Buffer.from('%PDF-'))
      )
        throw new DomainError(
          'DEPENDENCY_UNAVAILABLE',
          '预览器未返回真实PDF文件。',
          503,
        );
      value = { ...parsed, contentBase64: pdf.contentBase64 };
    }
    return filePreviewResultSchema.parse(value);
  }
}
