-- E013 changes current requirement representation only. Historical commands, audit payloads,
-- versions, approved snapshots, runs and reports remain immutable and retain their original bytes.
CREATE TABLE app.requirement_state_normalizations(
 requirement_id uuid NOT NULL,project_id uuid NOT NULL,old_lifecycle text NOT NULL,old_archived_at timestamptz,old_row_version integer NOT NULL,
 new_archived_at timestamptz NOT NULL,normalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(requirement_id)
);
-- No requirement FK: this migration metadata must not turn an otherwise unused requirement into protected business history.
INSERT INTO app.requirement_state_normalizations(requirement_id,project_id,old_lifecycle,old_archived_at,old_row_version,new_archived_at)
 SELECT id,project_id,lifecycle,archived_at,row_version,COALESCE(archived_at,clock_timestamp()) FROM app.requirements
 WHERE lifecycle<>'inProgress' OR archived_at IS NOT NULL;
ALTER TABLE app.requirements DROP CONSTRAINT requirements_lifecycle_check;
UPDATE app.requirements r SET lifecycle='archived',archived_at=n.new_archived_at,row_version=r.row_version+1
 FROM app.requirement_state_normalizations n WHERE n.requirement_id=r.id;
ALTER TABLE app.requirements ADD CONSTRAINT requirements_lifecycle_check CHECK(lifecycle IN ('inProgress','archived'));
ALTER TABLE app.requirements ADD CONSTRAINT requirements_archival_consistent CHECK((lifecycle='archived')=(archived_at IS NOT NULL));
CREATE TRIGGER requirement_state_normalizations_immutable BEFORE UPDATE OR DELETE ON app.requirement_state_normalizations FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
