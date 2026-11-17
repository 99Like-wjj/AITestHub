-- File provenance is additive. Existing immutable versions and receipts keep their bytes.
ALTER TABLE app.agent_workspace_entries
  ADD COLUMN kind text NOT NULL DEFAULT 'legacy' CHECK(kind IN ('original','artifact','legacy')),
  ADD COLUMN original_name text,
  ADD COLUMN origin_message_id uuid REFERENCES app.ai_messages(id),
  ADD COLUMN origin_resource_id uuid REFERENCES app.file_resources(id);
ALTER TABLE app.agent_workspace_versions
  ADD COLUMN created_by uuid REFERENCES app.users(id),
  ADD COLUMN message_id uuid REFERENCES app.ai_messages(id),
  ADD COLUMN task_id uuid REFERENCES app.ai_tasks(id),
  ADD COLUMN base_revision integer CHECK(base_revision>0),
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(sources)='array');
ALTER TABLE app.agent_workspace_commands
  ADD COLUMN request_path text,
  ADD COLUMN request_expected_row_version integer;
CREATE TABLE app.agent_workspace_message_links (
  entry_id uuid NOT NULL REFERENCES app.agent_workspace_entries(id),
  message_id uuid NOT NULL REFERENCES app.ai_messages(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(entry_id,message_id)
);
CREATE UNIQUE INDEX agent_workspace_original_resource_idx
  ON app.agent_workspace_entries(conversation_id,origin_resource_id) WHERE kind='original';
CREATE INDEX agent_workspace_center_idx ON app.agent_workspace_entries(owner_id,created_at DESC,id DESC);

-- Only persisted calculation receipts prove an old entry is an AI artifact.
UPDATE app.agent_workspace_entries e SET kind='artifact'
WHERE EXISTS (
  SELECT 1 FROM app.agent_calculation_runs r,
    LATERAL jsonb_array_elements(r.artifacts) a
  WHERE r.owner_id=e.owner_id AND r.conversation_id=e.conversation_id
    AND a->'entry'->>'id'=e.id::text
);

-- Explicit user attachment references prove an original. Unknown legacy files retain their versions.
CREATE TEMP TABLE file_center_original_sources ON COMMIT DROP AS
SELECT DISTINCT ON(c.id,f.id) c.id conversation_id,c.owner_id,m.id message_id,f.id resource_id,
  f.original_name,m.created_at
FROM app.ai_conversations c JOIN app.ai_messages m ON m.conversation_id=c.id
CROSS JOIN LATERAL jsonb_array_elements(m.explicit_refs) ref
JOIN app.file_resources f ON ref->'reference'->>'kind'='resource'
  AND ref->'reference'->>'resourceId'=f.id::text
WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL AND m.role='user'
  AND ((f.owner_scope='personal' AND f.owner_user_id=c.owner_id) OR f.owner_scope='project')
  AND f.local_file_id NOT LIKE 'workspace:%'
  AND f.status='verified' AND f.deleted_at IS NULL
ORDER BY c.id,f.id,m.created_at,m.id;

UPDATE app.agent_workspace_entries e SET kind='original',original_name=s.original_name,
  origin_message_id=s.message_id,origin_resource_id=s.resource_id
FROM file_center_original_sources s,app.agent_workspace_versions v
WHERE e.conversation_id=s.conversation_id AND e.owner_id=s.owner_id
  AND e.kind='legacy' AND e.revision=1 AND e.deleted_at IS NULL
  AND v.entry_id=e.id AND v.revision=1 AND v.resource_id=s.resource_id
  AND NOT EXISTS(SELECT 1 FROM app.agent_workspace_entries other
    JOIN app.agent_workspace_versions ov ON ov.entry_id=other.id AND ov.revision=1
    WHERE other.conversation_id=e.conversation_id AND other.kind='legacy' AND other.revision=1
      AND other.deleted_at IS NULL AND ov.resource_id=s.resource_id AND other.id<e.id);

-- Historical user paths can occupy any namespace. Use a fresh flat identity path,
-- and explicitly avoid both exact paths and virtual directory prefixes; never skip an attachment.
DO $$
DECLARE source record; entry_id uuid; entry_path text;
BEGIN
  FOR source IN SELECT s.* FROM file_center_original_sources s
    WHERE NOT EXISTS(SELECT 1 FROM app.agent_workspace_entries e
      WHERE e.conversation_id=s.conversation_id AND e.kind='original' AND e.origin_resource_id=s.resource_id)
    ORDER BY s.conversation_id,s.resource_id
  LOOP
    LOOP
      entry_id := gen_random_uuid();
      entry_path := 'original-'||source.resource_id::text||'-'||entry_id::text;
      EXIT WHEN NOT EXISTS(SELECT 1 FROM app.agent_workspace_entries e
        WHERE e.conversation_id=source.conversation_id
          AND (e.path=entry_path OR starts_with(e.path,entry_path||'/')));
    END LOOP;
    INSERT INTO app.agent_workspace_entries(id,conversation_id,owner_id,path,kind,original_name,
      origin_message_id,origin_resource_id,created_at,updated_at)
    VALUES(entry_id,source.conversation_id,source.owner_id,entry_path,'original',source.original_name,
      source.message_id,source.resource_id,source.created_at,source.created_at);
    INSERT INTO app.agent_workspace_versions(entry_id,revision,resource_id,created_by,message_id)
    VALUES(entry_id,1,source.resource_id,source.owner_id,source.message_id);
  END LOOP;
END;
$$;

INSERT INTO app.agent_workspace_message_links(entry_id,message_id)
SELECT DISTINCT e.id,m.id FROM app.agent_workspace_entries e
JOIN app.ai_messages m ON m.conversation_id=e.conversation_id AND m.role='user'
CROSS JOIN LATERAL jsonb_array_elements(m.explicit_refs) ref
WHERE e.kind='original' AND ref->'reference'->>'kind'='resource'
  AND ref->'reference'->>'resourceId'=e.origin_resource_id::text
ON CONFLICT DO NOTHING;
