-- Keep the shared single-dispatch authorization ledger and historical outcomes.
-- The retired page has no executable compatibility route after this migration.
ALTER TABLE app.business_confirmations
  ADD COLUMN proposal_revision integer NOT NULL DEFAULT 1 CHECK(proposal_revision>0),
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '15 minutes'),
  ADD COLUMN interaction_kind text NOT NULL DEFAULT 'legacy' CHECK(interaction_kind IN ('legacy','inlineCard','mcpForm')),
  ADD COLUMN message_id uuid REFERENCES app.ai_messages(id),
  ADD COLUMN presentation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(presentation)='object'),
  ADD COLUMN replacement_key text;
UPDATE app.business_confirmations c SET message_id=t.assistant_message_id
FROM app.ai_tasks t WHERE t.id=c.task_id AND t.owner_id=c.owner_id AND t.conversation_id=c.conversation_id;
-- Existing waiting proposals expire without being treated as accepted, declined or executed.
UPDATE app.business_confirmations SET expires_at=LEAST(created_at,clock_timestamp())
WHERE state='waitingConfirmation';
CREATE INDEX action_intents_conversation_message_idx
  ON app.business_confirmations(owner_id,conversation_id,message_id,created_at,id);
CREATE INDEX action_intents_replacement_idx
  ON app.business_confirmations(owner_id,conversation_id,replacement_key) WHERE state='waitingConfirmation';
