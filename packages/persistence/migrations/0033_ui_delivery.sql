-- v2 sidecars only. Do not rewrite v1 submissions, receipts, end timestamps or reports.
ALTER TABLE app.resource_references DROP CONSTRAINT resource_references_reference_type_check;
ALTER TABLE app.resource_references ADD CONSTRAINT resource_references_reference_type_check
  CHECK(reference_type IN ('requirementVersion','evidence','knowledge','report','conversation','uiResultBatch'));
ALTER TABLE app.runs ADD CONSTRAINT runs_ui_delivery_owner_scope_key
  UNIQUE(project_id,id,created_by,kind,scope_digest);
ALTER TABLE app.file_resources ADD CONSTRAINT file_resources_run_identity_key
  UNIQUE(project_id,run_id,id);
ALTER TABLE app.results ADD CONSTRAINT results_run_item_identity_key
  UNIQUE(run_id,run_item_id,id);

CREATE TABLE app.ui_delivery_heads (
  run_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  kind text NOT NULL DEFAULT 'UI' CHECK(kind='UI'),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK(mode IN ('nativeV2','legacyDeliveryOnly','legacyResumed')),
  legacy_state text,
  legacy_ended_at timestamptz,
  ledger_version bigint NOT NULL DEFAULT 0 CHECK(ledger_version>=0),
  ledger_digest text NOT NULL CHECK(ledger_digest ~ '^[a-f0-9]{64}$'),
  execution_version bigint NOT NULL DEFAULT 0 CHECK(execution_version>=0),
  last_execution_fact_id uuid,
  last_end_fact_id uuid,
  last_resume_fact_id uuid,
  last_end_fact_kind text GENERATED ALWAYS AS (CASE WHEN last_end_fact_id IS NOT NULL THEN 'end' END) STORED,
  last_resume_fact_kind text GENERATED ALWAYS AS (CASE WHEN last_resume_fact_id IS NOT NULL THEN 'resume' END) STORED,
  latest_seal_id uuid,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,run_id,owner_id,scope_digest),
  FOREIGN KEY(project_id,run_id,owner_id,kind,scope_digest)
    REFERENCES app.runs(project_id,id,created_by,kind,scope_digest),
  CHECK((mode='nativeV2' AND legacy_state IS NULL AND legacy_ended_at IS NULL)
    OR (mode IN ('legacyDeliveryOnly','legacyResumed') AND legacy_state IS NOT NULL AND legacy_state IN
      ('prepared','queued','running','stopping','completed','terminated','interrupted','recoveryRequired'))),
  CHECK(mode<>'legacyResumed' OR last_resume_fact_id IS NOT NULL)
);

CREATE TABLE app.ui_delivery_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scope_digest text NOT NULL,
  batch_id text NOT NULL CHECK(length(batch_id) BETWEEN 8 AND 128),
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  ledger_version bigint NOT NULL CHECK(ledger_version>0),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,batch_id),
  UNIQUE(run_id,ledger_version),
  UNIQUE(run_id,id),
  UNIQUE(project_id,run_id,owner_id,id),
  FOREIGN KEY(project_id,run_id,owner_id,scope_digest)
    REFERENCES app.ui_delivery_heads(project_id,run_id,owner_id,scope_digest)
);

