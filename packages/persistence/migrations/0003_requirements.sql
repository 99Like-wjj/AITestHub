CREATE TABLE app.requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES app.projects(id),
  business_number text,
  title text NOT NULL,
  lifecycle text NOT NULL DEFAULT 'inProgress' CHECK(lifecycle IN ('inProgress','paused','completed','terminated')),
  archived_at timestamptz,
  business_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id)
);
CREATE UNIQUE INDEX requirements_number_unique ON app.requirements(project_id,business_number) WHERE business_number IS NOT NULL;
CREATE INDEX requirements_project_idx ON app.requirements(project_id,business_updated_at DESC,id);
CREATE TABLE app.requirement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version_no integer NOT NULL CHECK(version_no>0),
  summary text NOT NULL,
  material_set_digest text NOT NULL CHECK(material_set_digest ~ '^[a-f0-9]{64}$'),
  materials jsonb NOT NULL CHECK(jsonb_typeof(materials)='array'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id),
  UNIQUE(requirement_id,version_no),
  UNIQUE(project_id,id)
);
CREATE TRIGGER requirement_versions_immutable BEFORE UPDATE OR DELETE ON app.requirement_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.requirement_participants (
  requirement_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  added_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(requirement_id,user_id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES app.requirements(project_id,id),
  FOREIGN KEY(project_id,user_id) REFERENCES app.project_members(project_id,user_id)
);
