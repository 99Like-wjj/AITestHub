ALTER TABLE app.model_call_ledger ADD COLUMN logical_call_id uuid;
ALTER TABLE app.model_call_ledger ADD COLUMN attempt_no smallint CHECK(attempt_no BETWEEN 0 AND 5);
ALTER TABLE app.model_call_ledger ADD CONSTRAINT model_call_logical_pair CHECK((logical_call_id IS NULL)=(attempt_no IS NULL));
CREATE UNIQUE INDEX model_call_logical_attempt_unique ON app.model_call_ledger(logical_call_id,attempt_no) WHERE logical_call_id IS NOT NULL;
ALTER TABLE app.model_call_ledger ADD CONSTRAINT model_call_task_identity UNIQUE(id,task_id);
ALTER TABLE app.model_call_ledger ADD CONSTRAINT model_call_attempt_identity UNIQUE(id,logical_call_id,attempt_no);
ALTER TABLE app.ai_tasks ADD CONSTRAINT ai_task_assistant_identity UNIQUE(id,assistant_message_id);
CREATE TABLE app.ai_model_attempts(
 id uuid PRIMARY KEY,task_id uuid NOT NULL,assistant_message_id uuid NOT NULL,
 logical_call_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),attempt_no smallint NOT NULL CHECK(attempt_no BETWEEN 0 AND 5),
 max_retries smallint NOT NULL CHECK(max_retries BETWEEN 0 AND 5 AND attempt_no<=max_retries),
 prefix_length integer NOT NULL CHECK(prefix_length BETWEEN 0 AND 100000),
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','retryWait','completed','failed','cancelled')),
 visible_text text NOT NULL DEFAULT '' CHECK(char_length(visible_text)<=100000 AND octet_length(visible_text)<=400000),
 error_code text CHECK(error_code~'^[A-Z][A-Z0-9_]{0,79}$'),http_status smallint CHECK(http_status BETWEEN 100 AND 599),
 retry_at timestamptz,next_attempt_at timestamptz,content_redacted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 CHECK((state='retryWait')=(next_attempt_at IS NOT NULL)),
 UNIQUE(logical_call_id,attempt_no),UNIQUE(task_id,ordinal,attempt_no),
 FOREIGN KEY(task_id,assistant_message_id) REFERENCES app.ai_tasks(id,assistant_message_id),
 FOREIGN KEY(id,task_id) REFERENCES app.model_call_ledger(id,task_id),
 FOREIGN KEY(id,logical_call_id,attempt_no) REFERENCES app.model_call_ledger(id,logical_call_id,attempt_no)
);
CREATE INDEX ai_model_attempts_task_idx ON app.ai_model_attempts(task_id,ordinal,attempt_no,id);
