CREATE TABLE app.business_confirmations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  origin text NOT NULL CHECK(origin IN ('internal-ai','official-mcp')),
  key_id uuid REFERENCES app.personal_keys(id),
  task_id uuid REFERENCES app.ai_tasks(id),
  conversation_id uuid REFERENCES app.ai_conversations(id),
  tool_name text NOT NULL CHECK(tool_name ~ '^ath_[a-z_]+$'),
  operation text NOT NULL,
  arguments jsonb NOT NULL CHECK(jsonb_typeof(arguments)='object'),
  scope_digest text NOT NULL CHECK(scope_digest ~ '^[a-f0-9]{64}$'),
  argument_digest text NOT NULL CHECK(argument_digest ~ '^[a-f0-9]{64}$'),
  proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
  state text NOT NULL DEFAULT 'waitingConfirmation' CHECK(state IN ('waitingConfirmation','executing','completed','declined','failed','unknown')),
  dispatch_claim boolean NOT NULL DEFAULT false,
  resolution_source text CHECK(resolution_source IN ('web-user-event','mcp-form-elicitation')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK((origin='official-mcp' AND key_id IS NOT NULL AND task_id IS NULL AND conversation_id IS NULL) OR
    (origin='internal-ai' AND key_id IS NULL AND task_id IS NOT NULL AND conversation_id IS NOT NULL))
);
CREATE INDEX business_confirmations_owner_task_idx ON app.business_confirmations(owner_id,task_id,created_at,id);
CREATE INDEX business_confirmations_proposal_idx ON app.business_confirmations(owner_id,origin,argument_digest,created_at);
