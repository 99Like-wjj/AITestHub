ALTER TABLE app.runs ADD COLUMN execution_provenance text NOT NULL DEFAULT 'unknown'
  CHECK(execution_provenance IN ('local-ai','protocol-synthetic','unknown','platform-api'));
ALTER TABLE app.runs ADD COLUMN completed_items integer NOT NULL DEFAULT 0 CHECK(completed_items>=0);
ALTER TABLE app.file_resources ADD COLUMN run_id uuid;
ALTER TABLE app.file_resources ADD CONSTRAINT file_resources_run_project_fk FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id);
CREATE TABLE app.ui_progress_events (
  run_id uuid NOT NULL REFERENCES app.runs(id),
  sequence bigint NOT NULL CHECK(sequence>0),
  semantic_digest text NOT NULL,
  payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,sequence)
);
CREATE TABLE app.result_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES app.runs(id),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  submission_id text NOT NULL,
  semantic_digest text NOT NULL,
  payload jsonb NOT NULL,
  receipt jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,submission_id)
);
CREATE TABLE app.results (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  run_item_id uuid NOT NULL UNIQUE,
  local_result_id text NOT NULL,
  current_revision_id uuid NOT NULL,
  current_assessment_revision_id uuid,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  UNIQUE(run_id,local_result_id),
  FOREIGN KEY(project_id,run_id,run_item_id) REFERENCES app.run_items(project_id,run_id,id)
);
CREATE TABLE app.result_revisions (
  id uuid PRIMARY KEY,
  result_id uuid NOT NULL REFERENCES app.results(id),
  revision_no integer NOT NULL CHECK(revision_no>0),
  amendment_id text,
  content jsonb NOT NULL,
  semantic_digest text NOT NULL,
  reason text,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(result_id,revision_no),
  UNIQUE(result_id,id)
);
ALTER TABLE app.results ADD CONSTRAINT results_current_revision_fk FOREIGN KEY(id,current_revision_id)
  REFERENCES app.result_revisions(result_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE app.result_assessments (
  id uuid PRIMARY KEY,
  result_id uuid NOT NULL REFERENCES app.results(id),
  result_revision_id uuid NOT NULL,
  base_revision_id uuid,
  final_outcome text NOT NULL CHECK(final_outcome IN ('passed','failed','blocked','inconclusive','notExecuted')),
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(result_id,id)
  ,FOREIGN KEY(result_id,result_revision_id) REFERENCES app.result_revisions(result_id,id)
);
ALTER TABLE app.results ADD CONSTRAINT results_current_assessment_fk FOREIGN KEY(id,current_assessment_revision_id)
  REFERENCES app.result_assessments(result_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE app.run_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES app.runs(id),
  project_id uuid NOT NULL,
  local_evidence_id text NOT NULL,
  file_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,local_evidence_id),
  UNIQUE(run_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id),
  FOREIGN KEY(project_id,file_id) REFERENCES app.file_resources(project_id,id)
);
CREATE TABLE app.result_evidence_links (
  result_id uuid NOT NULL REFERENCES app.results(id),
  evidence_id uuid NOT NULL REFERENCES app.run_evidence(id),
  source text NOT NULL CHECK(source IN ('original','manualAddition')),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(result_id,evidence_id)
);
CREATE TABLE app.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  current_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE TABLE app.report_revisions (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES app.reports(id),
  revision_no integer NOT NULL CHECK(revision_no>0),
  reason text NOT NULL,
  facts jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(report_id,revision_no),
  UNIQUE(report_id,id)
);
ALTER TABLE app.reports ADD CONSTRAINT reports_current_revision_fk FOREIGN KEY(id,current_revision_id)
  REFERENCES app.report_revisions(report_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER ui_progress_events_immutable BEFORE UPDATE OR DELETE ON app.ui_progress_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER result_submissions_immutable BEFORE UPDATE OR DELETE ON app.result_submissions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER result_revisions_immutable BEFORE UPDATE OR DELETE ON app.result_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER result_assessments_immutable BEFORE UPDATE OR DELETE ON app.result_assessments FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER run_evidence_immutable BEFORE UPDATE OR DELETE ON app.run_evidence FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER result_evidence_links_immutable BEFORE UPDATE OR DELETE ON app.result_evidence_links FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER report_revisions_immutable BEFORE UPDATE OR DELETE ON app.report_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
