CREATE TABLE app.agent_workspace_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  path text NOT NULL CHECK(length(path) BETWEEN 1 AND 512),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(conversation_id,path)
);
CREATE INDEX agent_workspace_owner_idx ON app.agent_workspace_entries(owner_id,conversation_id);
CREATE TABLE app.agent_workspace_versions (
  entry_id uuid NOT NULL REFERENCES app.agent_workspace_entries(id),
  revision integer NOT NULL CHECK(revision>0),
  resource_id uuid NOT NULL REFERENCES app.file_resources(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(entry_id,revision)
);
CREATE TRIGGER agent_workspace_versions_immutable BEFORE UPDATE OR DELETE ON app.agent_workspace_versions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.agent_workspace_commands (
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  command_id text NOT NULL CHECK(length(command_id) BETWEEN 8 AND 128),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(conversation_id,command_id)
);

CREATE FUNCTION app.redact_deleted_conversation_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_workspace_entries SET path='deleted/'||id::text,
      deleted_at=COALESCE(deleted_at,NEW.deleted_at),updated_at=NEW.deleted_at,
      row_version=row_version+1 WHERE conversation_id=NEW.id;
    UPDATE app.agent_workspace_commands SET response='{"deleted":true}'::jsonb
      WHERE conversation_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_workspace_conversation_privacy AFTER UPDATE OF deleted_at ON app.ai_conversations FOR EACH ROW EXECUTE FUNCTION app.redact_deleted_conversation_workspace();
