-- Future worker claims record a real processing start. Existing history remains unknown.
ALTER TABLE app.auxiliary_tasks ADD COLUMN started_at timestamptz;
COMMENT ON COLUMN app.auxiliary_tasks.started_at IS 'Actual worker claim time; never inferred from task acceptance or backfilled.';
CREATE INDEX audit_auxiliary_finished_idx ON app.audit_events(object_id,created_at)
  WHERE action='auxiliary.finished';
