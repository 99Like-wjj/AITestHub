import { z } from 'zod';
import {
  modelConfigurationCommandV2Schema,
  modelServiceV2ReceiptSchema,
  auxiliaryModelV2ReceiptSchema,
} from '../../../packages/contracts/src/model-configuration-v2';
import { api, ApiError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';

export const modelCommandOperationSchema = z.enum([
  'configuration.model-create',
  'configuration.model-update',
  'configuration.model-remove',
  'configuration.model-credential-set',
  'configuration.model-credential-revoke',
  'configuration.model-auxiliary-set',
]);
const intentSchema = z.strictObject({
  version: z.literal(1),
  userId: z.uuid(),
  commandId: z.uuid(),
  operation: modelCommandOperationSchema,
  serviceId: z.uuid().nullable(),
  state: z.enum(['prepared', 'dispatched']),
});
export type ModelCommandIntent = z.infer<typeof intentSchema>;
export type ModelCommandOperation = ModelCommandIntent['operation'];
export type ModelCommandReceipt =
  | z.infer<typeof modelServiceV2ReceiptSchema>
  | z.infer<typeof auxiliaryModelV2ReceiptSchema>;
const prefix = 'aitesthub:model-configuration-command:v2:';
const fresh = new Set<string>();
const storageKey = (item: ModelCommandIntent) =>
  `${prefix}${item.userId}:${item.commandId}`;
const same = (a: ModelCommandIntent, b: ModelCommandIntent) =>
  a.userId === b.userId &&
  a.commandId === b.commandId &&
  a.operation === b.operation &&
  a.serviceId === b.serviceId;
function failure(message: string): never {
  throw new ApiError(message, 0, 'OPERATION_RESULT_UNKNOWN');
}
function assertOwner(userId: string) {
  if (currentIdentityOwner() !== userId)
    failure('当前身份已变化，请由原账号只读恢复配置回执。');
}
function read(item: ModelCommandIntent) {
  try {
    const stored = intentSchema.parse(
      JSON.parse(window.localStorage.getItem(storageKey(item)) ?? 'null'),
    );
    if (!same(stored, item))
      return failure('本地原命令标识不一致，已阻止提交。');
    return stored;
  } catch {
    return failure('本地原命令记录不可读，已阻止提交；请保留原记录。');
  }
}
function persist(item: ModelCommandIntent) {
  try {
    window.localStorage.setItem(storageKey(item), JSON.stringify(item));
  } catch {
    failure('无法安全保存原命令标识，本次操作未发出。');
  }
  read(item);
}
function clear(item: ModelCommandIntent) {
  const stored = read(item);
  if (!same(stored, item)) return;
  try {
    window.localStorage.removeItem(storageKey(item));
  } catch {
    failure('原回执已确认，但本地恢复标识未能清除；请只读重新核对。');
  }
}
/** Only identifiers are persisted; never config bodies, names, endpoints or API Keys. */
export function pendingModelCommands(userId: string): ModelCommandIntent[] {
  const records: ModelCommandIntent[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(`${prefix}${userId}:`)) continue;
      const item = intentSchema.parse(
        JSON.parse(window.localStorage.getItem(key) ?? 'null'),
      );
      if (storageKey(item) !== key || item.userId !== userId)
        throw new Error('Invalid key');
      records.push(item);
    }
  } catch {
    failure('配置恢复记录损坏或不可读；保留记录并停止新写入。');
  }
  return records;
}
export function prepareModelCommand(
  userId: string,
  operation: ModelCommandOperation,
  serviceId: string | null,
) {
  assertOwner(userId);
  if (pendingModelCommands(userId).length)
    failure('仍有原配置命令待核对，请先恢复原回执。');
  const item = intentSchema.parse({
    version: 1,
    userId,
    operation,
    serviceId,
    commandId: crypto.randomUUID(),
    state: 'prepared',
  });
  if (
    (operation === 'configuration.model-auxiliary-set') !==
    (serviceId === null)
  )
    throw new Error('Invalid command target');
  persist(item);
  fresh.add(storageKey(item));
  return item;
}
function validateReceipt(
  item: ModelCommandIntent,
  value: unknown,
): ModelCommandReceipt {
  if (item.operation === 'configuration.model-auxiliary-set')
    return auxiliaryModelV2ReceiptSchema.parse(value);
  const receipt = modelServiceV2ReceiptSchema.parse(value);
  if (receipt.modelService.id !== item.serviceId)
    failure('配置回执目标与原命令不一致，已保留原标识。');
  return receipt;
}
export async function dispatchModelCommand(
  item: ModelCommandIntent,
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
) {
  assertOwner(item.userId);
  const base = '/admin/model-services',
    servicePath = `${base}/${item.serviceId}`;
  const expected =
    item.operation === 'configuration.model-create'
      ? ['POST', base]
      : item.operation === 'configuration.model-update'
        ? ['PUT', servicePath]
        : item.operation === 'configuration.model-remove'
          ? ['DELETE', servicePath]
          : item.operation === 'configuration.model-credential-set'
            ? ['PUT', `${servicePath}/credential`]
            : item.operation === 'configuration.model-credential-revoke'
              ? ['DELETE', `${servicePath}/credential`]
              : ['PUT', '/admin/auxiliary-model'];
  if (method !== expected[0] || path !== expected[1])
    failure('原命令种类与目标路径不匹配，本次操作未发出。');
  const startEpoch = identityContextEpoch(),
    stored = read(item),
    key = storageKey(item);
  if (
    !fresh.delete(key) ||
    stored.state !== 'prepared' ||
    body.commandId !== item.commandId
  )
    failure('原命令已提交或来自恢复记录，不能重发。');
  persist({ ...item, state: 'dispatched' });
  try {
    const raw = await api(path, { method, body });
    assertOwner(item.userId);
    if (identityContextEpoch() !== startEpoch)
      failure('身份上下文已变化，请由原账号只读核对回执。');
    let receipt: ModelCommandReceipt;
    try {
      receipt = validateReceipt(item, raw);
    } catch {
      return failure('配置响应未通过契约校验，请只读核对原命令。');
    }
    clear(item);
    return receipt;
  } catch (error) {
    if (
      currentIdentityOwner() !== item.userId ||
      identityContextEpoch() !== startEpoch
    )
      failure('身份上下文已变化，原命令结果未知。');
    if (error instanceof ApiError && !isUncertainMutationError(error))
      clear(item);
    throw error;
  }
}
/** A missing/unknown receipt is never permission to repeat the write. */
export async function recoverModelCommand(
  item: ModelCommandIntent,
): Promise<ModelCommandReceipt | null> {
  assertOwner(item.userId);
  read(item);
  const startEpoch = identityContextEpoch();
  const result = await api(
    `/admin/model-services/commands/${encodeURIComponent(item.commandId)}`,
    {},
    modelConfigurationCommandV2Schema,
  );
  assertOwner(item.userId);
  if (identityContextEpoch() !== startEpoch)
    failure('身份上下文已变化，未使用迟到的配置回执。');
  if (
    result.commandId !== item.commandId ||
    result.operation !== item.operation
  )
    failure('原命令种类不匹配；请保留标识并检查，不能重发。');
  if (result.status !== 'succeeded' || result.response === null) return null;
  let receipt: ModelCommandReceipt;
  try {
    receipt = validateReceipt(item, result.response);
  } catch {
    return failure('原命令回执目标或契约不匹配，未解除未知状态。');
  }
  clear(item);
  return receipt;
}
