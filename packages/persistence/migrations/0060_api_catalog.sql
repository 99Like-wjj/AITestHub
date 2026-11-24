CREATE TABLE app.api_catalog_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES app.projects(id),
  kind text NOT NULL CHECK (kind IN ('module', 'folder', 'interface')),
  parent_id uuid,
  parent_kind text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1000000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_revision_id uuid,
  revision_number integer NOT NULL DEFAULT 0,
  service_key text,
  method text,
  route_key text,
  archived_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (kind = 'module' AND parent_id IS NULL AND parent_kind IS NULL)
    OR (kind = 'folder' AND parent_id IS NOT NULL AND parent_kind IS NOT DISTINCT FROM 'module')
    OR (kind = 'interface' AND parent_id IS NOT NULL AND parent_kind IS NOT DISTINCT FROM 'folder')
  ),
  CHECK (
    (kind <> 'interface' AND current_revision_id IS NULL AND revision_number = 0
      AND service_key IS NULL AND method IS NULL AND route_key IS NULL)
    OR (kind = 'interface' AND current_revision_id IS NOT NULL AND revision_number > 0
      AND service_key IS NOT NULL AND method IS NOT NULL AND route_key IS NOT NULL)
  ),
  UNIQUE (project_id, id, kind),
  FOREIGN KEY (project_id, parent_id, parent_kind)
    REFERENCES app.api_catalog_nodes (project_id, id, kind)
);

CREATE INDEX api_catalog_parent_idx
  ON app.api_catalog_nodes (project_id, parent_id, position, title, id);
CREATE UNIQUE INDEX api_catalog_active_route_idx
  ON app.api_catalog_nodes (project_id, service_key, method, route_key)
  WHERE kind = 'interface' AND archived_at IS NULL;

CREATE TABLE app.api_interface_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  node_id uuid NOT NULL,
  node_kind text NOT NULL DEFAULT 'interface' CHECK (node_kind = 'interface'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, node_id, id),
  UNIQUE (project_id, node_id, revision_number),
  UNIQUE (project_id, node_id, id, revision_number),
  FOREIGN KEY (project_id, node_id, node_kind)
    REFERENCES app.api_catalog_nodes (project_id, id, kind)
);

ALTER TABLE app.api_catalog_nodes ADD CONSTRAINT api_catalog_current_revision_fk
  FOREIGN KEY (project_id, id, current_revision_id, revision_number)
  REFERENCES app.api_interface_revisions (project_id, node_id, id, revision_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER api_interface_revisions_immutable
  BEFORE UPDATE OR DELETE ON app.api_interface_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

