-- AITestHub owned runtime/checkpoint port, using LangGraph BaseCheckpointSaver serialization.
-- No third-party setup() or implicit schema migration runs at application startup.
CREATE TABLE app.ai_runtime_threads (
  conversation_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  project_id uuid REFERENCES app.projects(id),
  access_digest text NOT NULL CHECK(access_digest ~ '^[a-f0-9]{64}$'),
  active_run_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_runtime_threads_owner_idx ON app.ai_runtime_threads(owner_id,conversation_id);

CREATE TABLE app.ai_runtime_checkpoints (
  thread_key text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES app.ai_runtime_threads(conversation_id),
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  parent_checkpoint_id text,
  checkpoint_type text NOT NULL,
  checkpoint bytea NOT NULL,
  metadata_type text NOT NULL,
  metadata bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(thread_key,checkpoint_ns,checkpoint_id)
);
CREATE INDEX ai_runtime_checkpoint_conversation_idx ON app.ai_runtime_checkpoints(conversation_id,thread_key,checkpoint_id);

CREATE TABLE app.ai_runtime_checkpoint_writes (
  thread_key text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES app.ai_runtime_threads(conversation_id),
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  task_id text NOT NULL,
  idx integer NOT NULL,
  channel text NOT NULL,
  value_type text NOT NULL,
  value bytea NOT NULL,
  task_path text NOT NULL DEFAULT '',
  PRIMARY KEY(thread_key,checkpoint_ns,checkpoint_id,task_id,idx)
);
