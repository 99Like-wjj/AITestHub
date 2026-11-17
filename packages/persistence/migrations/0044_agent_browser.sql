CREATE TABLE app.agent_browser_sessions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  state text NOT NULL CHECK(state IN ('open','closed','unknown')),
  control text NOT NULL DEFAULT 'agent' CHECK(control IN ('agent','human')),
  private_state boolean NOT NULL DEFAULT false,
  row_version integer NOT NULL DEFAULT 1,
  observation_id uuid,
  observation_hash text,
  document_id uuid,
  current_url text,
  cleanup_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_browser_active_conversation ON app.agent_browser_sessions(owner_id,conversation_id) WHERE state IN ('open','unknown');
CREATE TABLE app.agent_browser_operations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  session_id uuid NOT NULL REFERENCES app.agent_browser_sessions(id),
  task_id uuid REFERENCES app.ai_tasks(id),
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('navigate','plan','human','control')),
  plan jsonb,
  request_digest text NOT NULL CHECK(length(request_digest)=64),
  state text NOT NULL CHECK(state IN ('waitingConfirmation','dispatching','completed','failed','unknown','rejected','cancelled')),
  row_version integer NOT NULL DEFAULT 1,
  error_code text,
  completed_actions integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(owner_id,command_id)
);
CREATE INDEX agent_browser_operations_session ON app.agent_browser_operations(session_id,created_at);
CREATE FUNCTION app.redact_agent_browser() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_browser_operations SET plan=NULL,state=CASE WHEN state='dispatching' THEN 'unknown' ELSE 'cancelled' END,error_code='CONVERSATION_DELETED',row_version=row_version+1
      WHERE session_id IN(SELECT id FROM app.agent_browser_sessions WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id);
    UPDATE app.agent_browser_sessions SET state='closed',cleanup_pending=true,current_url=NULL,observation_id=NULL,observation_hash=NULL,document_id=NULL,row_version=row_version+1,updated_at=now() WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER redact_agent_browser AFTER UPDATE OF deleted_at ON app.ai_conversations FOR EACH ROW EXECUTE FUNCTION app.redact_agent_browser();
