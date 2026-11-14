CREATE TABLE app.secret_records (
  id uuid PRIMARY KEY,
  owner_scope text NOT NULL CHECK(owner_scope IN ('platform','user','project')),
  owner_id uuid NOT NULL,
  purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 100),
  key_version text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX secret_records_owner_idx ON app.secret_records(owner_scope,owner_id,purpose);

CREATE TABLE app.model_services (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  provider text NOT NULL CHECK(provider IN ('sensenova','ark')),
  base_url text NOT NULL,
  model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
  enabled boolean NOT NULL,
  access_policy text NOT NULL CHECK(access_policy IN ('restricted','allActive')),
  capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='object'),
  effort_values text[] NOT NULL,
  default_effort text,
  context_limit bigint,
  max_output bigint,
  credential_ref uuid REFERENCES app.secret_records(id),
  config_revision integer NOT NULL DEFAULT 1 CHECK(config_revision>0),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  verification jsonb NOT NULL DEFAULT '{"status":"unverified","checkedAt":null,"checks":{}}'::jsonb,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.model_grants (
  model_service_id uuid NOT NULL REFERENCES app.model_services(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  PRIMARY KEY(model_service_id,user_id)
);
CREATE TABLE app.model_service_revisions (
  model_service_id uuid NOT NULL REFERENCES app.model_services(id),
  revision integer NOT NULL CHECK(revision>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(model_service_id,revision)
);
CREATE TRIGGER model_service_revisions_immutable BEFORE UPDATE OR DELETE ON app.model_service_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.model_verification_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_service_id uuid NOT NULL REFERENCES app.model_services(id),
  config_revision integer NOT NULL,
  verification jsonb NOT NULL CHECK(jsonb_typeof(verification)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(model_service_id,config_revision) REFERENCES app.model_service_revisions(model_service_id,revision)
);
CREATE TRIGGER model_verification_records_immutable BEFORE UPDATE OR DELETE ON app.model_verification_records
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.auxiliary_model_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  model_service_id uuid REFERENCES app.model_services(id),
  enabled boolean NOT NULL,
  effort text,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  updated_by uuid NOT NULL REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT enabled OR model_service_id IS NOT NULL)
);
