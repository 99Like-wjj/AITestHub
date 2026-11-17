ALTER TABLE app.agent_schedules DROP CONSTRAINT agent_schedules_kind_check;
ALTER TABLE app.agent_schedules ADD CONSTRAINT agent_schedules_kind_check CHECK(kind IN ('reminder','draft','office'));
ALTER TABLE app.ai_tasks DROP CONSTRAINT ai_tasks_execution_policy_check;
ALTER TABLE app.ai_tasks ADD CONSTRAINT ai_tasks_execution_policy_check CHECK(execution_policy IN ('interactive','draftOnly','officeOnly'));
