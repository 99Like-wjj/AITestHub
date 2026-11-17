import type { SqlExecutor } from '../../../persistence/src/database.js';

async function inlineSchema(tx: SqlExecutor) {
  return Boolean(
    (
      await tx.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='business_confirmations' AND column_name='expires_at') present",
      )
    ).rows[0]?.present,
  );
}

/** Restoration invalidates pending authority without inventing a human cancel or replay. */
export async function detachRestoredActionIntents(tx: SqlExecutor) {
  if (await inlineSchema(tx)) {
    await tx.query(`UPDATE app.business_confirmations SET
      state=CASE WHEN state='executing' THEN 'unknown' ELSE state END,
      expires_at=LEAST(expires_at,clock_timestamp()),
      resolved_at=CASE WHEN state='executing' THEN COALESCE(resolved_at,clock_timestamp()) ELSE resolved_at END
      WHERE state IN ('waitingConfirmation','executing')`);
  } else {
    await tx.query(
      "UPDATE app.business_confirmations SET state=CASE WHEN state='waitingConfirmation' THEN 'declined' ELSE 'unknown' END,resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE state IN ('waitingConfirmation','executing')",
    );
  }
}

/** Card captions/diffs contain private source information, just like the original proposal. */
export async function redactActionIntentPresentation(
  tx: SqlExecutor,
  conversationId: string,
  ownerId: string,
) {
  if (await inlineSchema(tx))
    await tx.query(
      "UPDATE app.business_confirmations SET presentation='{}'::jsonb WHERE conversation_id=$1 AND owner_id=$2",
      [conversationId, ownerId],
    );
}
