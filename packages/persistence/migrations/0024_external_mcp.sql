-- F04/A03: manually registered remote destinations, personal credentials and single-dispatch external calls.
CREATE TABLE app.external_mcp_services (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  endpoint text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  access_policy text NOT NULL CHECK(access_policy IN ('restricted','allActive')),
  protocol_mode text NOT NULL CHECK(protocol_mode IN ('auto','modern','legacy')),
  approved_tools jsonb NOT NULL CHECK(jsonb_typeof(approved_tools)='array'),
  config_revision integer NOT NULL DEFAULT 1 CHECK(config_revision>0),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.external_mcp_grants (
  service_id uuid NOT NULL REFERENCES app.external_mcp_services(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  PRIMARY KEY(service_id,user_id)
);
CREATE TABLE app.external_mcp_service_revisions (
  service_id uuid NOT NULL REFERENCES app.external_mcp_services(id),
  revision integer NOT NULL CHECK(revision>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(service_id,revision)
);
CREATE TRIGGER external_mcp_service_revisions_immutable BEFORE UPDATE OR DELETE ON app.external_mcp_service_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.external_mcp_connections (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES app.external_mcp_services(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  credential_ref uuid REFERENCES app.secret_records(id),
  credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  status text NOT NULL CHECK(status IN ('unverified','ready','authRequired','revoked')),
  current_catalog_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(service_id,user_id),UNIQUE(id,user_id),UNIQUE(id,service_id)
);
CREATE TABLE app.external_mcp_catalogs (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES app.external_mcp_connections(id),
  config_revision integer NOT NULL CHECK(config_revision>0),
  credential_version integer NOT NULL CHECK(credential_version>0),
  tools jsonb NOT NULL CHECK(jsonb_typeof(tools)='array'),
  catalog_digest text NOT NULL CHECK(catalog_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,connection_id)
);
ALTER TABLE app.external_mcp_connections ADD CONSTRAINT external_mcp_current_catalog_fk
  FOREIGN KEY(current_catalog_id,id) REFERENCES app.external_mcp_catalogs(id,connection_id);
CREATE TRIGGER external_mcp_catalogs_immutable BEFORE UPDATE OR DELETE ON app.external_mcp_catalogs
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.external_mcp_invocations (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  connection_id uuid NOT NULL,
  service_id uuid NOT NULL,
  project_id uuid REFERENCES app.projects(id),
  operation_target jsonb CHECK(operation_target IS NULL OR jsonb_typeof(operation_target)='object'),
  task_id uuid REFERENCES app.ai_tasks(id),
  conversation_id uuid REFERENCES app.ai_conversations(id),
  command_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  catalog_id uuid NOT NULL,
  config_revision integer NOT NULL CHECK(config_revision>0),
  credential_version integer NOT NULL CHECK(credential_version>0),
  destination_name text NOT NULL,
  endpoint text NOT NULL,
  tool_name text NOT NULL,
  tool_digest text NOT NULL CHECK(tool_digest ~ '^[a-f0-9]{64}$'),
  project_action text,
  arguments jsonb CHECK(arguments IS NULL OR jsonb_typeof(arguments)='object'),
  purpose text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_refs)='array'),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('waitingConsent','dispatching','completed','declined','cancelled','failed','unknown')),
  result jsonb,
  error_code text,
  decided_by uuid REFERENCES app.users(id),
  decided_at timestamptz,
  dispatch_claim uuid,
  dispatch_deadline timestamptz,
  tool_sends integer NOT NULL DEFAULT 0 CHECK(tool_sends BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,command_id),
  FOREIGN KEY(connection_id,actor_id) REFERENCES app.external_mcp_connections(id,user_id),
  FOREIGN KEY(connection_id,service_id) REFERENCES app.external_mcp_connections(id,service_id),
  FOREIGN KEY(catalog_id,connection_id) REFERENCES app.external_mcp_catalogs(id,connection_id),
  CHECK((state IN ('dispatching','completed') AND decided_by=actor_id AND decided_at IS NOT NULL AND dispatch_claim IS NOT NULL) OR state NOT IN ('dispatching','completed')),
  CHECK(tool_sends=0 OR dispatch_claim IS NOT NULL)
  ,CHECK((task_id IS NULL)=(conversation_id IS NULL))
  ,CHECK(operation_target IS NULL OR (project_id IS NOT NULL AND operation_target->>'projectId'=project_id::text))
);
CREATE INDEX external_mcp_invocations_task_idx ON app.external_mcp_invocations(actor_id,task_id,created_at);
-- Minimal no-replay tombstones are also exported to the latest authenticated control ledger.
-- They deliberately do not require an old backup to contain the original owner/task/catalog.
CREATE TABLE app.external_mcp_dispatch_fences (
  actor_id uuid NOT NULL,
  command_id uuid NOT NULL,
  invocation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,command_id),UNIQUE(invocation_id)
);
CREATE TRIGGER external_mcp_dispatch_fences_immutable BEFORE UPDATE OR DELETE ON app.external_mcp_dispatch_fences
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.external_mcp_invocation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invocation_id uuid NOT NULL REFERENCES app.external_mcp_invocations(id),
  state text NOT NULL,
  code text,
  tool_sends integer NOT NULL CHECK(tool_sends BETWEEN 0 AND 1),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER external_mcp_invocation_events_immutable BEFORE UPDATE OR DELETE ON app.external_mcp_invocation_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
