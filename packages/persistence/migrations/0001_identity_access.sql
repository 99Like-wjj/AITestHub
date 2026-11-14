-- F08/F02/F03: additive schema, no reset, automatic synchronization or default users.
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL UNIQUE,
  display_account text NOT NULL DEFAULT '',
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (account = lower(btrim(account)) AND length(account) BETWEEN 1 AND 128),
  CHECK (length(display_name) BETWEEN 1 AND 128)
);

CREATE TABLE app.sessions (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES app.users(id),
  credential_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sessions_user_idx ON app.sessions(user_id);
CREATE INDEX sessions_expiry_idx ON app.sessions(expires_at);

CREATE TABLE app.personal_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  prefix text NOT NULL DEFAULT '',
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  allowed_scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(allowed_scope) = 'object'),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX personal_keys_user_idx ON app.personal_keys(user_id, created_at, id);

CREATE TABLE app.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.project_members (
  project_id uuid NOT NULL REFERENCES app.projects(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  is_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  roles text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (roles <@ ARRAY['tester', 'developer', 'product']::text[] AND array_position(roles, NULL) IS NULL),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id, user_id)
);
CREATE INDEX project_members_user_idx ON app.project_members(user_id, active, project_id);

CREATE TABLE app.password_resets (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES app.users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX password_resets_user_idx ON app.password_resets(user_id);

CREATE TABLE app.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  operation text NOT NULL DEFAULT '',
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'unknown')),
  project_id uuid REFERENCES app.projects(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id, operation, key)
);
CREATE INDEX commands_actor_idx ON app.commands(actor_id, created_at, id);

CREATE TABLE app.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  project_id uuid REFERENCES app.projects(id),
  actor_id uuid REFERENCES app.users(id),
  aggregate_id uuid,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_project_seq_idx ON app.outbox(project_id, seq);

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id uuid REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  action text NOT NULL,
  object_id uuid,
  request_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_project_seq_idx ON app.audit_events(project_id, seq);

CREATE FUNCTION app.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable history cannot be updated or deleted' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER outbox_immutable BEFORE UPDATE OR DELETE ON app.outbox
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
