ALTER TABLE app.requirement_versions ADD CONSTRAINT requirement_version_owner_unique UNIQUE(project_id,requirement_id,id);
ALTER TABLE app.run_evidence ADD CONSTRAINT run_evidence_project_identity_unique UNIQUE(project_id,id);
CREATE TABLE app.problem_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.projects(id),
  requirement_id uuid NOT NULL, requirement_version_id uuid,
  run_id uuid NOT NULL, source_result_id uuid REFERENCES app.results(id), source_result_revision_id uuid REFERENCES app.result_revisions(id),
  title text NOT NULL, description text NOT NULL, suggested_severity text NOT NULL CHECK(suggested_severity IN ('severe','normal','minor')),
  source text NOT NULL CHECK(source IN ('uiResult','apiResult','extraFinding')),
  state text NOT NULL DEFAULT 'pendingConfirmation' CHECK(state IN ('pendingConfirmation','confirmed','dismissed')),
  created_by uuid NOT NULL REFERENCES app.users(id), row_version integer NOT NULL DEFAULT 1, decision_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id),
  FOREIGN KEY(project_id,requirement_id,requirement_version_id) REFERENCES app.requirement_versions(project_id,requirement_id,id),
  FOREIGN KEY(project_id,source_result_id) REFERENCES app.results(project_id,id),
  FOREIGN KEY(source_result_id,source_result_revision_id) REFERENCES app.result_revisions(result_id,id),
  CHECK((source_result_id IS NULL)=(source_result_revision_id IS NULL)),
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE UNIQUE INDEX problem_source_result_unique ON app.problem_candidates(source_result_id) WHERE source_result_id IS NOT NULL;
CREATE TABLE app.issue_sequences(project_id uuid PRIMARY KEY REFERENCES app.projects(id), next_number bigint NOT NULL);
CREATE TABLE app.issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES app.projects(id), number bigint NOT NULL,
  requirement_id uuid NOT NULL, requirement_version_id uuid, title text NOT NULL, description text NOT NULL,
  severity text NOT NULL CHECK(severity IN ('severe','normal','minor')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','inProgress','awaitingRetest','closed')),
  assignee_id uuid REFERENCES app.users(id), merged_into_id uuid,
  source text NOT NULL CHECK(source IN ('manualTester','manualProduct','confirmedProblem')),
  submitted_by uuid NOT NULL REFERENCES app.users(id), row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id), UNIQUE(project_id,number),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id),
  FOREIGN KEY(project_id,requirement_id,requirement_version_id) REFERENCES app.requirement_versions(project_id,requirement_id,id),
  FOREIGN KEY(project_id,assignee_id) REFERENCES app.project_members(project_id,user_id),
  FOREIGN KEY(project_id,merged_into_id) REFERENCES app.issues(project_id,id),
  CHECK(merged_into_id IS NULL OR merged_into_id<>id)
);
CREATE TABLE app.issue_problem_links(project_id uuid NOT NULL,issue_id uuid NOT NULL,problem_id uuid NOT NULL UNIQUE,PRIMARY KEY(issue_id,problem_id),FOREIGN KEY(project_id,issue_id) REFERENCES app.issues(project_id,id),FOREIGN KEY(project_id,problem_id) REFERENCES app.problem_candidates(project_id,id));
CREATE TABLE app.issue_result_links(project_id uuid NOT NULL,issue_id uuid NOT NULL,result_id uuid NOT NULL,source_revision_id uuid NOT NULL,PRIMARY KEY(issue_id,result_id),FOREIGN KEY(project_id,issue_id) REFERENCES app.issues(project_id,id),FOREIGN KEY(project_id,result_id) REFERENCES app.results(project_id,id),FOREIGN KEY(result_id,source_revision_id) REFERENCES app.result_revisions(result_id,id));
CREATE TABLE app.problem_result_links(project_id uuid NOT NULL,problem_id uuid NOT NULL,result_id uuid NOT NULL,source_revision_id uuid NOT NULL,PRIMARY KEY(problem_id,result_id),FOREIGN KEY(project_id,problem_id) REFERENCES app.problem_candidates(project_id,id),FOREIGN KEY(project_id,result_id) REFERENCES app.results(project_id,id),FOREIGN KEY(result_id,source_revision_id) REFERENCES app.result_revisions(result_id,id));
CREATE TABLE app.problem_evidence_links(project_id uuid NOT NULL,problem_id uuid NOT NULL,evidence_id uuid NOT NULL,PRIMARY KEY(problem_id,evidence_id),FOREIGN KEY(project_id,problem_id) REFERENCES app.problem_candidates(project_id,id),FOREIGN KEY(project_id,evidence_id) REFERENCES app.run_evidence(project_id,id));
CREATE TABLE app.issue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),issue_id uuid NOT NULL REFERENCES app.issues(id), action text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app.users(id),previous_owner_id uuid REFERENCES app.users(id),new_owner_id uuid REFERENCES app.users(id),
  payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.issue_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,issue_id uuid NOT NULL,method text NOT NULL CHECK(method IN ('manual','UI','API')),
  outcome text NOT NULL CHECK(outcome IN ('passed','failed','inconclusive','notExecuted')),
  run_id uuid REFERENCES app.runs(id),note text NOT NULL,attachment_file_ids uuid[] NOT NULL DEFAULT '{}',
  actor_id uuid NOT NULL REFERENCES app.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,issue_id) REFERENCES app.issues(project_id,id),FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE UNIQUE INDEX issue_verification_run_unique ON app.issue_verifications(issue_id,run_id) WHERE run_id IS NOT NULL;
CREATE TABLE app.issue_lifecycle_previews (
  id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES app.projects(id),actor_id uuid NOT NULL REFERENCES app.users(id),
  action text NOT NULL CHECK(action IN ('close','reopen')),scope_digest text NOT NULL,items jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.issue_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES app.projects(id),master_id uuid NOT NULL REFERENCES app.issues(id),
  source_id uuid NOT NULL REFERENCES app.issues(id),source_before jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES app.users(id),
  row_version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),undone_at timestamptz,undone_by uuid REFERENCES app.users(id),
  FOREIGN KEY(project_id,master_id) REFERENCES app.issues(project_id,id),FOREIGN KEY(project_id,source_id) REFERENCES app.issues(project_id,id)
);
CREATE TRIGGER issue_events_immutable BEFORE UPDATE OR DELETE ON app.issue_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER issue_verifications_immutable BEFORE UPDATE OR DELETE ON app.issue_verifications FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER issue_problem_links_immutable BEFORE UPDATE OR DELETE ON app.issue_problem_links FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER issue_result_links_immutable BEFORE UPDATE OR DELETE ON app.issue_result_links FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER problem_evidence_links_immutable BEFORE UPDATE OR DELETE ON app.problem_evidence_links FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER problem_result_links_immutable BEFORE UPDATE OR DELETE ON app.problem_result_links FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
