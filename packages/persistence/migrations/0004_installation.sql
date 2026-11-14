-- Installation bootstrap is independent from isolated synthetic test administrators.
CREATE TABLE app.installation_state (
  key text PRIMARY KEY,
  initialized_by uuid NOT NULL REFERENCES app.users(id),
  initialized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER installation_state_immutable BEFORE UPDATE OR DELETE ON app.installation_state
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