CREATE TABLE app.ui_result_descriptors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  descriptor_id text NOT NULL CHECK(length(descriptor_id) BETWEEN 8 AND 128),
  batch_record_id uuid NOT NULL,
  run_item_id uuid NOT NULL,
  local_result_id text NOT NULL CHECK(length(local_result_id) BETWEEN 1 AND 200),
  core jsonb NOT NULL CHECK(jsonb_typeof(core)='object' AND NOT core ? 'evidenceRefs'),
  refs_count integer NOT NULL CHECK(refs_count BETWEEN 0 AND 1000),
  segment_count integer NOT NULL CHECK(segment_count BETWEEN 0 AND refs_count),
  full_refs_digest text NOT NULL CHECK(full_refs_digest ~ '^[a-f0-9]{64}$'),
  item_digest text NOT NULL CHECK(item_digest ~ '^[a-f0-9]{64}$'),
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  supersedes_descriptor_id uuid,
  supersession_reason text,
  superseded_digest text CHECK(superseded_digest ~ '^[a-f0-9]{64}$'),
  supersession_row_version integer CHECK(supersession_row_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,descriptor_id),
  UNIQUE(run_id,id),
  UNIQUE(run_id,run_item_id,id),
  FOREIGN KEY(project_id,run_id,owner_id,batch_record_id)
    REFERENCES app.ui_delivery_batches(project_id,run_id,owner_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,run_id,run_item_id) REFERENCES app.run_items(project_id,run_id,id),
  FOREIGN KEY(run_id,run_item_id,supersedes_descriptor_id) REFERENCES app.ui_result_descriptors(run_id,run_item_id,id),
  CHECK((supersedes_descriptor_id IS NULL AND supersession_reason IS NULL AND superseded_digest IS NULL AND supersession_row_version IS NULL)
    OR (supersedes_descriptor_id IS NOT NULL AND supersession_reason IS NOT NULL AND length(supersession_reason) BETWEEN 1 AND 4000 AND superseded_digest IS NOT NULL AND supersession_row_version IS NOT NULL)),
  CHECK(supersedes_descriptor_id IS NULL OR supersedes_descriptor_id<>id),
  CHECK((refs_count=0)=(segment_count=0))
);
CREATE INDEX ui_result_descriptors_scope_idx ON app.ui_result_descriptors(run_id,run_item_id,created_at,id);
CREATE UNIQUE INDEX ui_result_descriptors_one_successor_idx ON app.ui_result_descriptors(supersedes_descriptor_id)
  WHERE supersedes_descriptor_id IS NOT NULL;

