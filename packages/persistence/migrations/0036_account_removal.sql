-- Account removal is a retained identity tombstone, never a business-data delete.
ALTER TABLE app.users ADD COLUMN removed_at timestamptz;
ALTER TABLE app.users ADD COLUMN removed_by uuid REFERENCES app.users(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.users ADD CONSTRAINT user_removal_state CHECK (
  (removed_at IS NULL AND removed_by IS NULL)
  OR (removed_at IS NOT NULL AND removed_by IS NOT NULL AND NOT active)
);
CREATE INDEX users_visible_admin_page ON app.users(account,id) WHERE removed_at IS NULL;

CREATE FUNCTION app.guard_removed_user_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.account IS DISTINCT FROM OLD.account
    OR NEW.display_account IS DISTINCT FROM OLD.display_account
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
    OR NEW.removed_by IS DISTINCT FROM OLD.removed_by OR NEW.active
  ) THEN
    RAISE EXCEPTION 'Removed account identities and their tombstones cannot be reassigned or reactivated'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER removed_user_identity_retained BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.guard_removed_user_identity();

CREATE TABLE app.account_removals (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) DEFERRABLE INITIALLY DEFERRED,
  actor_id uuid NOT NULL REFERENCES app.users(id) DEFERRABLE INITIALLY DEFERRED,
  command_key text NOT NULL CHECK(length(command_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  removed_at timestamptz NOT NULL,
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  UNIQUE(actor_id,command_key)
);
CREATE TRIGGER account_removal_history_immutable BEFORE UPDATE OR DELETE ON app.account_removals
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
COMMENT ON TABLE app.account_removals IS
  'Immutable original Web administrator removal receipts; the referenced users and all authored business/private data remain retained.';
