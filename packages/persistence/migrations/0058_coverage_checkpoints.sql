CREATE TABLE app.coverage_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  requirement_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('UI', 'API')),
  scenario_id uuid,
  scenario_type text NOT NULL DEFAULT 'scenario' CHECK (scenario_type='scenario'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 4000),
  case_ids uuid[] NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, requirement_version_id)
    REFERENCES app.requirement_versions(project_id, id),
  FOREIGN KEY (project_id, kind, requirement_version_id, scenario_id, scenario_type)
    REFERENCES app.test_assets(project_id, kind, requirement_version_id, id, target_type)
);

CREATE INDEX coverage_checkpoints_scope_idx
  ON app.coverage_checkpoints(project_id, requirement_version_id, kind, created_at, id);
