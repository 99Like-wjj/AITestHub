import { z } from 'zod';
import {
  officeCreateSchema,
  officeEditSchema,
  officeInspectSchema,
  type OfficeFormat,
} from '../../../contracts/src/agent-office.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { CalculationReceipt } from '../../../contracts/src/agent-calculation.js';
import {
  AgentCalculationService,
  type AgentCalculationScope,
} from '../agent-calculation/service.js';
import { DomainError } from '../errors.js';
import { officeProgram } from './office-code.js';

const mediaTypes: Record<OfficeFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};
export const officeInspectionSchema = z
  .object({
    format: z.enum(['docx', 'xlsx', 'pptx', 'pdf']),
    operation: z.enum(['create', 'edit', 'inspect']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    structureChecked: z.literal(true),
    visualLayoutVerified: z.literal(false),
    changedParts: z.array(z.string()),
    preservedPartCount: z.number().int().nonnegative(),
    preservedPartsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    warnings: z.array(z.string()),
  })
  .catchall(z.json());

/** Fixed Office intent uses the exact same authority, execution ledger and artifact CAS as A05. */
export class AgentOfficeService {
  constructor(
    readonly calculation: Pick<
      AgentCalculationService,
      'run' | 'status' | 'cancel' | 'files'
    >,
  ) {}
  #code(request: unknown): string {
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
    const code = `import base64,json\nREQUEST=json.loads(base64.b64decode('${encoded}'))\n${officeProgram}`;
    if (Buffer.byteLength(code) > 128 * 1024)
      throw new DomainError(
        'PRECONDITIONS_MISSING',
        '办公文件结构化输入超过本次执行上限，请拆分后继续。',
        422,
      );
    return code;
  }
  #receipt(calculation: CalculationReceipt) {
    let inspection: z.infer<typeof officeInspectionSchema> | null = null;
    let officeError: string | null = null;
    if (!calculation.outputPartial) {
      try {
        const result = z
          .object({
            officeInspection: officeInspectionSchema.optional(),
            officeError: z
              .string()
              .regex(/^OFFICE_[A-Z0-9_]+$/)
              .optional(),
          })
          .parse(JSON.parse(calculation.stdout));
        inspection = result.officeInspection ?? null;
        officeError = result.officeError ?? null;
      } catch {
        /* An actual runtime failure may have no valid Office report; never synthesize one. */
      }
    }
    if (
      inspection &&
      calculation.artifacts.some(
        (artifact) =>
          artifact.sandboxPath.startsWith('outputs/artifact.') &&
          (artifact.entry.sha256 !== inspection.sha256 ||
            BigInt(artifact.entry.bytes) !== BigInt(inspection.sizeBytes)),
      )
    )
      officeError = 'OFFICE_ARTIFACT_INSPECTION_MISMATCH';
    return {
      calculation,
      inspection,
      officeError,
      validationState: officeError
        ? ('failed' as const)
        : inspection
          ? ('verifiedStructure' as const)
          : ('notVerified' as const),
      notice:
        '结构检查和未改part摘要不等于视觉验收。请下载查看；公式重算、复杂布局和PDF覆盖边界见inspection.warnings。原运行未知时只查同一runId。',
    };
  }
  async create(
    actor: ActorContext,
    scope: AgentCalculationScope,
    raw: unknown,
  ) {
    const input = officeCreateSchema.parse(raw);
    const format = input.document.format;
    if (!input.output.path.toLowerCase().endsWith('.' + format))
      throw new DomainError(
        'VALIDATION_ERROR',
        '产物扩展名必须与办公格式一致。',
        400,
      );
    const request = { operation: 'create', format, spec: input.document.spec };
    return this.#receipt(
      await this.calculation.run(actor, scope, {
        commandId: input.commandId,
        code: this.#code(request),
        inputs: [],
        outputs: [
          {
            path: `outputs/artifact.${format}`,
            workspacePath: input.output.path,
            expectedRowVersion: input.output.expectedRowVersion,
            mediaType: mediaTypes[format],
          },
        ],
        timeoutMs: 60_000,
      }),
    );
  }
  async edit(actor: ActorContext, scope: AgentCalculationScope, raw: unknown) {
    const input = officeEditSchema.parse(raw);
    const format = input.edit.format;
    if (!input.output.path.toLowerCase().endsWith('.' + format))
      throw new DomainError(
        'VALIDATION_ERROR',
        '产物扩展名必须与办公格式一致。',
        400,
      );
    const request = { operation: 'edit', format, spec: input.edit };
    return this.#receipt(
      await this.calculation.run(actor, scope, {
        commandId: input.commandId,
        code: this.#code(request),
        inputs: [{ ...input.source, path: `inputs/source.${format}` }],
        outputs: [
          {
            path: `outputs/artifact.${format}`,
            workspacePath: input.output.path,
            expectedRowVersion: input.output.expectedRowVersion,
            mediaType: mediaTypes[format],
          },
        ],
        timeoutMs: 60_000,
      }),
    );
  }
  async inspect(
    actor: ActorContext,
    scope: AgentCalculationScope,
    raw: unknown,
  ) {
    const input = officeInspectSchema.parse(raw);
    return this.#receipt(
      await this.calculation.run(actor, scope, {
        commandId: input.commandId,
        code: this.#code({ operation: 'inspect', format: input.format }),
        inputs: [{ ...input.source, path: `inputs/source.${input.format}` }],
        outputs: [],
        timeoutMs: 30_000,
      }),
    );
  }
  async status(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ) {
    return this.#receipt(await this.calculation.status(actor, scope, runId));
  }
  async cancel(
    actor: ActorContext,
    scope: AgentCalculationScope,
    runId: string,
  ) {
    return this.#receipt(await this.calculation.cancel(actor, scope, runId));
  }
  async files(
    actor: ActorContext,
    scope: AgentCalculationScope,
    offset: number,
    limit: number,
  ) {
    return this.calculation.files(actor, scope, offset, limit);
  }
}
