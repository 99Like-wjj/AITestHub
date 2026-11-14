CREATE TABLE app.ai_conversation_preferences (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  default_target text NOT NULL DEFAULT 'personal' CHECK(default_target IN ('personal','lastRequirement')),
  last_project_id uuid REFERENCES app.projects(id),
  last_requirement_id uuid REFERENCES app.requirements(id),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0)
);
CREATE TABLE app.ai_requirement_groups (
  owner_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  alias text,
  pinned_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order>=0),
  expanded boolean NOT NULL DEFAULT true,
  hidden boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  PRIMARY KEY(owner_id,requirement_id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id)
);
CREATE TABLE app.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  requirement_id uuid,
  default_title text NOT NULL CHECK(length(default_title) BETWEEN 1 AND 200),
  alias text,
  pinned_at timestamptz,
  archived_at timestamptz,
  archive_source text CHECK(archive_source IN ('manual','group')),
  deleted_at timestamptz,
  context_revision integer NOT NULL DEFAULT 1 CHECK(context_revision>0),
  source_fingerprints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(source_fingerprints)='object'),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id),
  CHECK((project_id IS NULL AND requirement_id IS NULL) OR (project_id IS NOT NULL AND requirement_id IS NOT NULL))
);
CREATE INDEX ai_conversations_owner_idx ON app.ai_conversations(owner_id,updated_at DESC,id);
CREATE TABLE app.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL CHECK(status IN ('queued','streaming','completed','failed','cancelled','interrupted','deleted')),
  model_service_id uuid REFERENCES app.model_services(id),
  model_config_revision integer,
  effort text,
  model_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  explicit_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(explicit_refs)='array'),
  operation_target jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_messages_conversation_idx ON app.ai_messages(conversation_id,created_at,id);
CREATE TABLE app.ai_worker_instances (
  id uuid PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz
);
CREATE TABLE app.ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  user_message_id uuid NOT NULL UNIQUE REFERENCES app.ai_messages(id),
  assistant_message_id uuid NOT NULL UNIQUE REFERENCES app.ai_messages(id),
  model_selection jsonb NOT NULL,
  operation_target jsonb,
  data_scope text NOT NULL CHECK(data_scope='syntheticPublicOnly'),
  state text NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','running','cancelling','completed','failed','cancelled','interrupted','unknown')),
  worker_id uuid REFERENCES app.ai_worker_instances(id),
  fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),
  cancel_requested_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX ai_tasks_active_conversation_idx ON app.ai_tasks(conversation_id) WHERE state IN ('accepted','running','cancelling');
CREATE INDEX ai_tasks_queue_idx ON app.ai_tasks(state,created_at,id);
CREATE TABLE app.ai_task_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES app.ai_tasks(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_task_events_task_idx ON app.ai_task_events(task_id,sequence);
CREATE TABLE app.model_call_ledger (
  id uuid PRIMARY KEY,
  initiator_user_id uuid REFERENCES app.users(id),
  source text NOT NULL CHECK(source IN ('chat','auxiliary','background')),
  task_id uuid REFERENCES app.ai_tasks(id),
  model_service_id uuid NOT NULL REFERENCES app.model_services(id),
  model_config_revision integer NOT NULL,
  model_id text NOT NULL,
  effort text,
  provider_request_id text,
  client_request_id text,
  status text NOT NULL CHECK(status IN ('dispatchIntent','completed','failed','unknown')),
  input_tokens numeric(30,0), output_tokens numeric(30,0), total_tokens numeric(30,0), cached_input_tokens numeric(30,0), reasoning_output_tokens numeric(30,0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0), CHECK(total_tokens IS NULL OR total_tokens>=0)
);
CREATE UNIQUE INDEX model_call_provider_idx ON app.model_call_ledger(model_service_id,provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX model_call_user_idx ON app.model_call_ledger(initiator_user_id,started_at,id);
CREATE TABLE app.ai_deletion_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES app.users(id),
  target_type text NOT NULL CHECK(target_type IN ('conversation','resource')), target_id uuid NOT NULL,
  row_version integer NOT NULL, scope_digest text NOT NULL, payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE app.privacy_deletion_events (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.users(id),
  target_type text NOT NULL CHECK(target_type IN ('conversation','resource')), target_id uuid NOT NULL,
  exclusive_resource_ids uuid[] NOT NULL, occurred_at timestamptz NOT NULL,
  control_version integer NOT NULL DEFAULT 1 CHECK(control_version=1)
);
CREATE TRIGGER privacy_deletion_events_immutable BEFORE UPDATE OR DELETE ON app.privacy_deletion_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.privacy_deletion_replication (
  event_id uuid PRIMARY KEY REFERENCES app.privacy_deletion_events(id),
  state text NOT NULL CHECK(state IN ('pending','recorded')), recorded_at timestamptz
);
CREATE TABLE app.privacy_resource_gc (
  resource_id uuid PRIMARY KEY REFERENCES app.file_resources(id), event_id uuid NOT NULL REFERENCES app.privacy_deletion_events(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed')), attempts integer NOT NULL DEFAULT 0,
  last_error_code text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
