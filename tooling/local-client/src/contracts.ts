import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import { z } from 'zod';
import { localFailure } from './errors.js';

const jsonSchema = z.record(z.string(), z.json());
const artifactSchema = z.strictObject({
  schemaVersion: z.literal('ath.local-sdk-contract.v1'),
  protocolVersion: z.iso.date(),
  artifactVersion: z.string().min(1),
  tools: z
    .array(z.strictObject({ name: z.string().min(1), inputSchema: jsonSchema }))
    .min(1),
  components: z.record(z.string(), jsonSchema),
});

function readCurrentContract() {
  try {
    const bytes = readFileSync(
      new URL('../contracts/current.json', import.meta.url),
    );
    const artifact = artifactSchema.parse(JSON.parse(bytes.toString('utf8')));
    const inputs = new Map(
      artifact.tools.map(({ name, inputSchema }) => [name, inputSchema]),
    );
    if (inputs.size !== artifact.tools.length)
      throw Error('Repeated tool names.');
    return {
      artifact,
      inputs,
      id: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw localFailure(
      'UNSUPPORTED_CONTRACT',
      '当前 SDK 契约文件缺失或无效；未发送。',
    );
  }
}

const contract = readCurrentContract();
export const contractArtifactId = contract.id;
export const contractProtocolVersion = contract.artifact.protocolVersion;
export const contractVersion = contract.artifact.artifactVersion;
const engine = new CfWorkerJsonSchemaValidator();
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
  const schema = contract.inputs.get(name);
  if (!schema)
    throw localFailure('UNSUPPORTED_TOOL', '此工具不在官方已发布目录。');
  // Whole JSON Schema keeps all same-op leaves, including both strict operation-status/get forms.
  validate(`tool:${name}`, schema, args);
}
export function validateComponent(name: string, value: unknown): void {
  const schemas = contract.artifact.components;
  if (!Object.hasOwn(schemas, name))
    throw localFailure('UNSUPPORTED_CONTRACT', '此组件不在发布快照。');
  validate(`component:${name}`, schemas[name], value);
}
