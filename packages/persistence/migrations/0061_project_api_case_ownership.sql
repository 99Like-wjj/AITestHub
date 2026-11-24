-- API assets have project identity. An optional scenario-to-requirement relation is not ownership.
ALTER TABLE app.test_assets
  ALTER COLUMN requirement_version_id DROP NOT NULL,
  ALTER COLUMN set_id DROP NOT NULL,
  ADD COLUMN project_api_owned boolean GENERATED ALWAYS AS (kind='API' AND set_id IS NULL) STORED,
  DROP CONSTRAINT test_assets_check,
  ADD CONSTRAINT test_assets_scope_shape CHECK (
    (set_id IS NULL AND kind='API' AND (
      (target_type='scenario' AND parent_id IS NULL AND parent_type IS NULL)
      OR (target_type='case' AND requirement_version_id IS NULL AND (
        (parent_id IS NULL AND parent_type IS NULL)
        OR (parent_id IS NOT NULL AND parent_type IS NOT DISTINCT FROM 'scenario')
      ))
    ))
    OR (set_id IS NOT NULL AND requirement_version_id IS NOT NULL AND (
      (target_type='set' AND id=set_id AND parent_id IS NULL AND parent_type IS NULL)
      OR (target_type='scenario' AND parent_id IS NOT NULL AND parent_id=set_id AND parent_type IS NOT DISTINCT FROM 'set')
      OR (target_type='case' AND parent_id IS NOT NULL AND parent_type IS NOT DISTINCT FROM 'scenario')
    ))
  ),
  ADD CONSTRAINT test_assets_project_fk FOREIGN KEY(project_id) REFERENCES app.projects(id),
  ADD CONSTRAINT test_assets_project_identity UNIQUE(project_id,kind,project_api_owned,id,target_type),
  ADD CONSTRAINT test_assets_project_parent_fk FOREIGN KEY(project_id,kind,project_api_owned,parent_id,parent_type)
    REFERENCES app.test_assets(project_id,kind,project_api_owned,id,target_type);

ALTER TABLE app.asset_revisions
  ALTER COLUMN requirement_version_id DROP NOT NULL,
  ALTER COLUMN set_id DROP NOT NULL,
  ADD COLUMN project_api_owned boolean GENERATED ALWAYS AS (kind='API' AND set_id IS NULL) STORED,
  ADD CONSTRAINT asset_revisions_project_asset_fk FOREIGN KEY(project_id,kind,project_api_owned,asset_id,target_type)
    REFERENCES app.test_assets(project_id,kind,project_api_owned,id,target_type),
  ADD CONSTRAINT asset_revisions_project_identity UNIQUE(project_id,kind,project_api_owned,asset_id,id),
  ADD CONSTRAINT asset_revisions_project_requirement_fk FOREIGN KEY(project_id,requirement_version_id)
    REFERENCES app.requirement_versions(project_id,id),
  ADD CONSTRAINT asset_revisions_project_case_contract CHECK (
    NOT project_api_owned OR target_type<>'case' OR (
      requirement_version_id IS NULL AND content @> '{"kind":"API","dslVersion":"ath.api-case.v2"}'
    )
  );

ALTER TABLE app.test_assets
  ADD CONSTRAINT test_assets_current_project_revision_fk FOREIGN KEY(project_id,kind,project_api_owned,id,current_revision_id)
    REFERENCES app.asset_revisions(project_id,kind,project_api_owned,asset_id,id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app.approval_snapshots
  ALTER COLUMN set_id DROP NOT NULL,
  ALTER COLUMN set_revision_id DROP NOT NULL,
  ALTER COLUMN scenario_id DROP NOT NULL,
  ALTER COLUMN scenario_revision_id DROP NOT NULL,
  ADD COLUMN project_api_owned boolean GENERATED ALWAYS AS (kind='API' AND set_id IS NULL) STORED,
  ADD CONSTRAINT approval_snapshots_scope_shape CHECK (
    ((set_id IS NULL AND set_revision_id IS NULL AND kind='API')
      OR (set_id IS NOT NULL AND set_revision_id IS NOT NULL))
    AND ((scenario_id IS NULL AND scenario_revision_id IS NULL AND set_id IS NULL)
      OR (scenario_id IS NOT NULL AND scenario_revision_id IS NOT NULL))
  ),
  ADD CONSTRAINT approval_snapshots_case_project_revision_fk FOREIGN KEY(project_id,kind,project_api_owned,case_id,case_revision_id)
    REFERENCES app.asset_revisions(project_id,kind,project_api_owned,asset_id,id),
  ADD CONSTRAINT approval_snapshots_scenario_project_revision_fk FOREIGN KEY(project_id,kind,project_api_owned,scenario_id,scenario_revision_id)
    REFERENCES app.asset_revisions(project_id,kind,project_api_owned,asset_id,id);

ALTER TABLE app.api_debug_drafts ALTER COLUMN scenario_revision_id DROP NOT NULL;

CREATE INDEX test_assets_project_api_idx ON app.test_assets(project_id,target_type,parent_id,id)
  WHERE kind='API' AND set_id IS NULL;
