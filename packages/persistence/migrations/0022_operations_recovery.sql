CREATE TABLE app.recovery_control_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),platform_id uuid NOT NULL DEFAULT gen_random_uuid(),
  control_sequence bigint NOT NULL DEFAULT 0 CHECK(control_sequence>=0),state_digest text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app.recovery_control_state(singleton) VALUES(true);
CREATE TABLE app.recovery_control_commits (
  id uuid PRIMARY KEY,platform_id uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),state_digest text NOT NULL CHECK(state_digest~'^[a-f0-9]{64}$'),
  changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(platform_id,sequence)
);
CREATE TRIGGER recovery_control_commits_immutable BEFORE UPDATE OR DELETE ON app.recovery_control_commits FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.recovery_operation_fences (
  actor_id uuid NOT NULL,operation text NOT NULL,key text NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  command_id uuid NOT NULL,project_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,operation,key)
);
CREATE TRIGGER recovery_operation_fences_immutable BEFORE UPDATE OR DELETE ON app.recovery_operation_fences FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.recovery_dispatch_fences (
  id uuid PRIMARY KEY,namespace text NOT NULL CHECK(namespace IN ('api','model','auxiliary')),
  actor_id uuid,project_id uuid,source_id uuid NOT NULL,run_item_id uuid,phase text,step_id text,
  request_hash text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX recovery_api_dispatch_unique ON app.recovery_dispatch_fences(run_item_id,phase,step_id) WHERE namespace='api';
CREATE INDEX recovery_dispatch_source_idx ON app.recovery_dispatch_fences(namespace,source_id);
CREATE TRIGGER recovery_dispatch_fences_immutable BEFORE UPDATE OR DELETE ON app.recovery_dispatch_fences FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.maintenance_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),operation_id uuid,
  phase text NOT NULL DEFAULT 'idle' CHECK(phase IN ('idle','draining','snapshot','restoreQuarantine','readOnly')),
  reason text NOT NULL DEFAULT '',started_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app.maintenance_state(singleton) VALUES(true);
CREATE TABLE app.operations_request_leases (
  id uuid PRIMARY KEY,instance_id uuid NOT NULL,resource_id uuid,kind text NOT NULL CHECK(kind IN ('request','existingWork')),
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operations_request_expiry_idx ON app.operations_request_leases(expires_at);
CREATE TABLE app.operations_worker_instances (
  id uuid PRIMARY KEY,heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),stopped_at timestamptz
);
CREATE TABLE app.product_backups (
  id uuid PRIMARY KEY,state text NOT NULL CHECK(state IN ('queued','preparing','complete','failed','expired')),
  requested_by uuid REFERENCES app.users(id),requested_source text NOT NULL CHECK(requested_source IN ('manual','daily','upgrade')),
  control_sequence bigint,control_digest text,manifest_digest text,object_count integer,total_bytes bigint,error_code text,
  claimed_by uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,expires_at timestamptz
);
CREATE TABLE app.product_restore_checks (
  id uuid PRIMARY KEY,backup_id uuid NOT NULL,state text NOT NULL CHECK(state IN ('isolated','verifying','verified','quarantined','failed')),
  control_sequence bigint,checked_objects integer NOT NULL DEFAULT 0,details jsonb NOT NULL DEFAULT '{}'::jsonb,error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz
);
CREATE TABLE app.operations_capacity_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,location text NOT NULL CHECK(location IN ('runtime','backups','objects')),
  available_bytes bigint,total_bytes bigint,captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),error_code text
);
CREATE INDEX operations_capacity_location_idx ON app.operations_capacity_samples(location,captured_at DESC);
CREATE TABLE app.operations_file_gc (
  id uuid PRIMARY KEY,resource_id uuid NOT NULL REFERENCES app.file_resources(id),storage_key text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('privacyDeletion','temporaryUnreferenced','uploadAttempt')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','deleting','completed','failed','retainedShared')),
  delete_intent_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(resource_id,storage_key)
);
