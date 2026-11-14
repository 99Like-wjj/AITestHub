CREATE TABLE app.retest_preparations (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES app.projects(id),name text NOT NULL,
 created_by uuid NOT NULL REFERENCES app.users(id),current_revision_id uuid,row_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,id)
);
CREATE TABLE app.retest_preparation_revisions (
 id uuid PRIMARY KEY,preparation_id uuid NOT NULL,project_id uuid NOT NULL,revision_no integer NOT NULL CHECK(revision_no>0),
 selection jsonb NOT NULL,missing_requirements jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(preparation_id,revision_no),UNIQUE(project_id,preparation_id,id),
 FOREIGN KEY(project_id,preparation_id) REFERENCES app.retest_preparations(project_id,id)
);
ALTER TABLE app.retest_preparations ADD CONSTRAINT retest_current_revision_fk FOREIGN KEY(project_id,id,current_revision_id)
 REFERENCES app.retest_preparation_revisions(project_id,preparation_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE app.retest_groups (
 id uuid PRIMARY KEY,project_id uuid NOT NULL,preparation_id uuid NOT NULL,preparation_revision_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('UI','API')),environment_id uuid NOT NULL,
 public_snapshot jsonb NOT NULL,internal_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,id),
 FOREIGN KEY(project_id,preparation_id,preparation_revision_id) REFERENCES app.retest_preparation_revisions(project_id,preparation_id,id),
 FOREIGN KEY(project_id,environment_id) REFERENCES app.test_configurations(project_id,id)
);
CREATE TABLE app.retest_group_issues (
 project_id uuid NOT NULL,group_id uuid NOT NULL,issue_id uuid NOT NULL,PRIMARY KEY(group_id,issue_id),
 FOREIGN KEY(project_id,group_id) REFERENCES app.retest_groups(project_id,id),FOREIGN KEY(project_id,issue_id) REFERENCES app.issues(project_id,id)
);
CREATE TABLE app.retest_group_runs (
 project_id uuid NOT NULL,group_id uuid NOT NULL,run_id uuid NOT NULL UNIQUE,PRIMARY KEY(group_id,run_id),
 FOREIGN KEY(project_id,group_id) REFERENCES app.retest_groups(project_id,id),FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id)
);
CREATE TRIGGER retest_revision_immutable BEFORE UPDATE OR DELETE ON app.retest_preparation_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER retest_groups_immutable BEFORE UPDATE OR DELETE ON app.retest_groups FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER retest_issue_links_immutable BEFORE UPDATE OR DELETE ON app.retest_group_issues FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER retest_run_links_immutable BEFORE UPDATE OR DELETE ON app.retest_group_runs FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
