CREATE TABLE app.api_schedules (
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES app.projects(id),plan_id uuid NOT NULL UNIQUE,kind text NOT NULL DEFAULT 'API' CHECK(kind='API'),
  current_revision_id uuid,created_by uuid NOT NULL REFERENCES app.users(id),copied_from_schedule_id uuid,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),status text NOT NULL CHECK(status IN ('active','paused','completed')),
  pause_reason text,next_point jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),FOREIGN KEY(project_id,kind,plan_id) REFERENCES app.test_plans(project_id,kind,id),
  FOREIGN KEY(project_id,copied_from_schedule_id) REFERENCES app.api_schedules(project_id,id)
);
CREATE TABLE app.schedule_revisions (
  id uuid PRIMARY KEY,schedule_id uuid NOT NULL,project_id uuid NOT NULL,kind text NOT NULL DEFAULT 'API' CHECK(kind='API'),
  plan_id uuid NOT NULL,plan_revision_id uuid NOT NULL,environment_id uuid NOT NULL,plan_name text NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no>0),rule jsonb NOT NULL,time_zone_rules_version text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(schedule_id,revision_no),UNIQUE(project_id,schedule_id,id),
  FOREIGN KEY(project_id,schedule_id) REFERENCES app.api_schedules(project_id,id),
  FOREIGN KEY(project_id,kind,plan_id,plan_revision_id) REFERENCES app.plan_revisions(project_id,kind,plan_id,id),
  FOREIGN KEY(project_id,environment_id) REFERENCES app.test_configurations(project_id,id)
);
ALTER TABLE app.api_schedules ADD CONSTRAINT schedule_current_revision_fk FOREIGN KEY(project_id,id,current_revision_id)
  REFERENCES app.schedule_revisions(project_id,schedule_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION app.validate_schedule_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_environment uuid;expected_plan uuid;
BEGIN
  SELECT environment_id,plan_id INTO expected_environment,expected_plan FROM app.plan_revisions WHERE id=NEW.plan_revision_id;
  IF expected_environment IS DISTINCT FROM NEW.environment_id OR expected_plan IS DISTINCT FROM NEW.plan_id
    OR NOT EXISTS(SELECT 1 FROM app.api_schedules WHERE id=NEW.schedule_id AND project_id=NEW.project_id AND plan_id=NEW.plan_id) THEN
    RAISE EXCEPTION 'Schedule must bind its own exact API plan revision and environment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_binding_guard BEFORE INSERT ON app.schedule_revisions FOR EACH ROW EXECUTE FUNCTION app.validate_schedule_binding();
CREATE TRIGGER schedule_revisions_immutable BEFORE UPDATE OR DELETE ON app.schedule_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.schedule_epochs (
  id uuid PRIMARY KEY,started_at timestamptz NOT NULL,ended_at timestamptz,instance_id uuid NOT NULL
);
CREATE TABLE app.schedule_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),epoch_id uuid NOT NULL REFERENCES app.schedule_epochs(id),
  booted_at timestamptz NOT NULL,last_heartbeat_at timestamptz NOT NULL,watermark_at timestamptz NOT NULL,recovery_cutoff_at timestamptz NOT NULL
);
CREATE TABLE app.schedule_occurrences (
  id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,project_id uuid NOT NULL,schedule_id uuid NOT NULL,schedule_revision_id uuid NOT NULL,
  wall_date date NOT NULL,wall_time time(0) NOT NULL,time_zone text NOT NULL,point jsonb NOT NULL,planned_at timestamptz,decision_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','started','completed','overlapSkipped','missedOffline','preconditionsMissing','creatorUnavailable','dstNonexistent','cancelled','expired')),
  reason_code text NOT NULL,details jsonb NOT NULL DEFAULT '{}'::jsonb,epoch_id uuid REFERENCES app.schedule_epochs(id),
  request_id uuid UNIQUE REFERENCES app.api_execution_requests(id),run_id uuid UNIQUE,completion_processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(schedule_id,wall_date,wall_time),UNIQUE(project_id,id),
  FOREIGN KEY(project_id,schedule_id,schedule_revision_id) REFERENCES app.schedule_revisions(project_id,schedule_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE INDEX schedule_due_idx ON app.api_schedules(status,((next_point->>'decisionAt')),id);
CREATE INDEX schedule_timeline_idx ON app.schedule_occurrences(schedule_id,decision_at DESC,id DESC);
CREATE INDEX schedule_request_idx ON app.schedule_occurrences(request_id) WHERE request_id IS NOT NULL;
CREATE TABLE app.schedule_occurrence_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,occurrence_id uuid NOT NULL REFERENCES app.schedule_occurrences(id),
  state text NOT NULL,reason_code text NOT NULL,details jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER schedule_occurrence_events_immutable BEFORE UPDATE OR DELETE ON app.schedule_occurrence_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE FUNCTION app.validate_schedule_occurrence_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.api_execution_requests q JOIN app.api_schedules s ON s.id=NEW.schedule_id
    WHERE q.id=NEW.request_id AND q.project_id=NEW.project_id AND q.plan_id=s.plan_id AND q.source='scheduled' AND q.actor_id=s.created_by
      AND (NEW.run_id IS NULL OR q.run_id=NEW.run_id)) THEN
    RAISE EXCEPTION 'Schedule occurrence execution request must retain project, source and creator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_request_guard BEFORE INSERT OR UPDATE OF request_id,run_id ON app.schedule_occurrences FOR EACH ROW EXECUTE FUNCTION app.validate_schedule_occurrence_request();
CREATE TABLE app.schedule_permission_events (
  event_id uuid PRIMARY KEY REFERENCES app.audit_events(id),processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER schedule_permission_events_immutable BEFORE UPDATE OR DELETE ON app.schedule_permission_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE FUNCTION app.validate_schedule_creator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.project_id,NEW.plan_id,NEW.created_by,NEW.copied_from_schedule_id) IS DISTINCT FROM (OLD.project_id,OLD.plan_id,OLD.created_by,OLD.copied_from_schedule_id) THEN
    RAISE EXCEPTION 'Schedule creator and source are immutable; explicitly copy a new plan' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.test_plans WHERE id=NEW.plan_id AND project_id=NEW.project_id AND kind='API' AND created_by=NEW.created_by) THEN
    RAISE EXCEPTION 'Schedule retains its API plan creator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_creator_guard BEFORE INSERT OR UPDATE OF project_id,plan_id,created_by,copied_from_schedule_id ON app.api_schedules FOR EACH ROW EXECUTE FUNCTION app.validate_schedule_creator();
