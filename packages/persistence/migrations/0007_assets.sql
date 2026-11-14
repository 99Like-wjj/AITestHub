CREATE TABLE app.test_assets (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('UI','API')),
  requirement_version_id uuid NOT NULL,
  set_id uuid NOT NULL,
  set_type text NOT NULL DEFAULT 'set' CHECK(set_type='set'),
  target_type text NOT NULL CHECK(target_type IN ('set','scenario','case')),
  parent_id uuid,
  parent_type text,
  current_revision_id uuid,
  revision_no integer NOT NULL DEFAULT 0 CHECK(revision_no>=0),
  review_state text NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','needsOptimization','aiOptimized','approved')),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  removed_at timestamptz,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((target_type='set' AND id=set_id AND parent_id IS NULL AND parent_type IS NULL)
    OR (target_type='scenario' AND parent_id=set_id AND parent_type='set')
    OR (target_type='case' AND parent_id IS NOT NULL AND parent_type='scenario')),
  UNIQUE(project_id,kind,requirement_version_id,set_id,id,target_type),
  UNIQUE(project_id,kind,requirement_version_id,id,target_type),
  UNIQUE(project_id,kind,set_id,id),
  FOREIGN KEY(project_id,requirement_version_id) REFERENCES app.requirement_versions(project_id,id),
  FOREIGN KEY(project_id,kind,requirement_version_id,set_id,set_type)
    REFERENCES app.test_assets(project_id,kind,requirement_version_id,id,target_type) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,kind,requirement_version_id,set_id,parent_id,parent_type)
    REFERENCES app.test_assets(project_id,kind,requirement_version_id,set_id,id,target_type)
);
CREATE INDEX test_assets_scope_idx ON app.test_assets(project_id,kind,requirement_version_id,set_id,target_type,created_at,id);
CREATE TABLE app.asset_revisions (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  requirement_version_id uuid NOT NULL,
  set_id uuid NOT NULL,
  target_type text NOT NULL,
  revision_no integer NOT NULL CHECK(revision_no>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(asset_id,revision_no),
  UNIQUE(project_id,kind,set_id,asset_id,id),
  UNIQUE(project_id,kind,asset_id,id),
  FOREIGN KEY(project_id,kind,requirement_version_id,set_id,asset_id,target_type)
    REFERENCES app.test_assets(project_id,kind,requirement_version_id,set_id,id,target_type)
);
ALTER TABLE app.test_assets ADD CONSTRAINT test_assets_current_revision_fk
  FOREIGN KEY(project_id,kind,set_id,id,current_revision_id) REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER asset_revisions_immutable BEFORE UPDATE OR DELETE ON app.asset_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.review_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL,
  set_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_by uuid REFERENCES app.users(id),
  removed_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  UNIQUE(project_id,kind,set_id,asset_id,id),
  FOREIGN KEY(project_id,kind,set_id,asset_id,revision_id) REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id)
);
CREATE INDEX review_opinions_target_idx ON app.review_opinions(asset_id,revision_id,removed_at);
CREATE TABLE app.optimization_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL,
  set_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  opinion_id uuid NOT NULL,
  note text NOT NULL CHECK(length(note) BETWEEN 1 AND 10000),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,kind,set_id,asset_id,opinion_id) REFERENCES app.review_opinions(project_id,kind,set_id,asset_id,id)
);
CREATE TRIGGER optimization_notes_immutable BEFORE UPDATE OR DELETE ON app.optimization_notes
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.asset_context_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  kind text NOT NULL,
  set_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  approved_by uuid NOT NULL REFERENCES app.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,kind,set_id,asset_id,revision_id) REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id)
);
CREATE TRIGGER asset_context_approvals_immutable BEFORE UPDATE OR DELETE ON app.asset_context_approvals
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.approval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  set_id uuid NOT NULL,
  case_id uuid NOT NULL,
  case_revision_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  scenario_revision_id uuid NOT NULL,
  set_revision_id uuid NOT NULL,
  opinion_context_digest text NOT NULL CHECK(opinion_context_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  approved_by uuid NOT NULL REFERENCES app.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,kind,set_id,case_id,case_revision_id) REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id),
  FOREIGN KEY(project_id,kind,set_id,scenario_id,scenario_revision_id) REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id),
  FOREIGN KEY(project_id,kind,set_id,set_revision_id) REFERENCES app.asset_revisions(project_id,kind,asset_id,id)
);
CREATE INDEX approval_snapshots_latest_idx ON app.approval_snapshots(project_id,kind,case_id,approval_sequence DESC);
CREATE TRIGGER approval_snapshots_immutable BEFORE UPDATE OR DELETE ON app.approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.approval_previews (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid NOT NULL REFERENCES app.projects(id),
  kind text NOT NULL CHECK(kind IN ('UI','API')),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER approval_previews_immutable BEFORE UPDATE OR DELETE ON app.approval_previews
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
