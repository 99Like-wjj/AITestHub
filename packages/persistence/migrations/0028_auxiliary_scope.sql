ALTER TABLE app.model_services ADD COLUMN allowed_data_scopes text[] NOT NULL DEFAULT ARRAY['syntheticPublicOnly'];
ALTER TABLE app.model_services ADD CONSTRAINT model_data_scopes_valid CHECK(cardinality(allowed_data_scopes)>0 AND array_position(allowed_data_scopes,NULL) IS NULL AND allowed_data_scopes<@ARRAY['syntheticPublicOnly','authorizedRelevantTestData']::text[]);
CREATE TABLE app.auxiliary_disclosures(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES app.users(id),purpose text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_digest text NOT NULL CHECK(scope_digest~'^[a-f0-9]{64}$'),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 model_snapshot jsonb NOT NULL CHECK(jsonb_typeof(model_snapshot)='object'),source_meta jsonb NOT NULL CHECK(jsonb_typeof(source_meta)='object'),
 allowed_data_scopes text[] NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,consumed_command_id text,consented_scope text,invalidated_at timestamptz
);
CREATE INDEX auxiliary_disclosures_owner_idx ON app.auxiliary_disclosures(owner_id,created_at,id);

ALTER TABLE app.ai_tasks DROP CONSTRAINT ai_tasks_data_scope_check;
ALTER TABLE app.ai_tasks ADD CONSTRAINT ai_tasks_data_scope_check CHECK(data_scope IN ('syntheticPublicOnly','authorizedRelevantTestData'));

-- Frozen auxiliary source history is protected just like other used requirement history.
CREATE OR REPLACE FUNCTION app.requirement_has_protected_history(project uuid,requirement uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE fk record;predicate text;present boolean;root_table text;
BEGIN
 FOR fk IN SELECT c.conrelid,c.confrelid,c.conkey,c.confkey FROM pg_constraint c
  WHERE c.contype='f' AND c.confrelid IN ('app.requirements'::regclass,'app.requirement_versions'::regclass)
  AND NOT(c.confrelid='app.requirements'::regclass AND c.conrelid IN ('app.requirement_versions'::regclass,'app.requirement_participants'::regclass,'app.ai_requirement_groups'::regclass,'app.ai_conversation_preferences'::regclass))
 LOOP
  SELECT string_agg(format('d.%I=r.%I',child.attname,parent.attname),' AND ' ORDER BY pair.ordinality) INTO predicate
   FROM unnest(fk.conkey,fk.confkey) WITH ORDINALITY pair(childnum,parentnum,ordinality)
   JOIN pg_attribute child ON child.attrelid=fk.conrelid AND child.attnum=pair.childnum
   JOIN pg_attribute parent ON parent.attrelid=fk.confrelid AND parent.attnum=pair.parentnum;
  root_table=CASE WHEN fk.confrelid='app.requirements'::regclass THEN 'app.requirements' ELSE 'app.requirement_versions' END;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s d JOIN %s r ON %s WHERE r.project_id=$1 AND %s=$2)',fk.conrelid::regclass,root_table,predicate,
   CASE WHEN fk.confrelid='app.requirements'::regclass THEN 'r.id' ELSE 'r.requirement_id' END) INTO present USING project,requirement;
  IF present THEN RETURN true;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.knowledge_revisions k CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.content->'sourceRefs','[]'::jsonb)) source
  JOIN app.requirement_versions v ON source->>'kind'='requirementVersion' AND source->>'requirementVersionId'=v.id::text
  WHERE v.project_id=project AND v.requirement_id=requirement) THEN RETURN true;END IF;
 IF EXISTS(SELECT 1 FROM app.auxiliary_tasks t WHERE t.source_snapshot#>>'{meta,projectId}'=project::text AND ((COALESCE(t.source_snapshot->'candidateIds','[]'::jsonb) ? requirement::text) OR (t.source_snapshot#>>'{meta,kind}'='requirementGroup' AND t.source_snapshot#>>'{meta,objectId}'=requirement::text))) THEN RETURN true;END IF;
 RETURN false;
END;
$$;
