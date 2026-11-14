CREATE TABLE app.auxiliary_tasks(
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES app.users(id),project_id uuid REFERENCES app.projects(id),conversation_id uuid REFERENCES app.ai_conversations(id),
 command_id text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('alias','requirementLookup','sqlReview','issueAdvice')),
 origin text NOT NULL DEFAULT 'web' CHECK(origin IN ('web','internal-ai','official-mcp')),origin_key_id uuid REFERENCES app.personal_keys(id),parent_task_id uuid REFERENCES app.ai_tasks(id),
 request jsonb NOT NULL,source_snapshot jsonb NOT NULL,model_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','running','cancelling','completed','cancelled','failed','unknown')),
 worker_id uuid,lease_expires_at timestamptz,call_id uuid REFERENCES app.model_call_ledger(id),
 execution_origin text NOT NULL DEFAULT 'legacyUnknown' CHECK(execution_origin IN ('fixture','liveProvider','legacyUnknown')),
 result jsonb,error_code text,error_details jsonb,cancel_requested_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(owner_id,command_id),CHECK((origin='official-mcp')=(origin_key_id IS NOT NULL)),CHECK(origin<>'official-mcp' OR purpose<>'alias'),CHECK((origin='internal-ai')=(parent_task_id IS NOT NULL))
);
CREATE INDEX auxiliary_pending_idx ON app.auxiliary_tasks(state,created_at,id);
ALTER TABLE app.model_call_ledger ADD COLUMN auxiliary_task_id uuid REFERENCES app.auxiliary_tasks(id);
CREATE UNIQUE INDEX auxiliary_call_unique ON app.model_call_ledger(auxiliary_task_id) WHERE auxiliary_task_id IS NOT NULL;
ALTER TABLE app.model_call_ledger ADD CONSTRAINT auxiliary_call_binding_unique UNIQUE(auxiliary_task_id,id);
ALTER TABLE app.auxiliary_tasks ADD CONSTRAINT auxiliary_current_call_fk FOREIGN KEY(id,call_id)
 REFERENCES app.model_call_ledger(auxiliary_task_id,id) DEFERRABLE INITIALLY DEFERRED;
