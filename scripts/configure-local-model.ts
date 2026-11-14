import { readFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { modelCredentialV2Schema } from '../packages/contracts/src/model-configuration-v2.js';
import {
  assertDeployedImage,
  commandDirectory,
  commandMarkerSchema,
  configurationPlanSchema,
  dispatchOriginalCommand,
  imageIdSchema,
  localSelectionSchema,
  localSession,
  operatorArguments,
  privatePath,
  readAdminModels,
  readPrivateJson,
  requestDigest,
  selectExactModel,
  validateCommandReceipt,
  writeNewJson,
} from './local-model-operator.js';

/** Explicit V2 operator. Commands stay separate; V1 setup files are immutable.
 * No application/DB services are imported from the mutable host dist. */
async function main() {
  const args = operatorArguments(process.argv.slice(2), [
    'plan',
    'image',
    'mode',
    'credential-file',
  ]);
  if (
    process.env.AITESTHUB_MAIN_MODEL_OPERATOR !==
    'explicit-local-model-operator'
  )
    throw new Error('EXPLICIT_LOCAL_OPERATOR_REQUIRED');
  const mode = z.enum(['dispatch', 'receipt']).parse(args.mode),
    image = imageIdSchema.parse(args.image),
    root = resolve(
      process.env.AITESTHUB_LOCAL_ROOT ??
        join(process.env.LOCALAPPDATA ?? '', 'AITestHub'),
    ),
    plan = configurationPlanSchema.parse(
      await readPrivateJson(root, z.string().parse(args.plan)),
    );
  if (
    plan.operation === 'configuration.model-create' &&
    plan.serviceId !== plan.body.id
  )
    throw new Error('STABLE_SERVICE_ID_MISMATCH');
  if (
    args['credential-file'] &&
    (plan.operation !== 'configuration.model-credential-set' ||
      mode !== 'dispatch')
  )
    throw new Error('UNEXPECTED_CREDENTIAL_FILE');
  await assertDeployedImage(image);
  const session = await localSession(root);
  try {
    // A matching image alone does not imply V2. This strict current-HTTP gate
    // rejects Main34 before any model configuration write, including Key writes.
    const current = await readAdminModels(session.request);
    if (plan.operation === 'select') {
      if (mode !== 'dispatch') throw new Error('SELECT_HAS_NO_COMMAND_RECEIPT');
      await selectExactModel(session.request, plan.selection);
      const directory = join(root, 'setup', 'model-v2', 'selections');
      await mkdir(directory, { recursive: true });
      const selectionPath = join(directory, `${plan.selectionId}.json`);
      await writeNewJson(
        selectionPath,
        localSelectionSchema.parse({
          schemaVersion: 'ath.local-model-selection.v2',
          selectionId: plan.selectionId,
          ownerId: session.ownerId,
          imageId: image,
          selection: plan.selection,
          selectedAt: new Date().toISOString(),
        }),
      );
      process.stdout.write(
        JSON.stringify({
          selectionPath,
          selection: plan.selection,
          additionalProviderCalls: 0,
        }) + '\n',
      );
      return;
    }
    const marker = commandMarkerSchema.parse({
        schemaVersion: 'ath.local-model-command.v2',
        ownerId: session.ownerId,
        commandId: plan.body.commandId,
        operation: plan.operation,
        serviceId: plan.serviceId,
        requestDigest: requestDigest({
          operation: plan.operation,
          serviceId: plan.serviceId,
          body: plan.body,
        }),
      }),
      directory = await commandDirectory(root, session.ownerId),
      markerPath = join(directory, `${marker.commandId}.json`),
      lookup = () =>
        session.request(
          'GET',
          `/admin/model-services/commands/${marker.commandId}`,
        );
    let result;
    if (mode === 'receipt') {
      const previous = commandMarkerSchema.parse(
        await readPrivateJson(root, markerPath),
      );
      if (JSON.stringify(previous) !== JSON.stringify(marker))
        throw new Error('ORIGINAL_COMMAND_MARKER_MISMATCH');
      result = validateCommandReceipt(await lookup(), previous);
    } else {
      result = await dispatchOriginalCommand({
        markerPath,
        marker,
        lookup,
        dispatch: async () => {
          if (plan.operation === 'configuration.model-create') {
            if (
              current.services.some((service) => service.id === plan.serviceId)
            )
              throw new Error('STABLE_SERVICE_ALREADY_EXISTS');
            return session.request('POST', '/admin/model-services', plan.body);
          }
          const exact = current.services.filter(
            (service) => service.id === plan.serviceId,
          );
          if (
            exact.length !== 1 ||
            exact[0]?.removedAt !== null ||
            exact[0].rowVersion !== plan.body.rowVersion
          )
            throw new Error('EXACT_SERVICE_BASELINE_UNAVAILABLE');
          const path = privatePath(
              join(root, 'secrets'),
              z.string().parse(args['credential-file']),
            ),
            item = await lstat(path);
          if (!item.isFile() || item.isSymbolicLink() || item.size > 16384)
            throw new Error('INVALID_MODEL_CREDENTIAL_FILE');
          const credential = (await readFile(path, 'utf8')).trimEnd();
          return session.request(
            'PUT',
            `/admin/model-services/${plan.serviceId}/credential`,
            modelCredentialV2Schema.parse({ ...plan.body, credential }),
          );
        },
      });
    }
    process.stdout.write(
      JSON.stringify({
        commandId: marker.commandId,
        operation: marker.operation,
        modelServiceId: result.modelService.id,
        serviceRevision: result.modelService.serviceRevision,
        rowVersion: result.modelService.rowVersion,
        credentialStoredEncrypted: result.modelService.hasCredential,
        additionalProviderCalls: 0,
        originalCommandOnly: true,
      }) + '\n',
    );
  } finally {
    await session.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    process.stderr.write('LOCAL_MODEL_OPERATOR_INCOMPLETE_OR_UNKNOWN\n');
    process.exitCode = 1;
  });
