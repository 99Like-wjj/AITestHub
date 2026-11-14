import { z } from 'zod';
import {
  conversationCreateInputSchema,
  conversationCreatedSchema,
  conversationCreateReceiptSchema,
} from '../../../packages/contracts/src/conversations';
import { api, ApiError, isUncertainMutationError } from './api';
import { currentIdentityOwner, identityContextEpoch } from './identity-context';

const prefix = 'aitesthub:conversation-create:v1:';
export const conversationCreateChanged =
  'aitesthub:conversation-create-changed';
const recordSchema = z.strictObject({
  userId: z.uuid(),
  commandId: z.uuid(),
  state: z.enum(['inFlight', 'unknown']),
});
export type ConversationCreateAttempt = z.infer<typeof recordSchema>;
export type CreatedConversation = z.infer<typeof conversationCreatedSchema>;
type CreateInput = Omit<
  z.infer<typeof conversationCreateInputSchema>,
  'commandId'
>;
const dispatched = new Set<string>(),
  owned = new Set<string>(),
  resolved = new Set<string>();
const key = (record: ConversationCreateAttempt) =>
  `${prefix}${record.userId}:${record.commandId}`;
function changed() {
  window.dispatchEvent(new Event(conversationCreateChanged));
}
function storageFailure() {
  return new ApiError(
    '本人对话恢复记录无法保存或读取，已阻止新的创建。请保留原标识核对，不重复创建。',
    409,
    'CREATE_RECOVERY_STORAGE_UNAVAILABLE',
  );
}
function assertOwner(userId: string) {
  if (currentIdentityOwner() !== userId)
    throw new ApiError(
      '正在核对当前账号，本次未创建或发送。',
      409,
      'IDENTITY_RECHECK_PENDING',
    );
}
export function pendingConversationCreates(
  userId: string,
): ConversationCreateAttempt[] {
  const rows: ConversationCreateAttempt[] = [];
  try {
    const store = window.localStorage;
    for (let index = 0; index < store.length; index++) {
      const name = store.key(index);
      if (!name?.startsWith(`${prefix}${userId}:`)) continue;
      const record = recordSchema.parse(
        JSON.parse(store.getItem(name) ?? 'null'),
      );
      if (name !== key(record) || record.userId !== userId)
        throw storageFailure();
      if (!resolved.has(name))
        rows.push(
          record.state === 'inFlight' && !owned.has(name)
            ? { ...record, state: 'unknown' }
            : record,
        );
    }
  } catch {
    throw storageFailure();
  }
  return rows;
}
function retain(record: ConversationCreateAttempt) {
  const value = JSON.stringify(record),
    name = key(record);
  try {
    window.localStorage.setItem(name, value);
    if (window.localStorage.getItem(name) !== value) throw storageFailure();
  } catch {
    throw storageFailure();
  }
  changed();
}
function unknown(record: ConversationCreateAttempt) {
  owned.delete(key(record));
  dispatched.delete(key(record));
  retain({ ...record, state: 'unknown' });
}
function acknowledge(record: ConversationCreateAttempt) {
  const name = key(record);
  resolved.add(name);
  owned.delete(name);
  dispatched.delete(name);
  if (resolved.size > 1024) resolved.delete(resolved.values().next().value!);
  try {
    window.localStorage.removeItem(name);
  } catch {
    /* The original key remains recoverable after reload, never replayed. */
  }
  changed();
}
export function prepareConversationCreate(
  userId: string,
): ConversationCreateAttempt {
  assertOwner(userId);
  if (pendingConversationCreates(userId).length)
    throw new ApiError(
      '本人已有对话创建等待核对，请先只读查询原创建回执；不要重复建立新对话。',
      409,
      'CONVERSATION_CREATE_UNRESOLVED',
    );
  const record: ConversationCreateAttempt = {
    userId,
    commandId: crypto.randomUUID(),
    state: 'inFlight',
  };
  owned.add(key(record));
  try {
    retain(record);
  } catch (error) {
    owned.delete(key(record));
    throw error;
  }
  return record;
}
export async function dispatchConversationCreate(
  record: ConversationCreateAttempt,
  input: CreateInput,
): Promise<CreatedConversation> {
  assertOwner(record.userId);
  if (!owned.has(key(record)) || dispatched.has(key(record)))
    throw new ApiError(
      '本次创建已发送或需先核对原回执，未再次创建。',
      409,
      'CONVERSATION_CREATE_UNRESOLVED',
    );
  // Storage may have been removed/replaced by another context after prepare.
  // Refuse before sending; never overwrite a damaged or changed recovery record.
  try {
    const durable = recordSchema.parse(
      JSON.parse(window.localStorage.getItem(key(record)) ?? 'null'),
    );
    if (
      durable.userId !== record.userId ||
      durable.commandId !== record.commandId ||
      durable.state !== 'inFlight'
    )
      throw storageFailure();
  } catch {
    throw storageFailure();
  }
  const epoch = identityContextEpoch();
  // Consume the one dispatch permission synchronously; a double click cannot POST twice.
  dispatched.add(key(record));
  try {
    const body = conversationCreateInputSchema.parse({
      ...input,
      commandId: record.commandId,
    });
    const response = await api(
      '/me/conversations',
      { method: 'POST', body },
      conversationCreatedSchema,
    );
    if (
      identityContextEpoch() !== epoch ||
      currentIdentityOwner() !== record.userId
    )
      throw new ApiError(
        '账号已变化，原创建结果待原账号核对。',
        0,
        'IDENTITY_CONTEXT_CHANGED',
      );
    acknowledge(record);
    return response;
  } catch (error) {
    if (isUncertainMutationError(error)) unknown(record);
    else acknowledge(record);
    throw error;
  }
}
export async function recoverConversationCreate(
  record: ConversationCreateAttempt,
): Promise<CreatedConversation> {
  assertOwner(record.userId);
  const epoch = identityContextEpoch();
  try {
    const response = await api(
      `/me/conversations/create-receipts/${encodeURIComponent(record.commandId)}`,
      {},
      conversationCreateReceiptSchema,
    );
    if (response.commandId !== record.commandId)
      throw new ApiError(
        '原创建回执标识不匹配，请保留本次标识继续核对。',
        502,
        'RESPONSE_SCHEMA_MISMATCH',
      );
    if (
      identityContextEpoch() !== epoch ||
      currentIdentityOwner() !== record.userId
    )
      throw new ApiError(
        '账号已变化，原创建回执未用于当前页面。',
        0,
        'IDENTITY_CONTEXT_CHANGED',
      );
    acknowledge(record);
    return response.receipt;
  } catch (error) {
    // 404 is only absence in the current read, never permission to issue another create.
    unknown(record);
    throw error;
  }
}
