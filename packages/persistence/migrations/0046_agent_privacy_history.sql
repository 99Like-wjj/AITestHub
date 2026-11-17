-- Privacy removes bodies and future authority without rewriting known execution facts.
CREATE OR REPLACE FUNCTION app.redact_agent_calculation_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_calculation_runs
    SET state=CASE WHEN state='prepared' THEN 'cancelled'
                   WHEN state IN ('running','publishing') THEN 'unknown'
                   ELSE state END,
        request='{}'::jsonb,source_snapshot='[]'::jsonb,sandbox_result=NULL,
        artifacts='[]'::jsonb,cancel_requested=true,
        error_code=CASE WHEN state IN ('prepared','running','publishing')
                        THEN 'CONVERSATION_DELETED' ELSE error_code END,
        finished_at=CASE WHEN state='prepared'
                         THEN COALESCE(finished_at,NEW.deleted_at) ELSE finished_at END
    WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.redact_agent_browser() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_browser_operations
    SET plan=NULL,
        state=CASE WHEN state='waitingConfirmation' THEN 'cancelled'
                   WHEN state='dispatching' THEN 'unknown' ELSE state END,
        error_code=CASE WHEN state IN ('waitingConfirmation','dispatching')
                        THEN 'CONVERSATION_DELETED' ELSE error_code END,
        finished_at=CASE WHEN state='waitingConfirmation'
                         THEN COALESCE(finished_at,NEW.deleted_at) ELSE finished_at END,
        row_version=row_version+1
    WHERE owner_id=NEW.owner_id AND session_id IN (
      SELECT id FROM app.agent_browser_sessions
      WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id
    );
    UPDATE app.agent_browser_sessions
    SET state='closed',cleanup_pending=true,current_url=NULL,observation_id=NULL,
        observation_hash=NULL,document_id=NULL,row_version=row_version+1,updated_at=now()
    WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.redact_agent_schedules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE app.agent_schedules
    SET state=CASE WHEN state IN ('active','paused') THEN 'cancelled' ELSE state END,
        title='[已删除会话的定时任务]',message='',template=NULL,next_point=NULL,
        next_decision_at=NULL,row_version=row_version+1,updated_at=clock_timestamp()
    WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
    UPDATE app.agent_schedule_occurrences
    SET snapshot=NULL,
        state=CASE WHEN state='claimed' THEN 'cancelled'
                   WHEN state='dispatching' THEN 'unknown' ELSE state END,
        error_code=CASE WHEN state IN ('claimed','dispatching')
                        THEN 'CONVERSATION_DELETED' ELSE error_code END,
        finished_at=CASE WHEN state='claimed'
                         THEN COALESCE(finished_at,NEW.deleted_at) ELSE finished_at END
    WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id;
    DELETE FROM app.notifications
    WHERE recipient_id=NEW.owner_id AND kind IN ('agentReminder','agentTaskReady')
      AND object_id IN (
        SELECT id FROM app.agent_schedule_occurrences
        WHERE conversation_id=NEW.id AND owner_id=NEW.owner_id
      );
    UPDATE app.commands SET response=NULL,response_redacted_at=clock_timestamp()
    WHERE actor_id=NEW.owner_id AND operation LIKE 'agent-schedules.%'
      AND response->'schedule'->>'conversationId'=NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;
