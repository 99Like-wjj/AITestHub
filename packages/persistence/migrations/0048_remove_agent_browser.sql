-- Retire the built-in office browser. Historical 0044/0046 bytes stay frozen.
-- The operator drains callers and closes the original runtimes before migration.
-- Capture identifiers before dropping their source tables, including on isolated restore.
CREATE TEMP TABLE removed_office_browser_tasks (
  task_id uuid PRIMARY KEY
) ON COMMIT DROP;
CREATE TEMP TABLE removed_office_browser_conversations (
  conversation_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO removed_office_browser_tasks(task_id)
SELECT task_id FROM app.agent_browser_operations WHERE task_id IS NOT NULL
UNION
SELECT task_id FROM app.ai_task_events
WHERE payload->>'name'='ath_browser'
UNION
SELECT t.id FROM app.ai_tasks t JOIN app.ai_messages m ON m.id=t.assistant_message_id
WHERE position('ath_browser' in m.content)>0 OR position('&browser=1' in m.content)>0;

INSERT INTO removed_office_browser_conversations(conversation_id)
SELECT conversation_id FROM app.agent_browser_sessions
UNION
SELECT t.conversation_id FROM app.ai_tasks t JOIN removed_office_browser_tasks r ON r.task_id=t.id
UNION
SELECT conversation_id FROM app.ai_runtime_checkpoints
WHERE position(convert_to('ath_browser','UTF8') in checkpoint)>0
UNION
SELECT conversation_id FROM app.ai_runtime_checkpoint_writes
WHERE position(convert_to('ath_browser','UTF8') in value)>0
UNION
SELECT conversation_id FROM app.agent_context_archives
WHERE position('ath_browser' in record::text)>0
UNION
SELECT conversation_id FROM app.agent_task_plans
WHERE position('ath_browser' in plan::text)>0;

-- Retain only minimal original execution facts, including manual operations with no AI task.
-- Closing the runtime does not prove a remote write did not occur. Never invent a terminal state.
INSERT INTO app.audit_events(actor_id,action,object_id,request_id,payload)
SELECT o.owner_id,'capability.office-browser-removed',o.id,o.command_id::text,
  jsonb_build_object('sessionId',o.session_id,'taskId',o.task_id,
    'originalState',o.state,'completedActions',o.completed_actions,
    'errorCode',o.error_code,'originalCreatedAt',o.created_at,
    'originalFinishedAt',o.finished_at,'payloadRemoved',true,'replayed',false)
FROM app.agent_browser_operations o;

-- Tool facts remain readable as historical data, without page content, action parameters or links.
UPDATE app.ai_task_events
SET payload=jsonb_strip_nulls(jsonb_build_object(
  'invocationId',payload->'invocationId','name','ath_browser',
  'state',payload->'state','unknownEffect',payload->'unknownEffect',
  'sourceRefs','[]'::jsonb))
WHERE event_type='ai.tool' AND payload->>'name'='ath_browser';

-- A browser task may have mixed generated prose: losing this derived test history is authorized.
-- Preserve user messages, task/attempt states, billing and unrelated tool/business receipts.
UPDATE app.ai_messages m SET content=''
FROM app.ai_tasks t JOIN removed_office_browser_tasks r ON r.task_id=t.id
WHERE m.id=t.assistant_message_id;
UPDATE app.ai_model_attempts a SET visible_text='',content_redacted_at=clock_timestamp()
FROM removed_office_browser_tasks r WHERE a.task_id=r.task_id;
UPDATE app.ai_task_events e
SET payload=(e.payload-'text'-'content'-'summary'-'observation'-'result'-'confirmationUrl')
  ||jsonb_build_object('text','')
FROM removed_office_browser_tasks r
WHERE e.task_id=r.task_id AND e.event_type IN ('ai.text','ai.summary','ai.segment');
UPDATE app.ai_task_events e
SET payload=(e.payload-'explanation'-'items')
  ||jsonb_build_object('items',(
    SELECT jsonb_agg(jsonb_build_object('id',item->'id',
      'step','[浏览器相关历史已移除]','status',item->'status'))
    FROM jsonb_array_elements(e.payload->'items') item
  ),'explanation',NULL)
FROM removed_office_browser_tasks r
WHERE e.task_id=r.task_id AND e.event_type='ai.progress';

-- Whole derived contexts are rebuildable; do not surgically leave orphaned tool calls/pending writes.
DELETE FROM app.ai_runtime_checkpoint_writes w USING removed_office_browser_conversations r
WHERE w.conversation_id=r.conversation_id;
DELETE FROM app.ai_runtime_checkpoints c USING removed_office_browser_conversations r
WHERE c.conversation_id=r.conversation_id;
DELETE FROM app.agent_context_archives a USING removed_office_browser_conversations r
WHERE a.conversation_id=r.conversation_id;
DELETE FROM app.agent_task_plans p USING removed_office_browser_conversations r
WHERE p.conversation_id=r.conversation_id;
DELETE FROM app.agent_retrieval_indexes i USING removed_office_browser_conversations r
WHERE i.source_kind='conversation' AND i.source_id=r.conversation_id;
UPDATE app.ai_conversations c SET context_revision=context_revision+1,source_fingerprints='{}'::jsonb
FROM removed_office_browser_conversations r WHERE c.id=r.conversation_id;

-- No shared parent table, file resource, platform credential or model ledger is deleted.
DROP TRIGGER redact_agent_browser ON app.ai_conversations;
DROP FUNCTION app.redact_agent_browser();
DROP TABLE app.agent_browser_operations;
DROP TABLE app.agent_browser_sessions;
