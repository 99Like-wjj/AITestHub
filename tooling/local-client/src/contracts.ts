import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import catalog from '../contracts/8869d4dc-bb5c-45fe-a8d1-98913be7bb01/catalog.json' with { type: 'json' };
import components from '../contracts/8869d4dc-bb5c-45fe-a8d1-98913be7bb01/components.json' with { type: 'json' };
import { localFailure } from './errors.js';

export const contractArtifactId = '8869d4dc-bb5c-45fe-a8d1-98913be7bb01';
const engine = new CfWorkerJsonSchemaValidator();
const inputSchemas = new Map<string, unknown>(
  catalog.tools.map((tool) => [tool.name, tool.inputSchema]),
);
const cache = new Map<
  string,
  ReturnType<CfWorkerJsonSchemaValidator['getValidator']>
>();
function validate(key: string, schema: unknown, value: unknown): void {
  let validator = cache.get(key);
  if (!validator) {
    try {
      validator = engine.getValidator(
        schema as Parameters<CfWorkerJsonSchemaValidator['getValidator']>[0],
      );
      cache.set(key, validator);
    } catch {
      throw localFailure(
        'UNSUPPORTED_CONTRACT',
        '不能编译当前发布结构契约；未发送。',
      );
    }
  }
  let result: ReturnType<typeof validator>;
  try {
    result = validator(value);
  } catch {
    throw localFailure(
      'UNSUPPORTED_CONTRACT',
      '当前结构契约无法可靠校验；未发送。',
    );
  }
  if (!result.valid)
    throw localFailure(
      'VALIDATION_ERROR',
      '输入不符合当前发布的结构契约；未回显内容。',
    );
}
export function validateToolInput(
  name: string,
  args: Record<string, unknown>,
): void {
  const schema = inputSchemas.get(name);
  if (!schema)
    throw localFailure('UNSUPPORTED_TOOL', '此工具不在官方已发布目录。');
  // Whole JSON Schema keeps all same-op leaves, including both strict operation-status/get forms.
  validate(`tool:${name}`, schema, args);
}
export function validateComponent(name: string, value: unknown): void {
  const schemas: Record<string, unknown> = components.schemas;
  const schema = schemas[name];
  if (!schema)
    throw localFailure('UNSUPPORTED_CONTRACT', '此组件不在发布快照。');
  validate(`component:${name}`, schema, value);
}
