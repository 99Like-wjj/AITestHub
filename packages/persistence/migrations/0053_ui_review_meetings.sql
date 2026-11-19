CREATE TABLE app.ui_review_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  requirement_version_id uuid NOT NULL,
  case_ids uuid[] NOT NULL CHECK (cardinality(case_ids) BETWEEN 1 AND 1000),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id,requirement_version_id) REFERENCES app.requirement_versions(project_id,id)
);
CREATE INDEX ui_review_meetings_scope_idx
  ON app.ui_review_meetings(project_id,requirement_version_id,created_at DESC,id);
CREATE INDEX ui_review_meetings_cases_idx
  ON app.ui_review_meetings USING GIN(case_ids);
