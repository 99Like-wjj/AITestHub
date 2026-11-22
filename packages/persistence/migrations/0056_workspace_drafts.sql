CREATE TABLE app.ai_workspace_drafts (
  owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  draft_key text NOT NULL CHECK (length(draft_key) BETWEEN 12 AND 49),
  conversation_id uuid REFERENCES app.ai_conversations(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id,draft_key),
  CHECK ((conversation_id IS NULL AND draft_key LIKE 'new:%')
      OR (conversation_id IS NOT NULL AND draft_key = conversation_id::text))
);

CREATE INDEX ai_workspace_drafts_new_idx
  ON app.ai_workspace_drafts (owner_id,updated_at DESC,draft_key)
  WHERE conversation_id IS NULL;

CREATE FUNCTION app.delete_private_conversation_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM app.ai_workspace_drafts
  WHERE owner_id=NEW.owner_id AND draft_key=NEW.id::text;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_conversations_delete_draft
  AFTER UPDATE OF deleted_at ON app.ai_conversations
  FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.delete_private_conversation_draft();
