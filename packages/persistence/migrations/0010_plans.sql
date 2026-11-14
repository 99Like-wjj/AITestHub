CREATE TABLE app.test_plans (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  kind text NOT NULL CHECK(kind IN ('UI','API')),
  current_revision_id uuid,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,kind,id)
);
CREATE TABLE app.plan_revisions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no>0),
  name text NOT NULL,
  environment_id uuid NOT NULL,
  product_build text,
  requirement_version_id uuid,
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)>0),
  ui_snapshot jsonb,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((kind='UI' AND requirement_version_id IS NOT NULL AND ui_snapshot IS NOT NULL) OR (kind='API' AND requirement_version_id IS NULL AND ui_snapshot IS NULL)),
  UNIQUE(plan_id,revision_no),
  UNIQUE(project_id,kind,plan_id,id),
  FOREIGN KEY(project_id,kind,plan_id) REFERENCES app.test_plans(project_id,kind,id),
  FOREIGN KEY(project_id,environment_id) REFERENCES app.test_configurations(project_id,id),
  FOREIGN KEY(project_id,requirement_version_id) REFERENCES app.requirement_versions(project_id,id)
);
ALTER TABLE app.test_plans ADD CONSTRAINT test_plans_current_revision_fk FOREIGN KEY(project_id,kind,id,current_revision_id)
  REFERENCES app.plan_revisions(project_id,kind,plan_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER plan_revisions_immutable BEFORE UPDATE OR DELETE ON app.plan_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.api_start_previews (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'API' CHECK(kind='API'),
  source text NOT NULL CHECK(source IN ('manual','debug')),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,kind,plan_id,plan_revision_id) REFERENCES app.plan_revisions(project_id,kind,plan_id,id)
);
CREATE TRIGGER api_start_previews_immutable BEFORE UPDATE OR DELETE ON app.api_start_previews
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.runs (
  id uuid PRIMARY KEY,
  run_snapshot_id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  kind text NOT NULL CHECK(kind IN ('UI','API')),
  source text NOT NULL CHECK(source IN ('manual','scheduled','debug','localUi','retest')),
  source_revision_id uuid NOT NULL,
  plan_id uuid REFERENCES app.test_plans(id),
  environment_id uuid NOT NULL,
  environment_revision_id uuid NOT NULL,
  product_build text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','queued','running','stopping','completed','terminated','interrupted','recoveryRequired')),
  delivery_status text NOT NULL DEFAULT 'notSubmitted' CHECK(delivery_status IN ('notSubmitted','receiving','incomplete','complete')),
  cleanup_state text NOT NULL DEFAULT 'notConfigured' CHECK(cleanup_state IN ('notConfigured','pending','running','succeeded','failed','skipped','interrupted')),
  scope_snapshot jsonb NOT NULL,
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  internal_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  stop_requested_at timestamptz,
  progress_closed_at timestamptz,
  progress_closed_by uuid REFERENCES app.users(id),
  local_execution_id text,
  last_progress_at timestamptz,
  progress_sequence bigint NOT NULL DEFAULT 0,
  started_at timestamptz,
  ended_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,environment_id) REFERENCES app.test_configurations(project_id,id)
);
CREATE INDEX runs_plan_active_idx ON app.runs(plan_id,state,created_at,id);
CREATE UNIQUE INDEX runs_ui_local_identity_idx ON app.runs(created_by,source_revision_id,local_execution_id) WHERE kind='UI' AND local_execution_id IS NOT NULL;
CREATE TABLE app.run_items (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  case_id uuid NOT NULL REFERENCES app.test_assets(id),
  -- Null is reserved for explicit debug drafts; formal plan starts always provide a real approval.
  approval_snapshot_id uuid REFERENCES app.approval_snapshots(id),
  snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','notExecuted','interrupted')),
  outcome text CHECK(outcome IN ('passed','failed','blocked','inconclusive','notExecuted')),
  cleanup_state text NOT NULL DEFAULT 'notConfigured' CHECK(cleanup_state IN ('notConfigured','pending','running','succeeded','failed','skipped','interrupted')),
  side_effect_certainty text NOT NULL DEFAULT 'notApplicable' CHECK(side_effect_certainty IN ('known','unknown','notApplicable')),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE(run_id,ordinal),
  UNIQUE(project_id,run_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE TABLE app.api_execution_requests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'API' CHECK(kind='API'),
  source text NOT NULL CHECK(source IN ('manual','scheduled','debug')),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  origin_key_id uuid REFERENCES app.personal_keys(id),
  selected_case_ids uuid[] NOT NULL CHECK(cardinality(selected_case_ids)>0),
  accepted_overlap jsonb NOT NULL DEFAULT '{"runIds":[],"requestIds":[]}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','started','notExecuted','cancelled')),
  run_id uuid UNIQUE REFERENCES app.runs(id),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  FOREIGN KEY(project_id,kind,plan_id,plan_revision_id) REFERENCES app.plan_revisions(project_id,kind,plan_id,id)
);
CREATE INDEX api_execution_requests_plan_idx ON app.api_execution_requests(plan_id,state,created_at,id);
