import { z } from 'zod';
const intentSchema = z.strictObject({
  ownerId: z.uuid(),
  userId: z.uuid(),
  commandId: z.uuid(),
  rowVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type AccountRemovalIntent = z.infer<typeof intentSchema>;
type IntentStorage = Pick<
  Storage,
  'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'
>;
const prefix = 'aitesthub:account-removal:v1:';
const key = (intent: AccountRemovalIntent) =>
  `${prefix}${intent.ownerId}:${intent.commandId}`;
const browser = () =>
  typeof window === 'undefined' ? null : window.localStorage;

/** Only recovery IDs. No account names, password/key values, or private bodies are stored. */
export function accountRemovalIntents(
  ownerId: string,
  storage: IntentStorage | null = browser(),
): AccountRemovalIntent[] {
  if (!storage) throw Error('浏览器恢复存储不可用，尚未发送移除请求。');
  const records: AccountRemovalIntent[] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(`${prefix}${ownerId}:`)) continue;
    const record = intentSchema.parse(
      JSON.parse(storage.getItem(name) ?? 'null'),
    );
    if (record.ownerId !== ownerId || key(record) !== name)
      throw Error('原移除恢复记录无法核对，请保留记录并检查浏览器存储。');
    records.push(record);
  }
  return records;
}
export function retainAccountRemoval(
  intent: AccountRemovalIntent,
  storage: IntentStorage | null = browser(),
) {
  const parsed = intentSchema.parse(intent);
  if (
    accountRemovalIntents(parsed.ownerId, storage).some(
      (record) => record.userId === parsed.userId,
    )
  )
    throw Error('该账号已有待核对的移除请求，请先查询原回执。');
  storage!.setItem(key(parsed), JSON.stringify(parsed));
  if (storage!.getItem(key(parsed)) !== JSON.stringify(parsed))
    throw Error('原移除恢复记录未保存，本次请求尚未发送。');
}
export function resolveAccountRemoval(
  intent: AccountRemovalIntent,
  storage: IntentStorage | null = browser(),
) {
  if (!storage) throw Error('原操作已确认，但浏览器恢复记录清理未完成。');
  const original = storage.getItem(key(intent));
  if (
    original !== null &&
    JSON.stringify(intentSchema.parse(JSON.parse(original))) !==
      JSON.stringify(intent)
  )
    throw Error('原移除恢复记录已变化，请保留当前记录核对。');
  storage.removeItem(key(intent));
  if (storage.getItem(key(intent)) !== null)
    throw Error('原操作已确认，但浏览器恢复记录清理未完成。');
}
