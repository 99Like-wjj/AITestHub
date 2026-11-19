CREATE TABLE app.api_regression_qualifications (
  snapshot_id uuid PRIMARY KEY REFERENCES app.approval_snapshots(id),
  project_id uuid NOT NULL REFERENCES app.projects(id),
  debug_run_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(project_id,debug_run_id) REFERENCES app.runs(project_id,id)
);
CREATE TRIGGER api_regression_qualifications_immutable BEFORE UPDATE OR DELETE ON app.api_regression_qualifications
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.api_regression_withdrawals (
  snapshot_id uuid PRIMARY KEY REFERENCES app.approval_snapshots(id),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER api_regression_withdrawals_immutable BEFORE UPDATE OR DELETE ON app.api_regression_withdrawals
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