CREATE TABLE app.ui_result_ref_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  descriptor_record_id uuid NOT NULL,
  batch_record_id uuid NOT NULL,
  segment_index integer NOT NULL CHECK(segment_index BETWEEN 0 AND 999),
  start_index integer NOT NULL CHECK(start_index BETWEEN 0 AND 999),
  evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(evidence_refs)='array' AND jsonb_array_length(evidence_refs) BETWEEN 1 AND 100),
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(descriptor_record_id,segment_index),
  UNIQUE(descriptor_record_id,start_index),
  FOREIGN KEY(run_id,descriptor_record_id) REFERENCES app.ui_result_descriptors(run_id,id),
  FOREIGN KEY(run_id,batch_record_id) REFERENCES app.ui_delivery_batches(run_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE app.ui_delivery_assemblies (
  descriptor_record_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  run_item_id uuid NOT NULL,
  result_id uuid NOT NULL,
  result_revision_id uuid NOT NULL,
  batch_record_id uuid NOT NULL,
  full_refs_digest text NOT NULL CHECK(full_refs_digest ~ '^[a-f0-9]{64}$'),
  item_digest text NOT NULL CHECK(item_digest ~ '^[a-f0-9]{64}$'),
  assembled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(run_id,run_item_id,descriptor_record_id) REFERENCES app.ui_result_descriptors(run_id,run_item_id,id),
  FOREIGN KEY(run_id,batch_record_id) REFERENCES app.ui_delivery_batches(run_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(result_id,result_revision_id) REFERENCES app.result_revisions(result_id,id)
  ,FOREIGN KEY(run_id,run_item_id,result_id) REFERENCES app.results(run_id,run_item_id,id)
);

CREATE TABLE app.ui_delivery_batch_items (
  batch_record_id uuid NOT NULL,
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  item_ordinal integer NOT NULL CHECK(item_ordinal>=0),
  item_kind text NOT NULL CHECK(item_kind IN ('result','notExecuted','descriptor','segment')),
  object_id text NOT NULL CHECK(length(object_id) BETWEEN 1 AND 400),
  run_item_id uuid,
  status text NOT NULL CHECK(status IN ('accepted','skipped','conflict','rejected','pendingAssembly')),
  result_id uuid,
  result_revision_id uuid,
  descriptor_record_id uuid,
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  PRIMARY KEY(batch_record_id,item_ordinal),
  FOREIGN KEY(run_id,batch_record_id) REFERENCES app.ui_delivery_batches(run_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,run_id,run_item_id) REFERENCES app.run_items(project_id,run_id,id),
  FOREIGN KEY(result_id,result_revision_id) REFERENCES app.result_revisions(result_id,id),
  FOREIGN KEY(run_id,run_item_id,result_id) REFERENCES app.results(run_id,run_item_id,id),
  FOREIGN KEY(run_id,descriptor_record_id) REFERENCES app.ui_result_descriptors(run_id,id),
  CHECK((result_id IS NULL)=(result_revision_id IS NULL)),
  CHECK(result_id IS NULL OR run_item_id IS NOT NULL)
);

CREATE TABLE app.ui_delivery_batch_sources (
  batch_record_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_id uuid NOT NULL,
  bytes bigint NOT NULL CHECK(bytes BETWEEN 0 AND 16777216),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,run_id,owner_id,batch_record_id)
    REFERENCES app.ui_delivery_batches(project_id,run_id,owner_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,run_id,file_id) REFERENCES app.file_resources(project_id,run_id,id)
);

CREATE TABLE app.ui_execution_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scope_digest text NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  fact_kind text NOT NULL CHECK(fact_kind IN ('end','resume')),
  command_id text CHECK(length(command_id) BETWEEN 8 AND 128),
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  previous_fact_id uuid,
  end_fact_id uuid,
  resume_fact_id uuid,
  end_fact_kind text GENERATED ALWAYS AS (CASE WHEN end_fact_id IS NOT NULL THEN 'end' END) STORED,
  resume_fact_kind text GENERATED ALWAYS AS (CASE WHEN resume_fact_id IS NOT NULL THEN 'resume' END) STORED,
  end_kind text CHECK(end_kind IN ('normal','terminated','interrupted','legacy')),
  ended_at timestamptz,
  resumed_at timestamptz,
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=4000),
  provenance text NOT NULL CHECK(provenance IN ('local-ai','protocol-synthetic','unknown','legacy-v1')),
  legacy_state text,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,command_id),
  UNIQUE(run_id,sequence),
  UNIQUE(run_id,id),
  UNIQUE(run_id,id,fact_kind),
  FOREIGN KEY(project_id,run_id,owner_id,scope_digest)
    REFERENCES app.ui_delivery_heads(project_id,run_id,owner_id,scope_digest),
  FOREIGN KEY(run_id,previous_fact_id) REFERENCES app.ui_execution_facts(run_id,id),
  FOREIGN KEY(run_id,end_fact_id,end_fact_kind) REFERENCES app.ui_execution_facts(run_id,id,fact_kind),
  FOREIGN KEY(run_id,resume_fact_id,resume_fact_kind) REFERENCES app.ui_execution_facts(run_id,id,fact_kind),
  CHECK((fact_kind='resume' AND command_id IS NOT NULL AND end_kind IS NULL AND ended_at IS NULL
      AND resumed_at IS NOT NULL AND end_fact_id IS NOT NULL AND previous_fact_id IS NOT NULL AND previous_fact_id=end_fact_id
      AND resume_fact_id IS NULL AND provenance<>'legacy-v1' AND legacy_state IS NULL)
    OR (fact_kind='end' AND end_kind IS NOT NULL AND end_kind IN ('normal','terminated','interrupted') AND command_id IS NOT NULL
      AND ended_at IS NOT NULL AND resumed_at IS NULL AND end_fact_id IS NULL
      AND provenance<>'legacy-v1' AND legacy_state IS NULL
      AND previous_fact_id IS NOT DISTINCT FROM resume_fact_id)
    OR (fact_kind='end' AND end_kind IS NOT NULL AND end_kind='legacy' AND command_id IS NULL AND provenance='legacy-v1'
      AND legacy_state IS NOT NULL AND resumed_at IS NULL AND previous_fact_id IS NULL
      AND end_fact_id IS NULL AND resume_fact_id IS NULL)),
  CHECK(previous_fact_id IS NULL OR previous_fact_id<>id),
  CHECK(end_fact_id IS NULL OR end_fact_id<>id),
  CHECK(resume_fact_id IS NULL OR resume_fact_id<>id),
  CHECK(legacy_state IS NULL OR legacy_state IN ('prepared','queued','running','stopping','completed','terminated','interrupted','recoveryRequired'))
);
CREATE UNIQUE INDEX ui_execution_facts_resume_once_idx ON app.ui_execution_facts(run_id,end_fact_id) WHERE fact_kind='resume';
CREATE UNIQUE INDEX ui_execution_facts_end_once_idx ON app.ui_execution_facts(run_id,resume_fact_id) WHERE fact_kind='end' AND resume_fact_id IS NOT NULL;
CREATE UNIQUE INDEX ui_execution_facts_initial_end_once_idx ON app.ui_execution_facts(run_id)
  WHERE fact_kind='end' AND end_kind<>'legacy' AND resume_fact_id IS NULL;
