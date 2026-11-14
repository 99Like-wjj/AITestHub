import type { SqlExecutor } from '../../../persistence/src/database.js';

/** C5 replay hook: erase private copies, retain only identifiers/digests and dispatch facts. */
export async function redactExternalPrivacyDerivatives(
  tx: SqlExecutor,
  ownerId: string,
  deletedResourceIds: readonly string[] = [],
): Promise<void> {
  if (
    !(
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('app.external_mcp_invocations') IS NOT NULL present",
      )
    ).rows[0]?.present
  )
    return;
  const redacted = await tx.query<{
    id: string;
    state: string;
    tool_sends: number;
    actor_id: string;
  }>(
    `WITH RECURSIVE affected(id) AS (
    SELECT i.id FROM app.external_mcp_invocations i
    LEFT JOIN app.ai_conversations c ON c.id=i.conversation_id
    LEFT JOIN app.ai_tasks t ON t.id=i.task_id
    LEFT JOIN app.ai_messages u ON u.id=t.user_message_id LEFT JOIN app.ai_messages a ON a.id=t.assistant_message_id
    WHERE i.actor_id=$1 AND (c.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL OR a.deleted_at IS NOT NULL
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(i.source_refs) s WHERE
        (s->'reference'->>'kind'='resource' AND s->'reference'->>'resourceId'=ANY($2::text[]))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s->'resourceIds','[]')) r WHERE r=ANY($2::text[]))
        OR (s->'reference'->>'kind'='conversation' AND (
          EXISTS(SELECT 1 FROM app.ai_conversations sc WHERE sc.id::text=s->'reference'->>'conversationId' AND sc.owner_id=$1 AND sc.deleted_at IS NOT NULL)
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s->'messageIds','[]')) m JOIN app.ai_messages sm ON sm.id::text=m JOIN app.ai_conversations mc ON mc.id=sm.conversation_id WHERE mc.owner_id=$1 AND sm.deleted_at IS NOT NULL)
        ))))
    UNION
    SELECT i.id FROM app.external_mcp_invocations i CROSS JOIN LATERAL jsonb_array_elements(i.source_refs) s JOIN affected parent ON s->'reference'->>'kind'='externalMcpInvocation' AND s->'reference'->>'invocationId'=parent.id::text WHERE i.actor_id=$1
  ) UPDATE app.external_mcp_invocations i SET arguments=NULL,result=NULL,purpose='',source_refs='[]',
    state=CASE WHEN i.state='waitingConsent' OR (i.state='dispatching' AND i.tool_sends=0) THEN 'cancelled' WHEN i.state='dispatching' THEN 'unknown' ELSE i.state END,
    error_code=COALESCE(i.error_code,'PRIVACY_CONTENT_REDACTED'),updated_at=clock_timestamp()
    FROM affected WHERE i.id=affected.id AND (i.arguments IS NOT NULL OR i.result IS NOT NULL OR i.purpose<>'' OR i.source_refs<>'[]'::jsonb)
    RETURNING i.id,i.state,i.tool_sends,i.actor_id`,
    [ownerId, [...deletedResourceIds]],
  );
  for (const row of redacted.rows)
    await tx.query(
      "INSERT INTO app.external_mcp_invocation_events(invocation_id,state,code,tool_sends,actor_id) VALUES($1,$2,'PRIVACY_CONTENT_REDACTED',$3,$4)",
      [row.id, row.state, row.tool_sends, row.actor_id],
    );
}
