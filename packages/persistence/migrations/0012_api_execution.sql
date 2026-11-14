ALTER TABLE app.runs ADD COLUMN origin_key_id uuid REFERENCES app.personal_keys(id);
CREATE TABLE app.api_worker_instances (
  id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','stopped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.api_worker_grants (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES app.runs(id),
  worker_instance_id uuid NOT NULL REFERENCES app.api_worker_instances(id),
  grant_hash text NOT NULL UNIQUE CHECK(grant_hash ~ '^[a-f0-9]{64}$'),
  fence integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.api_step_attempts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  run_item_id uuid NOT NULL,
  phase text NOT NULL CHECK(phase IN ('auth','business','cleanupHttp','cleanupSql')),
  step_id text NOT NULL,
  worker_instance_id uuid NOT NULL REFERENCES app.api_worker_instances(id),
  fence integer NOT NULL,
  request_digest text NOT NULL,
  request_safe jsonb NOT NULL,
  send_intent_at timestamptz,
  state text NOT NULL CHECK(state IN ('intent','completed','unknown','failed','skipped')),
  outcome text CHECK(outcome IN ('passed','failed')),
  side_effect_certainty text NOT NULL DEFAULT 'notApplicable' CHECK(side_effect_certainty IN ('known','unknown','notApplicable')),
  response_safe jsonb,
  receipt_digest text,
  extractions_safe jsonb NOT NULL DEFAULT '{}'::jsonb,
  assertions_safe jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(run_item_id,phase,step_id),
  FOREIGN KEY(project_id,run_id,run_item_id) REFERENCES app.run_items(project_id,run_id,id)
);
CREATE INDEX api_step_attempts_run_idx ON app.api_step_attempts(run_id,created_at,id);
CREATE TABLE app.api_case_facts (
  run_item_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  original_outcome text CHECK(original_outcome IN ('passed','failed','notExecuted')),
  cleanup_state text NOT NULL DEFAULT 'notConfigured' CHECK(cleanup_state IN ('notConfigured','pending','running','succeeded','failed','skipped','interrupted')),
  side_effect_certainty text NOT NULL DEFAULT 'notApplicable' CHECK(side_effect_certainty IN ('known','unknown','notApplicable')),
  reason text NOT NULL DEFAULT '',
  permission_lost_at timestamptz,
  completion_digest text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  FOREIGN KEY(project_id,run_id,run_item_id) REFERENCES app.run_items(project_id,run_id,id)
);
CREATE TABLE app.api_auth_tokens (
  run_item_id uuid NOT NULL REFERENCES app.run_items(id),
  cache_key text NOT NULL,
  profile_id uuid NOT NULL REFERENCES app.test_configurations(id),
  secret_ref uuid NOT NULL REFERENCES app.secret_records(id),
  revoked_at timestamptz,
  PRIMARY KEY(run_item_id,cache_key)
);
CREATE TABLE app.api_protected_values (
  run_item_id uuid NOT NULL REFERENCES app.run_items(id),
  value_fingerprint text NOT NULL,
  secret_ref uuid NOT NULL REFERENCES app.secret_records(id),
  PRIMARY KEY(run_item_id,value_fingerprint)
);
CREATE TABLE app.api_tainted_variables (
  run_item_id uuid NOT NULL REFERENCES app.run_items(id),
  name text NOT NULL,
  secret_ref uuid NOT NULL REFERENCES app.secret_records(id),
  PRIMARY KEY(run_item_id,name)
);
CREATE TABLE app.api_run_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES app.runs(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER api_run_events_immutable BEFORE UPDATE OR DELETE ON app.api_run_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
