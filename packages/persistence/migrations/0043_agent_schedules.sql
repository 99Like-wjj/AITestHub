CREATE TABLE app.agent_schedules (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid REFERENCES app.ai_conversations(id),
  title text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reminder','draft')),
  message text NOT NULL,
  rule jsonb NOT NULL,
  template jsonb,
  state text NOT NULL CHECK(state IN ('active','paused','cancelled','finished')),
  next_point jsonb,
  next_decision_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_schedules_due_idx ON app.agent_schedules(next_decision_at,id) WHERE state='active';
CREATE INDEX agent_schedules_owner_idx ON app.agent_schedules(owner_id,created_at DESC,id);
CREATE TABLE app.agent_schedule_occurrences (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES app.agent_schedules(id),
  owner_id uuid NOT NULL REFERENCES app.users(id),
  conversation_id uuid REFERENCES app.ai_conversations(id),
  schedule_revision integer NOT NULL,
  point jsonb NOT NULL,
  wall_date date NOT NULL,
  wall_time text NOT NULL,
  snapshot jsonb,
  state text NOT NULL CHECK(state IN ('claimed','dispatching','enqueued','completed','failed','blocked','missed','skipped','cancelled','unknown')),
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  task_id uuid REFERENCES app.ai_tasks(id),
  error_code text,
  missed_through_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(schedule_id,schedule_revision,wall_date,wall_time)
);
CREATE INDEX agent_schedule_occurrences_live_idx ON app.agent_schedule_occurrences(state,lease_expires_at);
ALTER TABLE app.ai_tasks ADD COLUMN execution_policy text NOT NULL DEFAULT 'interactive' CHECK(execution_policy IN ('interactive','draftOnly'));
ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('requirementReview','assetReview','reportReady','scheduleCompleted','issueNotDefect','uploadInterrupted','agentReminder','agentTaskReady'));
CREATE FUNCTION app.redact_agent_schedules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_schedules SET state='cancelled',title='[已删除会话的定时任务]',message='',template=NULL,next_point=NULL,next_decision_at=NULL,row_version=row_version+1,updated_at=clock_timestamp() WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
    UPDATE app.agent_schedule_occurrences SET snapshot=NULL,state=CASE WHEN state IN ('claimed','dispatching') THEN 'unknown' ELSE state END,error_code=CASE WHEN state IN ('claimed','dispatching') THEN 'CONVERSATION_DELETED' ELSE error_code END WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
    DELETE FROM app.notifications WHERE recipient_id=NEW.owner_id AND kind IN ('agentReminder','agentTaskReady') AND object_id IN (SELECT id FROM app.agent_schedule_occurrences WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id);
    UPDATE app.commands SET response=NULL,response_redacted_at=clock_timestamp() WHERE actor_id=NEW.owner_id AND operation LIKE 'agent-schedules.%' AND response->'schedule'->>'conversationId'=NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER redact_agent_schedules AFTER UPDATE OF deleted_at ON app.ai_conversations FOR EACH ROW EXECUTE FUNCTION app.redact_agent_schedules();
