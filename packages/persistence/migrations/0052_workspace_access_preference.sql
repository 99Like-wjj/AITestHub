ALTER TABLE app.ai_conversation_preferences
  ADD COLUMN workspace_access_mode text
    CHECK (workspace_access_mode IN ('full', 'restricted')),
  ADD COLUMN workspace_access_version integer NOT NULL DEFAULT 0
    CHECK (workspace_access_version >= 0),
  ADD CONSTRAINT ai_conversation_preferences_access_version_check
    CHECK ((workspace_access_mode IS NULL) = (workspace_access_version = 0));
