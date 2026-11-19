ALTER TABLE app.runs DROP CONSTRAINT runs_source_check;
ALTER TABLE app.runs ADD CONSTRAINT runs_source_check
  CHECK(source IN ('manual','scheduled','debug','localUi','retest','uiArchive'));
ALTER TABLE app.runs ADD CONSTRAINT runs_archive_identity_shape CHECK(
  source <> 'uiArchive' OR (kind = 'UI' AND plan_id IS NULL AND source_revision_id = id
    AND local_execution_id IS NOT NULL AND scope_snapshot->>'sourceType' = 'uiArchive')
);
CREATE UNIQUE INDEX runs_archive_local_identity_idx
  ON app.runs(project_id,created_by,local_execution_id) WHERE source = 'uiArchive';

CREATE OR REPLACE FUNCTION app.validate_run_item_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_source text; scope_schema text;
BEGIN
  SELECT source,scope_snapshot->>'schemaVersion'
    INTO run_source,scope_schema FROM app.runs WHERE id=NEW.run_id;
  IF scope_schema='ath.ui-archive-scope.v1' THEN
    IF run_source IS DISTINCT FROM 'uiArchive' OR NEW.approval_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'Independent UI archives cannot claim formal approval' USING ERRCODE='23514';
    END IF;
  ELSIF scope_schema='ath.debug-execution-scope.v1' THEN
    IF run_source<>'debug' OR NEW.approval_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'Debug drafts cannot claim formal approval' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.case_id IS NULL OR NEW.approval_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Formal scopes require real case and approval identities' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
