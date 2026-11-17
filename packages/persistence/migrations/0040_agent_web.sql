CREATE TABLE app.agent_web_receipts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  task_id uuid NOT NULL REFERENCES app.ai_tasks(id),
  request_digest text NOT NULL CHECK (length(request_digest)=64),
  kind text NOT NULL CHECK (kind IN ('search','read')),
  state text NOT NULL CHECK (state IN ('dispatching','completed','failed','unknown')),
  request jsonb NOT NULL,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(owner_id,task_id,kind,request_digest)
);
CREATE INDEX agent_web_receipts_conversation ON app.agent_web_receipts(owner_id,conversation_id,created_at);
CREATE FUNCTION app.redact_agent_web_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM app.agent_web_receipts WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER redact_agent_web_receipts AFTER UPDATE OF deleted_at ON app.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION app.redact_agent_web_receipts();
