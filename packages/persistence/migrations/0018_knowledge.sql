CREATE TABLE app.knowledge_spaces (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id)
);
CREATE TABLE app.knowledge_entries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  space_id uuid NOT NULL,
  current_revision_id uuid,
  revision_no integer NOT NULL DEFAULT 0 CHECK(revision_no>=0),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  deleted boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,space_id) REFERENCES app.knowledge_spaces(project_id,id)
);
CREATE INDEX knowledge_entries_index_idx ON app.knowledge_entries(project_id,space_id,deleted,id);
CREATE TABLE app.knowledge_revisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  deleted boolean NOT NULL DEFAULT false,
  restored_from_revision_id uuid,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(entry_id,revision_no),
  UNIQUE(project_id,entry_id,id),
  FOREIGN KEY(project_id,entry_id) REFERENCES app.knowledge_entries(project_id,id),
  FOREIGN KEY(project_id,entry_id,restored_from_revision_id) REFERENCES app.knowledge_revisions(project_id,entry_id,id)
);
ALTER TABLE app.knowledge_entries ADD CONSTRAINT knowledge_entries_current_revision_fk
  FOREIGN KEY(project_id,id,current_revision_id) REFERENCES app.knowledge_revisions(project_id,entry_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER knowledge_revisions_immutable BEFORE UPDATE OR DELETE ON app.knowledge_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.knowledge_comparisons (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  space_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,space_id) REFERENCES app.knowledge_spaces(project_id,id)
);
CREATE TRIGGER knowledge_comparisons_immutable BEFORE UPDATE OR DELETE ON app.knowledge_comparisons FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.knowledge_selections (
  id uuid PRIMARY KEY,
  comparison_id uuid NOT NULL REFERENCES app.knowledge_comparisons(id),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  selections jsonb NOT NULL CHECK(jsonb_typeof(selections)='array'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER knowledge_selections_immutable BEFORE UPDATE OR DELETE ON app.knowledge_selections FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
