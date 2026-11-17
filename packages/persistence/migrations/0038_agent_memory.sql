CREATE TABLE app.agent_memory_heads (
  owner_id uuid PRIMARY KEY REFERENCES app.users(id),
  enabled boolean NOT NULL DEFAULT false,
  row_version integer NOT NULL DEFAULT 0 CHECK(row_version>=0)
);
CREATE TABLE app.agent_memories (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
  enabled boolean NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_memories_owner ON app.agent_memories(owner_id,updated_at,id);
