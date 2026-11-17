import { createHash, randomUUID } from 'node:crypto';
import {
  agentRepositoryInputSchema,
  agentRepositoryResultSchema,
} from '../../../contracts/src/agent-repository.js';
import type {
  AgentSandboxPort,
  SandboxFile,
} from '../../../contracts/src/agent-sandbox.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { FilesService } from '../files/service.js';
import { DomainError } from '../errors.js';
import { repositoryReadCode } from './code.js';
import { assertSafeModelInput } from '../security/model-input.js';

export class AgentRepositoryService {
  constructor(
    readonly files: Pick<FilesService, 'download'>,
    readonly sandbox: AgentSandboxPort,
  ) {}
  async read(
    actor: ActorContext,
    raw: unknown,
    scope: {
      authorizeResource: (id: string) => Promise<void>;
      signal?: AbortSignal;
    },
  ) {
    const input = agentRepositoryInputSchema.parse(raw);
    await scope.authorizeResource(input.resourceId);
    const source = await this.files.download(
      { ...actor, entrypoint: 'web' },
      input.resourceId,
    );
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of source.body) {
        const value: unknown = chunk;
        if (!(value instanceof Uint8Array))
          throw new Error('SOURCE_BYTES_INVALID');
        length += value.byteLength;
        if (length > 12 * 1024 * 1024)
          throw new DomainError(
            'PRECONDITIONS_MISSING',
            'Git bundle超过12MiB，请提供较小的完整仓库快照。',
            422,
          );
        chunks.push(Buffer.from(value));
      }
    } finally {
      source.body.destroy();
    }
    const bytes = Buffer.concat(chunks),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const files: SandboxFile[] = [
      {
        path: 'inputs/request.json',
        contentBase64: Buffer.from(JSON.stringify(input)).toString('base64'),
      },
    ];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024)
      files.push({
        path: `inputs/source-${String(files.length).padStart(3, '0')}.bin`,
        contentBase64: bytes
          .subarray(offset, offset + 4 * 1024 * 1024)
          .toString('base64'),
      });
    const run = await this.sandbox.execute(
      {
        runId: randomUUID(),
        language: 'python',
        code: repositoryReadCode,
        files,
        timeoutMs: 30000,
      },
      scope.signal,
    );
    if (run.state !== 'completed' || !run.cleanupConfirmed)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        'Git仓库读取未完成或已超限；只支持完整SHA-1 Git bundle、UTF-8源码与明确提交，不执行checkout/网络/仓库代码。',
        422,
      );
    await scope.authorizeResource(input.resourceId);
    const result = agentRepositoryResultSchema.parse(JSON.parse(run.stdout));
    assertSafeModelInput(result);
    return {
      ...result,
      resourceId: input.resourceId,
      sourceSha256: sha256,
      readOnly: true as const,
      sourceRefs: [{ kind: 'resource' as const, resourceId: input.resourceId }],
      notice:
        '真实Git对象快照；未执行仓库代码、未checkout、未跟随子模块或符号链接。未读取范围须沿nextOffset继续。',
    };
  }
}
