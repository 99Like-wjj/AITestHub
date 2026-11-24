CREATE TABLE app.api_shared_scripts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  current_revision_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, id)
);

CREATE TABLE app.api_shared_script_revisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  script_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 64000),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, script_id, revision_number),
  UNIQUE (project_id, script_id, id, revision_number),
  FOREIGN KEY (project_id, script_id) REFERENCES app.api_shared_scripts(project_id, id)
);

ALTER TABLE app.api_shared_scripts
  ADD CONSTRAINT api_shared_script_current_revision_fk
  FOREIGN KEY (project_id, id, current_revision_id, revision_number)
  REFERENCES app.api_shared_script_revisions(project_id, script_id, id, revision_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER api_shared_script_revisions_immutable
  BEFORE UPDATE OR DELETE ON app.api_shared_script_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
