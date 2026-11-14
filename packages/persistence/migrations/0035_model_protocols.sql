-- E014: additive service/model split. Original 1-34 and historical payloads stay unchanged.
ALTER TABLE app.model_services ADD COLUMN note text NOT NULL DEFAULT '';
ALTER TABLE app.model_services ADD COLUMN protocol text NOT NULL DEFAULT 'chatCompletions'
 CHECK(protocol IN ('chatCompletions','responses','anthropicMessages'));
ALTER TABLE app.model_services ADD COLUMN auth_scheme text NOT NULL DEFAULT 'bearer'
 CHECK(auth_scheme IN ('bearer','xApiKey'));
ALTER TABLE app.model_services ADD COLUMN removed_at timestamptz;
ALTER TABLE app.model_services ADD COLUMN removed_by uuid REFERENCES app.users(id);
ALTER TABLE app.model_services ADD CONSTRAINT model_service_removed_pair
 CHECK((removed_at IS NULL)=(removed_by IS NULL) AND (removed_at IS NULL OR NOT enabled));
-- Legacy-only columns are preserved. New protocol services do not invent a vendor brand.
ALTER TABLE app.model_services ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE app.model_services ALTER COLUMN model_id DROP NOT NULL;
ALTER TABLE app.model_services ALTER COLUMN capabilities DROP NOT NULL;
ALTER TABLE app.model_services ALTER COLUMN effort_values DROP NOT NULL;

CREATE TABLE app.model_entries (
 id uuid PRIMARY KEY,
 model_service_id uuid NOT NULL REFERENCES app.model_services(id),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 enabled boolean NOT NULL,
 removed_at timestamptz,
 position integer NOT NULL CHECK(position>=0),
 context_limit bigint CHECK(context_limit>0),
 effort_values text[] NOT NULL,
 default_effort text,
 max_output bigint CHECK(max_output>0),
 verification jsonb NOT NULL DEFAULT '{"status":"unverified","checkedAt":null,"checks":{}}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(model_service_id,id),
 CHECK(removed_at IS NULL OR NOT enabled),
 CHECK(default_effort IS NULL OR default_effort=ANY(effort_values))
);
CREATE INDEX model_entries_service_order ON app.model_entries(model_service_id,position,id);
-- Domain-separated deterministic identity, not a credential or authorization token.
CREATE FUNCTION app.model_legacy_entry_id(service_id uuid) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH h AS(SELECT encode(sha256(convert_to('ath:0035:legacy-model-entry:'||service_id::text,'UTF8')),'hex') value)
 SELECT (substr(value,1,8)||'-'||substr(value,9,4)||'-5'||substr(value,14,3)||'-a'||substr(value,18,3)||'-'||substr(value,21,12))::uuid FROM h;
