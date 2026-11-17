CREATE TABLE app.agent_retrieval_indexes (
  owner_id uuid NOT NULL REFERENCES app.users(id),
  source_key text NOT NULL CHECK(length(source_key)=64),
  source_kind text NOT NULL CHECK(source_kind IN ('resource','knowledge','conversation')),
  source_id uuid NOT NULL,
  source_stamp text NOT NULL CHECK(length(source_stamp)=64),
  model_revision text NOT NULL CHECK(length(model_revision) BETWEEN 1 AND 200),
  chunks jsonb NOT NULL CHECK(jsonb_typeof(chunks)='array'),
  vectors jsonb NOT NULL CHECK(jsonb_typeof(vectors)='array'),
  coverage jsonb NOT NULL CHECK(jsonb_typeof(coverage)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,source_key)
);
CREATE INDEX agent_retrieval_source ON app.agent_retrieval_indexes(source_kind,source_id);
CREATE FUNCTION app.invalidate_agent_retrieval_resource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.declared_sha256 IS DISTINCT FROM OLD.declared_sha256 THEN
    DELETE FROM app.agent_retrieval_indexes WHERE source_kind='resource' AND source_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_agent_retrieval_resource AFTER UPDATE ON app.file_resources FOR EACH ROW EXECUTE FUNCTION app.invalidate_agent_retrieval_resource();
CREATE FUNCTION app.invalidate_agent_retrieval_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
    DELETE FROM app.agent_retrieval_indexes WHERE source_kind='knowledge' AND source_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_agent_retrieval_knowledge AFTER UPDATE OF current_revision_id ON app.knowledge_entries FOR EACH ROW EXECUTE FUNCTION app.invalidate_agent_retrieval_knowledge();
CREATE FUNCTION app.invalidate_agent_retrieval_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM app.agent_retrieval_indexes WHERE source_kind='conversation' AND source_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_agent_retrieval_conversation AFTER UPDATE OF deleted_at ON app.ai_conversations FOR EACH ROW EXECUTE FUNCTION app.invalidate_agent_retrieval_conversation();
CREATE FUNCTION app.invalidate_agent_retrieval_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.explicit_refs IS DISTINCT FROM OLD.explicit_refs OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM app.agent_retrieval_indexes WHERE source_kind='conversation' AND source_id=NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_agent_retrieval_message AFTER UPDATE OF content,explicit_refs,deleted_at ON app.ai_messages FOR EACH ROW EXECUTE FUNCTION app.invalidate_agent_retrieval_message();
