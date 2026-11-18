DROP TRIGGER automatic_group_name_intent ON app.ai_requirement_groups;
DROP TRIGGER automatic_group_default_cleared ON app.ai_requirement_groups;
DROP TRIGGER automatic_group_default_restored ON app.ai_requirement_groups;
DROP TRIGGER automatic_group_name_source_changed ON app.requirements;
DROP FUNCTION app.register_automatic_group_name_intent();
DROP FUNCTION app.register_cleared_group_default();
DROP FUNCTION app.invalidate_automatic_group_name_source();

ALTER TABLE app.auxiliary_tasks DROP CONSTRAINT auxiliary_tasks_origin_check;
ALTER TABLE app.auxiliary_tasks ADD CONSTRAINT auxiliary_tasks_origin_check
  CHECK (origin IN ('web', 'internal-ai', 'official-mcp', 'background'));
ALTER TABLE app.auxiliary_tasks ADD CONSTRAINT auxiliary_background_requirement_name
  CHECK (origin <> 'background' OR (purpose = 'alias' AND project_id IS NOT NULL AND conversation_id IS NULL));

ALTER TABLE app.requirements
  ADD COLUMN workspace_name_task_id uuid UNIQUE REFERENCES app.auxiliary_tasks(id),
  ADD COLUMN workspace_name text CHECK (length(workspace_name) BETWEEN 1 AND 80),
  ADD COLUMN workspace_name_title_hash text CHECK (workspace_name_title_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT requirement_workspace_name_source CHECK (
    (workspace_name IS NULL AND workspace_name_title_hash IS NULL) OR
    (workspace_name IS NOT NULL AND workspace_name_title_hash IS NOT NULL AND workspace_name_task_id IS NOT NULL)
  );
