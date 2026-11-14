-- Candidate only. Central policy metadata; no old file/task/receipt backfill.
-- Consumer wiring, trusted activation and global claim admission are a separate stage.
CREATE TABLE app.resource_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document)='object'
    AND (document->>'schemaVersion') IS NOT DISTINCT FROM 'ath.resource-policy.v1'
  ),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER resource_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON app.resource_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TABLE app.resource_policy_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton=true),
  revision_id uuid NOT NULL REFERENCES app.resource_policy_revisions(id),
  activation_version bigint NOT NULL CHECK(activation_version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION app.guard_resource_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.revision_id=OLD.revision_id
     OR NEW.activation_version<>OLD.activation_version+1 THEN
    RAISE EXCEPTION 'Policy activation requires a new revision and next generation'
      USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_policy_head_generation
  BEFORE UPDATE ON app.resource_policy_head
  FOR EACH ROW EXECUTE FUNCTION app.guard_resource_policy_head();
CREATE TRIGGER resource_policy_head_no_delete
  BEFORE DELETE ON app.resource_policy_head
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- The canonical v1 UTF-8 document digest is verified again by every consumer.
-- This creates only the new default head; no existing business history is rewritten.
INSERT INTO app.resource_policy_revisions(id,document,policy_digest) VALUES(
  '34dbe2ea-c9c9-48d9-9318-06b20fba8e92',
  '{"capacity":{"largeUploadFromBytes":"10485760","restrictBelowBytes":"10737418240","sampleMaxAgeMs":120000,"warnBelowBytes":"21474836480"},"files":{"maxFileBytes":"104857600","maxFilesPerBatch":100,"maxSubmissionBytes":"1073741824"},"schemaVersion":"ath.resource-policy.v1","tasks":{"maxAiTasks":2,"maxApiRuns":2}}'::jsonb,
  '505897b19cd743ff850774bed78e5e5e35ba0dba92372ef664bcb17f00739d75'
);
INSERT INTO app.resource_policy_head(singleton,revision_id,activation_version)
  VALUES(true,'34dbe2ea-c9c9-48d9-9318-06b20fba8e92',1);

CREATE TABLE app.resource_policy_activations (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES app.users(id),
  command_key text NOT NULL CHECK(length(command_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  previous_revision_id uuid NOT NULL REFERENCES app.resource_policy_revisions(id),
  activated_revision_id uuid NOT NULL REFERENCES app.resource_policy_revisions(id),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,command_key)
);
CREATE TRIGGER resource_policy_activations_immutable
  BEFORE UPDATE OR DELETE ON app.resource_policy_activations
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

COMMENT ON TABLE app.resource_policy_revisions IS
  'Immutable trusted operations resource documents; never a model/MCP override or business permission.';
COMMENT ON TABLE app.resource_policy_head IS
  'Single DB-wide effective policy generation. Admissions share-lock this row; activations serialize against them.';

-- File/submission consumers: policy defaults are not a permanent physical ceiling.
-- bigint itself provides the signed representation bound. Authorized consumers bind
-- a trusted immutable policy in the same transaction before accepting any new work.
ALTER TABLE app.file_resources DROP CONSTRAINT file_resources_declared_bytes_check;
ALTER TABLE app.file_resources ADD CONSTRAINT file_resources_declared_bytes_representation_check CHECK(declared_bytes>=0);
ALTER TABLE app.resource_policy_revisions ADD CONSTRAINT resource_policy_revision_digest_unique UNIQUE(id,policy_digest);
CREATE TABLE app.resource_policy_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  namespace text NOT NULL CHECK(namespace IN ('file','requirements.create','requirements.add-version','results.submit','results.amend','results.evidence-addition','ui.batch','ui.descriptor')),
  intent_key text NOT NULL CHECK(length(intent_key) BETWEEN 1 AND 400),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  policy_revision_id uuid NOT NULL,
  policy_digest text NOT NULL,
  file_id uuid UNIQUE REFERENCES app.file_resources(id),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT(owner_id,project_id,namespace,intent_key),
  FOREIGN KEY(policy_revision_id,policy_digest) REFERENCES app.resource_policy_revisions(id,policy_digest),
  FOREIGN KEY(project_id,file_id) REFERENCES app.file_resources(project_id,id),
  CHECK((namespace='file' AND file_id IS NOT NULL AND intent_key=file_id::text) OR (namespace<>'file' AND file_id IS NULL))
);
CREATE TRIGGER resource_policy_acceptances_immutable BEFORE UPDATE OR DELETE ON app.resource_policy_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
COMMENT ON TABLE app.resource_policy_acceptances IS 'Immutable metadata-only accepted identity→policy reference. No historical rows are backfilled; absent sidecars on prior accepted identities mean explicit legacy defaults.';
