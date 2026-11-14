import type { ActorContext } from '../../contracts/src/identity.js';
import type { SqlExecutor } from '../../persistence/src/database.js';

/** Safe metadata only. Passwords, reset handles and key values are never event payloads. */
export async function audit(
  sql: SqlExecutor,
  actor: ActorContext,
  action: string,
  objectId: string,
  projectId: string | null = null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sql.query(
    `INSERT INTO app.audit_events(actor_id,project_id,action,object_id,request_id,payload)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      actor.userId,
      projectId,
      action,
      objectId,
      actor.requestId,
      JSON.stringify(payload),
    ],
  );
  await sql.query(
    `INSERT INTO app.outbox(actor_id,project_id,event_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5)`,
    [actor.userId, projectId, action, objectId, JSON.stringify(payload)],
  );
  if (
    action.startsWith('identity.') ||
    action === 'project.created' ||
    action === 'project.member-updated' ||
    action === 'project.member-removed' ||
    action === 'privacy.deleted' ||
    action === 'configuration.model-updated' ||
    action === 'configuration.auxiliary-updated' ||
    action === 'test-configuration.saved' ||
    action === 'test-configuration.credential-replaced'
  )
    sql.noteSecurityControlChange?.({ action, objectId, projectId });
}
