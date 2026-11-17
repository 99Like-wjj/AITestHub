import type { SqlExecutor } from '../../../persistence/src/database.js';

/** The privacy recovery path must not import file readers or initialize an encoder. */
export async function redactAgentRetrievalSource(
  tx: SqlExecutor,
  ownerId: string,
  kind: 'resource' | 'conversation',
  sourceId: string,
) {
  const present = (
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('app.agent_retrieval_indexes') IS NOT NULL present",
    )
  ).rows[0]?.present;
  if (present)
    await tx.query(
      'DELETE FROM app.agent_retrieval_indexes WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3',
      [ownerId, kind, sourceId],
    );
}
