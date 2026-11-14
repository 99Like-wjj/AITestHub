import {
  missingFileTransfersInputSchema,
  missingFileTransfersSchema,
} from '../../../contracts/src/preparation.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import type { FilesService } from './service.js';
/** Exact IDs only. metadata enforces current actor/key/project/owner and hides missing or deleted resources. */
export async function missingFileTransfers(
  files: Pick<FilesService, 'metadata'>,
  actor: ActorContext,
  raw: unknown,
) {
  const input = missingFileTransfersInputSchema.parse(raw),
    items = [];
  for (const fileId of input.fileIds) {
    const file = (await files.metadata(actor, fileId)).file;
    items.push({
      fileId,
      status: file.status,
      verified: file.status === 'verified',
    });
  }
  const missingFileIds = items
    .filter((file) => !file.verified)
    .map((file) => file.fileId);
  return missingFileTransfersSchema.parse({
    files: items,
    missingFileIds,
    allVerified: missingFileIds.length === 0,
  });
}
