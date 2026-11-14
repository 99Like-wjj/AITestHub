CREATE TABLE app.requirement_deletion_previews(
 id uuid PRIMARY KEY,project_id uuid NOT NULL,requirement_id uuid NOT NULL,actor_id uuid NOT NULL,
 row_version integer NOT NULL,scope_digest text NOT NULL,payload jsonb NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.requirement_deletion_events(
 id uuid PRIMARY KEY,project_id uuid NOT NULL,requirement_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL,
 command_key text NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_digest text NOT NULL CHECK(scope_digest~'^[a-f0-9]{64}$'),
 source_row_version integer NOT NULL CHECK(source_row_version>0),version_manifest jsonb NOT NULL CHECK(jsonb_typeof(version_manifest)='array'),
 resource_manifest jsonb NOT NULL CHECK(jsonb_typeof(resource_manifest)='array'),redacted_commands jsonb NOT NULL CHECK(jsonb_typeof(redacted_commands)='array'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,command_key)
);
CREATE TRIGGER requirement_deletion_events_immutable BEFORE UPDATE OR DELETE ON app.requirement_deletion_events FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
ALTER TABLE app.commands ADD COLUMN response_redacted_at timestamptz;
ALTER TABLE app.operations_file_gc DROP CONSTRAINT operations_file_gc_reason_check;
ALTER TABLE app.operations_file_gc ADD CONSTRAINT operations_file_gc_reason_check CHECK(reason IN ('privacyDeletion','temporaryUnreferenced','uploadAttempt','requirementDeletion'));

-- A new dependent FK is protected by default. Only the deleted requirement's own material
-- versions, participants and empty personal navigation metadata may be removed.
CREATE FUNCTION app.requirement_has_protected_history(project uuid,requirement uuid) RETURNS boolean LANGUAGE plpgsql AS $$
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
 RETURN false;
END;
$$;
CREATE FUNCTION app.guard_requirement_version_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM app.requirement_deletion_events e CROSS JOIN LATERAL jsonb_array_elements(e.version_manifest) v
  WHERE e.project_id=OLD.project_id AND e.requirement_id=OLD.requirement_id AND v->>'id'=OLD.id::text AND v->>'materialSetDigest'=OLD.material_set_digest)
  AND NOT app.requirement_has_protected_history(OLD.project_id,OLD.requirement_id) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Immutable requirement version history cannot be mutated' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER requirement_versions_immutable ON app.requirement_versions;
CREATE TRIGGER requirement_versions_immutable BEFORE UPDATE OR DELETE ON app.requirement_versions FOR EACH ROW EXECUTE FUNCTION app.guard_requirement_version_history();
CREATE FUNCTION app.guard_live_resource_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM app.file_resources WHERE id=NEW.resource_id AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Deleted file resource cannot accept a new reference' USING ERRCODE='23503';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER resource_references_live BEFORE INSERT OR UPDATE ON app.resource_references FOR EACH ROW EXECUTE FUNCTION app.guard_live_resource_reference();
