CREATE TABLE app.agent_task_plans (
  conversation_id uuid PRIMARY KEY REFERENCES app.ai_conversations(id),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  source_stamp text NOT NULL CHECK(length(source_stamp) BETWEEN 1 AND 1000),
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.agent_context_archives (
  conversation_id uuid NOT NULL REFERENCES app.ai_conversations(id),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  source_stamp text NOT NULL CHECK(length(source_stamp) BETWEEN 1 AND 1000),
  record_id text NOT NULL CHECK(record_id ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(conversation_id,source_stamp,record_id)
);
CREATE INDEX agent_context_archives_owner_idx ON app.agent_context_archives(owner_id,conversation_id);
