import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { canonicalJson } from '../operations/service.js';
import { DomainError } from '../errors.js';
import { assertSafeModelInput } from '../security/model-input.js';

function safeToolData(value: unknown): void {
  assertSafeModelInput(value);
  const scan = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) scan(child);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [name, child] of Object.entries(item)) {
      if (/^(?:secretRefs?|credentialRefs?)$/i.test(name))
        throw new DomainError(
          'FORBIDDEN',
          '受保护秘密引用不属于普通业务工具资料。',
          403,
        );
      scan(child);
    }
  };
  scan(value);
}

export interface ConfirmationScope {
  reason:
    | 'precise-scope'
    | 'manual-overlap'
    | 'impact'
    | 'explicit-selection'
    | 'human-decision';
  summary: string;
  scope: unknown;
  links: string[];
}
export interface PreparedBusinessCall {
  toolName: string;
  op: string;
  input: unknown;
  projectId?: string;
  confirmation?: ConfirmationScope & { digest: string };
  execute: () => Promise<unknown>;
}
interface Operation {
  schema: z.ZodType;
  prepare: (actor: ActorContext, raw: unknown) => Promise<PreparedBusinessCall>;
  access: 'read' | 'write';
  internalOnly: boolean;
}
export interface BusinessTool {
  name: string;
  description: string;
  operations: Map<string, Operation>;
  internalOnly: boolean;
}
/** Explicit service bindings only; neither the model nor a transport supplies a handler. */
export class BusinessToolRegistry {
  readonly tools = new Map<string, BusinessTool>();
  add<S extends z.ZodType>(
    name: string,
    description: string,
    op: string,
    schema: S,
    access: 'read' | 'write',
    execute: (actor: ActorContext, input: z.infer<S>) => Promise<unknown>,
    confirmation?: (
      actor: ActorContext,
      input: z.infer<S>,
    ) => Promise<ConfirmationScope | undefined>,
    internalOnly = false,
  ): void {
    let entry = this.tools.get(name);
    if (!entry) {
      entry = { name, description, operations: new Map(), internalOnly };
      this.tools.set(name, entry);
    }
    entry.internalOnly = entry.internalOnly && internalOnly;
    if (entry.operations.has(op))
      throw new Error(`Duplicate business tool operation ${name}.${op}`);
    entry.operations.set(op, {
      schema,
      access,
      internalOnly,
      prepare: async (actor, raw) => {
        const input = schema.parse(raw);
        safeToolData(input);
        const scope = await confirmation?.(actor, input);
        if (scope) safeToolData(scope);
        const project = z.object({ projectId: z.string() }).safeParse(input);
        const nestedProject = z
          .object({ input: z.object({ projectId: z.string() }) })
          .safeParse(input);
        if (
          project.success &&
          nestedProject.success &&
          project.data.projectId !== nestedProject.data.input.projectId
        )
          throw new DomainError(
            'BUSINESS_CONFLICT',
            '工具外层和业务输入的项目目标不一致。',
            409,
          );
        const call: PreparedBusinessCall = {
          toolName: name,
          op,
          input,
          ...(project.success
            ? { projectId: project.data.projectId }
            : nestedProject.success
              ? { projectId: nestedProject.data.input.projectId }
              : {}),
          ...(scope
            ? {
                confirmation: {
                  ...scope,
                  digest: createHash('sha256')
                    .update(canonicalJson({ name, op, input, scope }))
                    .digest('hex'),
                },
              }
            : {}),
          execute: async () => {
            const result = await execute(actor, input);
            safeToolData(result);
            return result;
          },
        };
        return call;
      },
    });
  }
  schema(
    tool: BusinessTool,
    entrypoint: ActorContext['entrypoint'] = 'internal-ai',
  ): z.ZodType {
    return z.union(
      [...tool.operations.values()]
        .filter(
          (operation) =>
            !operation.internalOnly || entrypoint === 'internal-ai',
        )
        .map((operation) => operation.schema),
    );
  }
  async prepare(
    actor: ActorContext,
    name: string,
    raw: unknown,
  ): Promise<PreparedBusinessCall> {
    const envelope = z.object({ op: z.string() }).parse(raw);
    const tool = this.tools.get(name);
    if (!tool || (tool.internalOnly && actor.entrypoint !== 'internal-ai'))
      throw new DomainError('FORBIDDEN', '此入口未开放该业务工具。', 403);
    const operation = tool.operations.get(envelope.op);
    if (!operation)
      throw new DomainError(
        'VALIDATION_ERROR',
        '此工具操作尚未接线或不允许。',
        400,
      );
    if (operation.internalOnly && actor.entrypoint !== 'internal-ai')
      throw new DomainError('FORBIDDEN', '此入口未开放该业务操作。', 403);
    return operation.prepare(actor, raw);
  }
}
