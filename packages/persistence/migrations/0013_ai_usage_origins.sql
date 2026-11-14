-- Validation origin is evidence, not a guess from account/model names.
-- Existing records remain legacyUnknown; no retrospective provider claim is made.
ALTER TABLE app.ai_tasks ADD COLUMN execution_origin text NOT NULL DEFAULT 'legacyUnknown'
  CHECK(execution_origin IN ('fixture','liveProvider','legacyUnknown'));
ALTER TABLE app.model_call_ledger ADD COLUMN execution_origin text NOT NULL DEFAULT 'legacyUnknown'
  CHECK(execution_origin IN ('fixture','liveProvider','legacyUnknown'));
ALTER TABLE app.model_call_ledger ADD COLUMN request_count integer CHECK(request_count IN (0,1));
ALTER TABLE app.model_call_ledger ADD COLUMN dispatch_certainty text NOT NULL DEFAULT 'unknown'
  CHECK(dispatch_certainty IN ('notDispatched','fetchInvoked','responseReceived','unknown'));
CREATE INDEX model_call_origin_user_idx ON app.model_call_ledger(execution_origin,initiator_user_id,started_at,id);
