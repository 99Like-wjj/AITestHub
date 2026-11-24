CREATE TABLE app.api_database_reads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  configuration_id uuid NOT NULL,
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,configuration_id) REFERENCES app.test_configurations(project_id,id),
  CHECK(definition->>'connectionId'=configuration_id::text)
);
CREATE INDEX api_database_reads_project_idx ON app.api_database_reads(project_id,created_at,id);
CREATE TRIGGER api_database_reads_immutable BEFORE UPDATE OR DELETE ON app.api_database_reads
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
