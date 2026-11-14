import { open, readFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  availableModelV2ListSchema,
  modelConfigurationCommandV2Schema,
  modelSelectionV2Schema,
  modelServiceCreateV2Schema,
  modelServiceCasV2Schema,
  modelServiceV2ReceiptSchema,
  modelServiceV2ListSchema,
} from '../packages/contracts/src/model-configuration-v2.js';

export const origin = 'http://127.0.0.1:5300';
export const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const localSelectionSchema = z.strictObject({
  schemaVersion: z.literal('ath.local-model-selection.v2'),
  selectionId: z.uuid(),
  ownerId: z.uuid(),
  imageId: imageIdSchema,
  selection: modelSelectionV2Schema.required({ effort: true }),
  selectedAt: z.iso.datetime(),
});
export const configurationPlanSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    schemaVersion: z.literal('ath.local-model-configuration-plan.v2'),
    operation: z.literal('select'),
    selectionId: z.uuid(),
    selection: modelSelectionV2Schema.required({ effort: true }),
  }),
  z.strictObject({
    schemaVersion: z.literal('ath.local-model-configuration-plan.v2'),
    operation: z.literal('configuration.model-create'),
    serviceId: z.uuid(),
    body: modelServiceCreateV2Schema,
  }),
  z.strictObject({
    schemaVersion: z.literal('ath.local-model-configuration-plan.v2'),
    operation: z.literal('configuration.model-credential-set'),
    serviceId: z.uuid(),
    body: modelServiceCasV2Schema,
  }),
]);
export const commandMarkerSchema = z.strictObject({
  schemaVersion: z.literal('ath.local-model-command.v2'),
  ownerId: z.uuid(),
  commandId: z.uuid(),
  serviceId: z.uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum([
    'configuration.model-create',
    'configuration.model-credential-set',
  ]),
});
export function requestDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
        .join(',')}}`;
    const result = JSON.stringify(item);
    if (result === undefined) throw new Error('INVALID_COMMAND_PAYLOAD');
    return result;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function operatorArguments(args: string[], allowed: readonly string[]) {
  const result: Record<string, string> = {};
  for (const arg of args) {
    if (arg === '--explicit-local-deployment') {
      if (result.explicit) throw new Error('INVALID_OPERATOR_ARGUMENTS');
      result.explicit = 'true';
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (
      !match?.[1] ||
      !match[2] ||
      !allowed.includes(match[1]) ||
      result[match[1]]
    )
      throw new Error('INVALID_OPERATOR_ARGUMENTS');
    result[match[1]] = match[2];
  }
  if (result.explicit !== 'true')
    throw new Error('EXPLICIT_LOCAL_OPERATOR_REQUIRED');
  return result;
}
export function privatePath(root: string, value: string) {
  if (!isAbsolute(root) || !isAbsolute(value))
    throw new Error('PRIVATE_PATH_REQUIRED');
  const scope = relative(resolve(root), resolve(value));
  if (!scope || scope.startsWith('..') || isAbsolute(scope))
    throw new Error('PRIVATE_PATH_REQUIRED');
  return resolve(value);
}
export async function readPrivateJson(root: string, path: string) {
  const file = privatePath(root, path),
    item = await lstat(file);
  if (!item.isFile() || item.isSymbolicLink() || item.size > 262144)
    throw new Error('INVALID_PRIVATE_OPERATOR_FILE');
  const bytes = await readFile(file);
  if (bytes.length > 262144) throw new Error('INVALID_PRIVATE_OPERATOR_FILE');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export async function writeNewJson(path: string, body: unknown) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(body, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}
export const runProcess = promisify(execFile);
export function dockerPath() {
  return join(
    process.env.LOCALAPPDATA ?? '',
    'Programs/DockerDesktop/resources/bin/docker.exe',
  );
}
export async function assertDeployedImage(
  expected: string,
  requireAiStopped = false,
) {
  imageIdSchema.parse(expected);
  for (const name of ['api-1', 'api-worker-1', 'api-worker-2', 'ai-worker-1']) {
    const { stdout } = await runProcess(
      dockerPath(),
      [
        'inspect',
        '--format',
        '{{.Image}} {{.State.Running}}',
        `aitesthub-local-${name}`,
      ],
      { windowsHide: true, maxBuffer: 4096 },
    );
    const [image, running] = stdout.trim().split(' ');
    if (
      image !== expected ||
      !['true', 'false'].includes(running ?? '') ||
      (name === 'api-1' && running !== 'true') ||
      (requireAiStopped && name === 'ai-worker-1' && running !== 'false')
    )
      throw new Error('EXACT_DEPLOYED_IMAGE_REQUIRED');
  }
}
export async function selectExactModel(
  request: (method: string, path: string, body?: unknown) => Promise<unknown>,
  selection: z.infer<typeof localSelectionSchema>['selection'],
) {
  const catalog = availableModelV2ListSchema.parse(
    await request('GET', '/model-services'),
  );
  const matches = catalog.models.filter(
    (model) =>
      model.modelServiceId === selection.modelServiceId &&
      model.modelEntryId === selection.modelEntryId &&
      model.serviceRevision === selection.serviceRevision,
  );
  const model = matches[0];
  if (
    matches.length !== 1 ||
    !model?.available ||
    !model.allowedDataScopes.includes('syntheticPublicOnly') ||
    (selection.effort !== null &&
      !model.effortValues.includes(selection.effort))
  )
    throw new Error('EXACT_MODEL_SELECTION_UNAVAILABLE');
  return model;
}
export async function readAdminModels(
  request: (method: string, path: string, body?: unknown) => Promise<unknown>,
) {
  return modelServiceV2ListSchema.parse(
    await request('GET', '/admin/model-services'),
  );
}
export function validateCommandReceipt(
  raw: unknown,
  marker: z.infer<typeof commandMarkerSchema>,
) {
  const receipt = modelConfigurationCommandV2Schema.parse(raw);
  if (
    receipt.commandId !== marker.commandId ||
    receipt.operation !== marker.operation
  )
    throw new Error('ORIGINAL_COMMAND_RECEIPT_MISMATCH');
  if (receipt.status !== 'succeeded' || !receipt.response)
    throw new Error('ORIGINAL_COMMAND_RESULT_UNKNOWN');
  const result = modelServiceV2ReceiptSchema.parse(receipt.response);
  if (result.modelService.id !== marker.serviceId)
    throw new Error('ORIGINAL_COMMAND_RECEIPT_MISMATCH');
  return result;
}
/** Persist before the sole write. Existing markers are read-only, even when the
 * previous process stopped before dispatch or the original GET returns 404. */
export async function dispatchOriginalCommand(input: {
  markerPath: string;
  marker: z.infer<typeof commandMarkerSchema>;
  dispatch: () => Promise<unknown>;
  lookup: () => Promise<unknown>;
}) {
  let exists = false;
  try {
    await writeNewJson(input.markerPath, input.marker);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
    exists = true;
  }
  if (exists) {
    const item = await lstat(input.markerPath);
    if (!item.isFile() || item.isSymbolicLink() || item.size > 4096)
      throw new Error('INVALID_ORIGINAL_COMMAND_MARKER');
    const previous = commandMarkerSchema.parse(
      JSON.parse(await readFile(input.markerPath, 'utf8')),
    );
    if (
      JSON.stringify(previous) !==
      JSON.stringify(commandMarkerSchema.parse(input.marker))
    )
      throw new Error('ORIGINAL_COMMAND_MARKER_MISMATCH');
    return validateCommandReceipt(await input.lookup(), previous);
  }
  try {
    await input.dispatch();
  } catch {
    /* Sole write is never repeated. */
  }
  return validateCommandReceipt(await input.lookup(), input.marker);
}
/** Fixed loopback HTTP. Password/session stay in RAM and are never returned. */
export async function localSession(root: string) {
  const item = await lstat(join(root, 'secrets', 'bootstrap-admin-password'));
  if (!item.isFile() || item.isSymbolicLink() || item.size > 16384)
    throw new Error('INVALID_LOCAL_AUTH_FILE');
  const password = (
    await readFile(join(root, 'secrets', 'bootstrap-admin-password'), 'utf8')
  ).trimEnd();
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'x-ath-csrf': '1',
    },
    body: JSON.stringify({ account: 'local-admin', password }),
  });
  const session = response.headers
    .get('set-cookie')
    ?.match(/(?:^|\s)ath_session=([^;]+)/)?.[1];
  if (!response.ok || !session) throw new Error('LOCAL_AUTHENTICATION_FAILED');
  const body = z
    .object({ user: z.object({ id: z.uuid() }) })
    .parse(await response.json());
  const request = async (method: string, path: string, payload?: unknown) => {
    if (!path.startsWith('/') || path.includes('://') || path.includes('..'))
      throw new Error('INVALID_LOCAL_API_PATH');
    const result = await fetch(`${origin}/api/v1${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Cookie: `ath_session=${session}`,
        'Content-Type': 'application/json',
        Origin: origin,
        'x-ath-csrf': '1',
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!result.ok) throw new Error(`LOCAL_HTTP_${result.status}`);
    return result.json() as Promise<unknown>;
  };
  return {
    ownerId: body.user.id,
    request,
    close: () => request('POST', '/auth/logout', {}),
  };
}
export async function commandDirectory(root: string, ownerId: string) {
  const directory = join(
    root,
    'setup',
    'model-v2',
    'commands',
    z.uuid().parse(ownerId),
  );
  await mkdir(directory, { recursive: true });
  return directory;
}
