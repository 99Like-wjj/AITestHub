CREATE TABLE app.file_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope text NOT NULL CHECK (owner_scope IN ('personal','project')),
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  local_file_id text NOT NULL CHECK (length(local_file_id) BETWEEN 1 AND 200),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 512),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
  declared_bytes bigint NOT NULL CHECK (declared_bytes BETWEEN 0 AND 104857600),
  declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','verified','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  storage_key text,
  upload_expires_at timestamptz,
  verified_at timestamptz,
  deleted_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((owner_scope='personal' AND project_id IS NULL) OR (owner_scope='project' AND project_id IS NOT NULL)),
  CHECK (status <> 'verified' OR (storage_key IS NOT NULL AND verified_at IS NOT NULL)),
  UNIQUE(project_id,id)
);
CREATE UNIQUE INDEX file_resources_registration_idx ON app.file_resources
  (owner_user_id,owner_scope,COALESCE(project_id,'00000000-0000-0000-0000-000000000000'::uuid),local_file_id);
CREATE INDEX file_resources_project_idx ON app.file_resources(project_id,status,created_at,id);
CREATE INDEX file_resources_owner_idx ON app.file_resources(owner_user_id,owner_scope,created_at,id);

CREATE TABLE app.file_upload_attempts (
  resource_id uuid NOT NULL REFERENCES app.file_resources(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('uploading','verified','failed','interrupted')),
  bytes_received bigint NOT NULL DEFAULT 0 CHECK (bytes_received>=0),
  sha256 text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY(resource_id,attempt)
);

CREATE TABLE app.resource_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES app.file_resources(id),
  project_id uuid REFERENCES app.projects(id),
  reference_type text NOT NULL CHECK (reference_type IN ('requirementVersion','evidence','knowledge','report','conversation')),
  reference_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(resource_id,reference_type,reference_id),
  FOREIGN KEY(project_id,resource_id) REFERENCES app.file_resources(project_id,id)
);
CREATE INDEX resource_references_target_idx ON app.resource_references(reference_type,reference_id);
