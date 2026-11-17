CREATE TABLE app.agent_calculation_runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  task_id uuid NOT NULL REFERENCES app.ai_tasks(id),
  command_id text NOT NULL CHECK(length(command_id) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('prepared','running','publishing','completed','execution_failed','cancelled','artifact_conflict','unknown')),
  request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  source_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_snapshot)='array'),
  sandbox_result jsonb,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(artifacts)='array'),
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(owner_id,command_id),
  UNIQUE(owner_id,task_id,request_digest)
);
CREATE INDEX agent_calculation_conversation ON app.agent_calculation_runs(owner_id,conversation_id,created_at,id);
CREATE FUNCTION app.redact_agent_calculation_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_calculation_runs
    SET state='cancelled',request='{}'::jsonb,source_snapshot='[]'::jsonb,sandbox_result=NULL,
        artifacts='[]'::jsonb,cancel_requested=true,error_code='CONVERSATION_DELETED',finished_at=clock_timestamp()
    WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER redact_agent_calculation_runs AFTER UPDATE OF deleted_at ON app.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION app.redact_agent_calculation_runs();
