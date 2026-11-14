-- A frozen handling snapshot belongs to this report revision. Historical execution
-- facts remain unchanged; old revisions explicitly have no captured handling.
ALTER TABLE app.report_revisions ADD COLUMN handling_snapshot jsonb;
ALTER TABLE app.report_revisions ADD CONSTRAINT report_handling_snapshot_object
  CHECK (handling_snapshot IS NULL OR jsonb_typeof(handling_snapshot)='object');
