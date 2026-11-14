ALTER TABLE app.ai_requirement_groups ADD COLUMN generated_name text CHECK(generated_name IS NULL OR length(generated_name) BETWEEN 1 AND 80);
ALTER TABLE app.ai_requirement_groups ADD COLUMN generated_name_source_hash text;
ALTER TABLE app.ai_requirement_groups ADD COLUMN generated_name_task_id uuid REFERENCES app.auxiliary_tasks(id);
CREATE TABLE app.automatic_auxiliary_intents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES app.users(id),
 purpose text NOT NULL CHECK(purpose IN ('groupAlias','requirementLookup')),project_id uuid NOT NULL REFERENCES app.projects(id),requirement_id uuid,conversation_id uuid,parent_task_id uuid,
 command_key text NOT NULL,request_hash text CHECK(request_hash IS NULL OR request_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pendingPermission' CHECK(state IN ('pendingPermission','accepting','accepted','completed','failed','unknown','superseded','cancelled','localMatched')),
 auxiliary_command_id text NOT NULL,auxiliary_task_id uuid REFERENCES app.auxiliary_tasks(id),disclosure_id uuid REFERENCES app.auxiliary_disclosures(id),
 scope_digest text,source_digest text,source_name_hash text,model_snapshot jsonb,data_scope text CHECK(data_scope IS NULL OR data_scope IN ('syntheticPublicOnly','authorizedRelevantTestData')),
 accept_command_key text,accept_hash text,consented_at timestamptz,protected_history boolean NOT NULL DEFAULT false,error_code text,local_matches jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,command_key),UNIQUE(owner_id,auxiliary_command_id),CHECK((purpose='groupAlias')=(requirement_id IS NOT NULL))
);
CREATE UNIQUE INDEX automatic_group_name_once ON app.automatic_auxiliary_intents(owner_id,requirement_id) WHERE purpose='groupAlias' AND state IN ('pendingPermission','accepting','accepted','unknown');
CREATE INDEX automatic_auxiliary_owner_project ON app.automatic_auxiliary_intents(owner_id,project_id,created_at,id);
-- Group formation registers only IDs. No model resolution, title/body read or provider call occurs in this trigger.
CREATE FUNCTION app.register_automatic_group_name_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent uuid;
BEGIN
 intent=gen_random_uuid();
 INSERT INTO app.automatic_auxiliary_intents(id,owner_id,purpose,project_id,requirement_id,command_key,auxiliary_command_id)
 VALUES(intent,NEW.owner_id,'groupAlias',NEW.project_id,NEW.requirement_id,'group-alias:'||intent::text,'auto-alias:'||intent::text)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER automatic_group_name_intent AFTER INSERT ON app.ai_requirement_groups FOR EACH ROW EXECUTE FUNCTION app.register_automatic_group_name_intent();
-- Existing groups have real formation history; register a new upgrade intent without fabricating an earlier task/call.
INSERT INTO app.automatic_auxiliary_intents(owner_id,purpose,project_id,requirement_id,command_key,auxiliary_command_id)
 SELECT owner_id,'groupAlias',project_id,requirement_id,'group-alias-upgrade:'||gen_random_uuid()::text,'auto-alias-upgrade:'||gen_random_uuid()::text
 FROM app.ai_requirement_groups WHERE alias IS NULL AND NOT hidden AND archived_at IS NULL ON CONFLICT DO NOTHING;

-- Clearing a manual alias reuses an existing valid generated default. If none exists, the real preference event registers fresh metadata only.
CREATE FUNCTION app.register_cleared_group_default() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE formal_name text;intent uuid;
BEGIN
 IF NEW.alias IS NOT NULL OR NEW.hidden OR NEW.archived_at IS NOT NULL THEN RETURN NEW;END IF;
 SELECT title INTO formal_name FROM app.requirements WHERE project_id=NEW.project_id AND id=NEW.requirement_id;
 IF NEW.generated_name IS NOT NULL AND NEW.generated_name_source_hash=encode(sha256(convert_to(formal_name,'UTF8')),'hex') THEN RETURN NEW;END IF;
 intent=gen_random_uuid();
 INSERT INTO app.automatic_auxiliary_intents(id,owner_id,purpose,project_id,requirement_id,command_key,auxiliary_command_id)
 VALUES(intent,NEW.owner_id,'groupAlias',NEW.project_id,NEW.requirement_id,'group-alias:'||intent::text,'auto-alias:'||intent::text) ON CONFLICT DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER automatic_group_default_cleared AFTER UPDATE OF alias ON app.ai_requirement_groups FOR EACH ROW WHEN (OLD.alias IS NOT NULL AND NEW.alias IS NULL) EXECUTE FUNCTION app.register_cleared_group_default();
CREATE TRIGGER automatic_group_default_restored AFTER UPDATE OF hidden,archived_at ON app.ai_requirement_groups FOR EACH ROW WHEN ((OLD.hidden AND NOT NEW.hidden) OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)) EXECUTE FUNCTION app.register_cleared_group_default();

-- A changed formal title invalidates the prior disclosure; a new metadata intent never carries its old permission.
CREATE FUNCTION app.invalidate_automatic_group_name_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record;intent uuid;
BEGIN
 UPDATE app.automatic_auxiliary_intents SET state='superseded',error_code='SOURCE_CHANGED',updated_at=clock_timestamp()
 WHERE purpose='groupAlias' AND project_id=NEW.project_id AND requirement_id=NEW.id AND state IN ('pendingPermission','accepting','accepted','unknown','completed','failed');
 FOR g IN SELECT owner_id FROM app.ai_requirement_groups WHERE project_id=NEW.project_id AND requirement_id=NEW.id AND alias IS NULL AND NOT hidden AND archived_at IS NULL LOOP
  intent=gen_random_uuid();
  INSERT INTO app.automatic_auxiliary_intents(id,owner_id,purpose,project_id,requirement_id,command_key,auxiliary_command_id)
  VALUES(intent,g.owner_id,'groupAlias',NEW.project_id,NEW.id,'group-alias:'||intent::text,'auto-alias:'||intent::text) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER automatic_group_name_source_changed AFTER UPDATE OF title ON app.requirements FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION app.invalidate_automatic_group_name_source();

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
 IF EXISTS(SELECT 1 FROM app.automatic_auxiliary_intents i WHERE i.project_id=project AND i.requirement_id=requirement AND i.protected_history) THEN RETURN true;END IF;
 RETURN false;
END;
$$;