$$;
CREATE TABLE app.model_legacy_bindings (
 model_service_id uuid NOT NULL,
 legacy_revision integer NOT NULL,
 upgraded_revision integer NOT NULL,
 model_entry_id uuid NOT NULL,
 legacy_snapshot_digest text NOT NULL CHECK(legacy_snapshot_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(model_service_id,legacy_revision),
 UNIQUE(model_service_id,upgraded_revision),
 CHECK(upgraded_revision=legacy_revision+1),
 FOREIGN KEY(model_service_id,legacy_revision) REFERENCES app.model_service_revisions(model_service_id,revision),
 FOREIGN KEY(model_service_id,upgraded_revision) REFERENCES app.model_service_revisions(model_service_id,revision),
 FOREIGN KEY(model_service_id,model_entry_id) REFERENCES app.model_entries(model_service_id,id)
);
CREATE TRIGGER model_legacy_bindings_immutable BEFORE UPDATE OR DELETE ON app.model_legacy_bindings
 FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TABLE app.model_entry_verifications (
 id uuid PRIMARY KEY,
 model_service_id uuid NOT NULL,
 model_entry_id uuid NOT NULL,
 service_revision integer NOT NULL,
 verification jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(model_service_id,model_entry_id) REFERENCES app.model_entries(model_service_id,id),
 FOREIGN KEY(model_service_id,service_revision) REFERENCES app.model_service_revisions(model_service_id,revision)
);
CREATE TRIGGER model_entry_verifications_immutable BEFORE UPDATE OR DELETE ON app.model_entry_verifications
 FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
ALTER TABLE app.auxiliary_model_configuration ADD COLUMN model_entry_id uuid;
ALTER TABLE app.auxiliary_model_configuration ADD CONSTRAINT auxiliary_model_entry_same_service
 FOREIGN KEY(model_service_id,model_entry_id) REFERENCES app.model_entries(model_service_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.model_call_ledger ADD COLUMN model_entry_id uuid;
ALTER TABLE app.model_call_ledger ADD COLUMN model_protocol text CHECK(model_protocol IN ('chatCompletions','responses','anthropicMessages'));
ALTER TABLE app.model_call_ledger ADD CONSTRAINT model_call_entry_same_service
 FOREIGN KEY(model_service_id,model_entry_id) REFERENCES app.model_entries(model_service_id,id) DEFERRABLE INITIALLY DEFERRED;

DO $$
DECLARE old app.model_services%ROWTYPE; entry_id uuid; prior jsonb; upgraded jsonb; user_ids jsonb;
BEGIN
 FOR old IN SELECT * FROM app.model_services ORDER BY id FOR UPDATE LOOP
  SELECT snapshot INTO prior FROM app.model_service_revisions WHERE model_service_id=old.id AND revision=old.config_revision;
  IF prior IS NULL OR prior->>'modelId' IS DISTINCT FROM old.model_id
   OR prior->>'provider' IS DISTINCT FROM old.provider
   OR prior->>'baseUrl' IS DISTINCT FROM old.base_url THEN
   RAISE EXCEPTION 'model schema upgrade requires an exact immutable legacy revision';
  END IF;
  entry_id=app.model_legacy_entry_id(old.id);
  INSERT INTO app.model_entries(id,model_service_id,display_name,model_id,enabled,position,context_limit,effort_values,default_effort,max_output,verification)
   VALUES(entry_id,old.id,old.model_id,old.model_id,true,0,old.context_limit,old.effort_values,old.default_effort,old.max_output,old.verification);
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb) INTO user_ids FROM app.model_grants WHERE model_service_id=old.id;
  upgraded=jsonb_build_object('schemaVersion','ath.model-service.v2','credentialRef',old.credential_ref,'provenance',jsonb_build_object('kind','schemaUpgrade','migration','0035_model_protocols.sql','legacyRevision',old.config_revision),
   'modelService',jsonb_build_object('id',old.id,'name',old.name,'note','','protocol','chatCompletions','baseUrl',old.base_url,'authScheme','bearer','enabled',old.enabled,'removedAt',null,
    'accessPolicy',old.access_policy,'allowedUserIds',user_ids,'allowedDataScopes',to_jsonb(old.allowed_data_scopes),'hasCredential',
    COALESCE((prior->>'hasCredential')::boolean,false),
    'rowVersion',old.row_version+1,'serviceRevision',old.config_revision+1,
    'models',jsonb_build_array(jsonb_build_object('id',entry_id,'displayName',old.model_id,'modelId',old.model_id,'enabled',true,'removedAt',null,
      'contextLimit',old.context_limit,'effortValues',to_jsonb(old.effort_values),'defaultEffort',old.default_effort,'maxOutput',old.max_output,'verification',prior->'verification'))));
  INSERT INTO app.model_service_revisions(model_service_id,revision,snapshot,created_by)
   VALUES(old.id,old.config_revision+1,upgraded,old.created_by);
  INSERT INTO app.model_legacy_bindings(model_service_id,legacy_revision,upgraded_revision,model_entry_id,legacy_snapshot_digest)
   VALUES(old.id,old.config_revision,old.config_revision+1,entry_id,encode(sha256(convert_to(prior::text,'UTF8')),'hex'));
  UPDATE app.model_services SET config_revision=config_revision+1,row_version=row_version+1 WHERE id=old.id;
  UPDATE app.auxiliary_model_configuration SET model_entry_id=entry_id WHERE model_service_id=old.id;
 END LOOP;
END;
$$;

CREATE FUNCTION app.prevent_removed_model_revival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by IS DISTINCT FROM OLD.removed_by OR NEW.enabled) THEN
  RAISE EXCEPTION 'removed model service cannot be revived';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER model_service_removal_permanent BEFORE UPDATE ON app.model_services
 FOR EACH ROW EXECUTE FUNCTION app.prevent_removed_model_revival();