CREATE UNIQUE INDEX ui_execution_facts_legacy_once_idx ON app.ui_execution_facts(run_id) WHERE end_kind='legacy';

CREATE TABLE app.ui_delivery_seals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scope_digest text NOT NULL,
  command_id text NOT NULL CHECK(length(command_id) BETWEEN 8 AND 128),
  semantic_digest text NOT NULL CHECK(semantic_digest ~ '^[a-f0-9]{64}$'),
  ledger_version bigint NOT NULL CHECK(ledger_version>=0),
  ledger_digest text NOT NULL CHECK(ledger_digest ~ '^[a-f0-9]{64}$'),
  coverage_digest text NOT NULL CHECK(coverage_digest ~ '^[a-f0-9]{64}$'),
  coverage_count integer NOT NULL CHECK(coverage_count BETWEEN 0 AND 10000),
  coverage_snapshot jsonb NOT NULL CHECK(jsonb_typeof(coverage_snapshot)='array'),
  end_fact_id uuid NOT NULL,
  end_fact_kind text NOT NULL DEFAULT 'end' CHECK(end_fact_kind='end'),
  missing_file_ids uuid[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,command_id),
  UNIQUE(run_id,id),
  FOREIGN KEY(project_id,run_id,owner_id,scope_digest)
    REFERENCES app.ui_delivery_heads(project_id,run_id,owner_id,scope_digest),
  FOREIGN KEY(run_id,end_fact_id,end_fact_kind) REFERENCES app.ui_execution_facts(run_id,id,fact_kind)
);
ALTER TABLE app.ui_delivery_heads
  ADD FOREIGN KEY(run_id,last_execution_fact_id) REFERENCES app.ui_execution_facts(run_id,id),
  ADD FOREIGN KEY(run_id,last_end_fact_id,last_end_fact_kind) REFERENCES app.ui_execution_facts(run_id,id,fact_kind),
  ADD FOREIGN KEY(run_id,last_resume_fact_id,last_resume_fact_kind) REFERENCES app.ui_execution_facts(run_id,id,fact_kind),
  ADD FOREIGN KEY(run_id,latest_seal_id) REFERENCES app.ui_delivery_seals(run_id,id);

CREATE FUNCTION app.guard_ui_delivery_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.run_id,NEW.project_id,NEW.owner_id,NEW.kind,NEW.scope_digest,NEW.legacy_state,NEW.legacy_ended_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.project_id,OLD.owner_id,OLD.kind,OLD.scope_digest,OLD.legacy_state,OLD.legacy_ended_at,OLD.created_at) THEN
    RAISE EXCEPTION 'UI delivery identity and original legacy basis are immutable';
  END IF;
  IF NEW.mode<>OLD.mode AND NOT (OLD.mode='legacyDeliveryOnly' AND NEW.mode='legacyResumed') THEN
    RAISE EXCEPTION 'UI delivery protocol mode cannot be silently rewritten';
  END IF;
  IF NEW.ledger_version<OLD.ledger_version OR NEW.execution_version<OLD.execution_version OR NEW.row_version<OLD.row_version THEN
    RAISE EXCEPTION 'UI delivery counters cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ui_delivery_head_guard BEFORE UPDATE ON app.ui_delivery_heads FOR EACH ROW EXECUTE FUNCTION app.guard_ui_delivery_head();
CREATE TRIGGER ui_delivery_heads_no_delete BEFORE DELETE ON app.ui_delivery_heads FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TRIGGER ui_delivery_batches_immutable BEFORE UPDATE OR DELETE ON app.ui_delivery_batches FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_delivery_batch_items_immutable BEFORE UPDATE OR DELETE ON app.ui_delivery_batch_items FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_delivery_batch_sources_immutable BEFORE UPDATE OR DELETE ON app.ui_delivery_batch_sources FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_result_descriptors_immutable BEFORE UPDATE OR DELETE ON app.ui_result_descriptors FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_result_ref_segments_immutable BEFORE UPDATE OR DELETE ON app.ui_result_ref_segments FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_delivery_assemblies_immutable BEFORE UPDATE OR DELETE ON app.ui_delivery_assemblies FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_execution_facts_immutable BEFORE UPDATE OR DELETE ON app.ui_execution_facts FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER ui_delivery_seals_immutable BEFORE UPDATE OR DELETE ON app.ui_delivery_seals FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
