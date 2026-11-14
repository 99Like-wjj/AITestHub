ALTER TABLE app.run_items ALTER COLUMN case_id DROP NOT NULL;
CREATE TABLE app.api_debug_drafts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  run_id uuid NOT NULL UNIQUE,
  source_case_id uuid REFERENCES app.test_assets(id),
  source_case_revision_id uuid REFERENCES app.asset_revisions(id),
  scenario_revision_id uuid NOT NULL REFERENCES app.asset_revisions(id),
  draft_hash text NOT NULL CHECK(draft_hash ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL,
  cleanup_approval_snapshot_id uuid REFERENCES app.approval_snapshots(id),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
  FOREIGN KEY(project_id,run_id) REFERENCES app.runs(project_id,id),
  CHECK(source_case_id IS NOT NULL OR source_case_revision_id IS NULL)
);
CREATE TRIGGER api_debug_drafts_no_rewrite BEFORE UPDATE ON app.api_debug_drafts
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE FUNCTION app.validate_run_item_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_source text; scope_schema text;
BEGIN
  SELECT source,scope_snapshot->>'schemaVersion' INTO run_source,scope_schema FROM app.runs WHERE id=NEW.run_id;
  IF scope_schema='ath.debug-execution-scope.v1' THEN
    IF run_source<>'debug' OR NEW.approval_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'Debug drafts cannot claim formal approval' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.case_id IS NULL OR NEW.approval_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Formal scopes require real case and approval identities' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_items_origin_guard BEFORE INSERT OR UPDATE OF case_id,approval_snapshot_id,run_id ON app.run_items
  FOR EACH ROW EXECUTE FUNCTION app.validate_run_item_origin();
