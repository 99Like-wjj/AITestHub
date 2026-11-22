CREATE TABLE app.ui_case_supplement_origins (
  case_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  requirement_version_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'UI' CHECK (kind='UI'),
  target_type text NOT NULL DEFAULT 'case' CHECK (target_type='case'),
  source_case_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  origin jsonb NOT NULL CHECK (jsonb_typeof(origin)='object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, kind, requirement_version_id, case_id, target_type)
    REFERENCES app.test_assets(project_id, kind, requirement_version_id, id, target_type),
  FOREIGN KEY (project_id, kind, requirement_version_id, source_case_id, target_type)
    REFERENCES app.test_assets(project_id, kind, requirement_version_id, id, target_type),
  FOREIGN KEY (project_id, kind, source_case_id, source_revision_id)
    REFERENCES app.asset_revisions(project_id, kind, asset_id, id),
  CHECK (case_id <> source_case_id)
);
CREATE TRIGGER ui_case_supplement_origins_immutable
  BEFORE UPDATE OR DELETE ON app.ui_case_supplement_origins
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
