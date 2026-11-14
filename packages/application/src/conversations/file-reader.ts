import { TextDecoder } from 'node:util';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { FilesService } from '../files/service.js';
import type { PersonalFileReader } from './references.js';

/** Trusted task port; source ACL is rechecked by FilesService. No model-facing file/URL fetch tool. */
export class ConversationFileReader implements PersonalFileReader {
  constructor(readonly files: FilesService) {}
  async readText(actor: ActorContext, resourceId: string) {
    // The internal task acts for its recorded owner; this does not supply a new user identity.
    const source = await this.files.download(
      { ...actor, entrypoint: 'web' },
      resourceId,
    );
    if (
      ![
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json',
        'text/html',
      ].includes(source.file.mediaType)
    ) {
      source.body.destroy();
      return { text: null, state: 'unsupported' as const };
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      for await (const raw of source.body) {
        const chunk: unknown = raw;
        if (!(chunk instanceof Uint8Array) && typeof chunk !== 'string') {
          source.body.destroy();
          return { text: null, state: 'unsupported' as const };
        }
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        bytes += buffer.byteLength;
        text += decoder.decode(buffer, { stream: true });
        if (bytes > 1_048_576 || text.length > 100_000) {
          source.body.destroy();
          return { text: text.slice(0, 100_000), state: 'incomplete' as const };
        }
      }
      text += decoder.decode();
      // HTML is source text only. It is never executed, navigated or fetched.
      return { text, state: 'readable' as const };
    } catch {
      source.body.destroy();
      return { text: null, state: 'unsupported' as const };
    }
  }
}
