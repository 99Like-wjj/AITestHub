ALTER TABLE app.business_confirmations
  DROP CONSTRAINT business_confirmations_resolution_source_check;

ALTER TABLE app.business_confirmations
  ADD CONSTRAINT business_confirmations_resolution_source_check
  CHECK (resolution_source IN ('web-user-event','mcp-form-elicitation','mcp-chat-authorization'));

CREATE TABLE app.result_step_evidence_links (
  result_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  result_revision_id uuid NOT NULL,
  step_ordinal integer NOT NULL CHECK (step_ordinal BETWEEN 1 AND 100),
  PRIMARY KEY(result_id,evidence_id,result_revision_id,step_ordinal),
  FOREIGN KEY(result_id,evidence_id) REFERENCES app.result_evidence_links(result_id,evidence_id),
  FOREIGN KEY(result_id,result_revision_id) REFERENCES app.result_revisions(result_id,id)
);
