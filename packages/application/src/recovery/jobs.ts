import { randomUUID } from 'node:crypto';
import type { Database } from '../../../persistence/src/database.js';
import type { ActorContext } from '../../../contracts/src/identity.js';
import { backupRequestSchema } from '../../../contracts/src/recovery.js';
import { requirePlatformAdmin } from '../access/policy.js';
import { OperationService } from '../operations/service.js';
import { audit } from '../events.js';

/** Control-plane metadata only: no archive key, object reader, dump tool or backup directory. */
export class BackupJobService {
  readonly operations: OperationService;
  constructor(readonly db: Database) {
    this.operations = new OperationService(db);
  }
  async request(actor: ActorContext, raw: unknown) {
    const input = backupRequestSchema.parse(raw);
    return this.operations.execute(
      actor,
      'operations.backup.request',
      input.commandId,
      input,
      (tx) => requirePlatformAdmin(tx, actor),
      async (tx) => {
        const id = randomUUID();
        await tx.query(
          "INSERT INTO app.product_backups(id,state,requested_by,requested_source) VALUES($1,'queued',$2,'manual')",
          [id, actor.userId],
        );
        await audit(tx, actor, 'operations.backup-requested', id);
        return { id, state: 'queued' as const };
      },
    );
  }
  async requestInternal(source: 'daily' | 'upgrade') {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO app.product_backups(id,state,requested_source) VALUES($1,'queued',$2)",
      [id, source],
    );
    return { id, state: 'queued' as const };
  }
}
