CREATE TABLE app.test_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES app.projects(id),
  kind text NOT NULL CHECK(kind IN ('environment','purpose','account','authProfile','binding','databaseConnection')),
  name text NOT NULL,
  active boolean NOT NULL,
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  environment_id uuid,
  purpose_id uuid,
  account_id uuid,
  auth_profile_id uuid,
  credential_ref uuid REFERENCES app.secret_records(id),
  current_revision_id uuid NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(content->>'kind'=kind AND content->>'name'=name AND (content->>'active')::boolean=active),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,environment_id) REFERENCES app.test_configurations(project_id,id),
  FOREIGN KEY(project_id,purpose_id) REFERENCES app.test_configurations(project_id,id),
  FOREIGN KEY(project_id,account_id) REFERENCES app.test_configurations(project_id,id),
  FOREIGN KEY(project_id,auth_profile_id) REFERENCES app.test_configurations(project_id,id),
  CHECK((kind='binding' AND environment_id IS NOT NULL AND purpose_id IS NOT NULL AND account_id IS NOT NULL)
     OR (kind='databaseConnection' AND environment_id IS NOT NULL AND purpose_id IS NULL AND account_id IS NULL AND auth_profile_id IS NULL)
     OR (kind NOT IN ('binding','databaseConnection') AND environment_id IS NULL AND purpose_id IS NULL AND account_id IS NULL AND auth_profile_id IS NULL))
);
CREATE UNIQUE INDEX test_binding_unique ON app.test_configurations(project_id,environment_id,purpose_id) WHERE kind='binding' AND active;
CREATE TABLE app.test_configuration_revisions (
  id uuid PRIMARY KEY,
  configuration_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  credential_ref uuid REFERENCES app.secret_records(id),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,configuration_id) REFERENCES app.test_configurations(project_id,id),
  UNIQUE(configuration_id,revision_no),
  UNIQUE(configuration_id,id)
);
ALTER TABLE app.test_configurations ADD CONSTRAINT test_configuration_current_revision_fk FOREIGN KEY(id,current_revision_id)
  REFERENCES app.test_configuration_revisions(configuration_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER test_configuration_revisions_immutable BEFORE UPDATE OR DELETE ON app.test_configuration_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
