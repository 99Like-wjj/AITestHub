import { z } from 'zod';
const schema = z.strictObject({
  userId: z.uuid(),
  projectId: z.uuid().nullable(),
  targetId: z.uuid(),
  commandId: z.uuid(),
  operation: z.enum(['requirements.collaboration', 'conversations.send']),
  state: z.enum(['inFlight', 'unknown']),
});
export type IdentityCommand = z.infer<typeof schema>;
const prefix = 'aitesthub:identity-command:v1:';
export const identityCommandsChanged = 'aitesthub:identity-commands-changed';
const memory = new Map<string, IdentityCommand>(),
  resolved = new Set<string>(),
  owned = new Set<string>();
let readable = true,
  storageReliable = true;
export const identityCommandStorageReliable = () => storageReliable;
const key = (record: IdentityCommand) =>
  `${prefix}${record.userId}:${record.operation}:${record.commandId}`;
function changed() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(identityCommandsChanged));
}
function all() {
  const records = new Map<string, IdentityCommand>();
  try {
    readable = true;
    if (typeof window !== 'undefined') {
      const storage = window.localStorage;
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index);
        if (!name?.startsWith(prefix)) continue;
        const item = schema.parse(JSON.parse(storage.getItem(name) ?? 'null'));
        if (key(item) !== name) throw new Error('Invalid recovery identifier.');
        if (!resolved.has(name))
          records.set(
            name,
            item.state === 'inFlight' && !owned.has(name)
              ? { ...item, state: 'unknown' }
              : item,
          );
      }
    }
  } catch {
    readable = false;
    storageReliable = false;
  }
  for (const [name, item] of memory)
    if (!resolved.has(name)) records.set(name, item);
  return [...records.values()];
}
function save(record: IdentityCommand) {
  const name = key(record);
  memory.set(name, record);
  if (typeof window === 'undefined') return true;
  try {
    window.localStorage.setItem(name, JSON.stringify(record));
    memory.delete(name);
    storageReliable = true;
  } catch {
    storageReliable = false;
  }
  changed();
  return storageReliable;
}
export function pendingIdentityCommands(userId: string) {
  return all().filter(
    (record) => record.userId === userId && record.state === 'unknown',
  );
}
export function markIdentityCommandsUnknown() {
  for (const record of all())
    if (record.state === 'inFlight') uncertainIdentityCommand(record);
}
export function makeIdentityCommand(
  userId: string | null,
  path: string,
  method: string,
  body: unknown,
): IdentityCommand | null {
  if (
    !userId ||
    typeof body !== 'object' ||
    body === null ||
    !('commandId' in body)
  )
    return null;
  const collaboration =
      /^\/projects\/([^/]+)\/requirements\/([^/]+)\/collaboration$/.exec(path),
    send = /^\/me\/conversations\/([^/]+)\/messages$/.exec(path);
  const raw =
    collaboration && method === 'PUT'
      ? {
          userId,
          projectId: collaboration[1],
          targetId: collaboration[2],
          commandId: body.commandId,
          operation: 'requirements.collaboration',
          state: 'inFlight',
        }
      : send && method === 'POST'
        ? {
            userId,
            projectId: null,
            targetId: send[1],
            commandId: body.commandId,
            operation: 'conversations.send',
            state: 'inFlight',
          }
        : null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function retainIdentityCommand(record: IdentityCommand) {
  const records = all(),
    name = key(record);
  if (
    !readable ||
    resolved.has(name) ||
    records.some(
      (item) =>
        item.userId === record.userId &&
        item.operation === record.operation &&
        item.projectId === record.projectId &&
        item.targetId === record.targetId,
    )
  )
    return false;
  owned.add(name);
  if (!save(record)) {
    owned.delete(name);
    memory.delete(name);
    return false;
  }
  return true;
}
export function uncertainIdentityCommand(record: IdentityCommand) {
  const name = key(record);
  if (resolved.has(name)) return;
  owned.delete(name);
  save({ ...record, state: 'unknown' });
}
export function resolveIdentityCommand(record: IdentityCommand) {
  const name = key(record);
  resolved.add(name);
  owned.delete(name);
  memory.delete(name);
  if (resolved.size > 1024) resolved.delete(resolved.values().next().value!);
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(name);
  } catch {
    storageReliable = false;
  }
  changed();
}
