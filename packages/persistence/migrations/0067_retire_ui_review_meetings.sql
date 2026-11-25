ALTER TABLE app.review_opinions
  ADD COLUMN resolved_approval_id uuid REFERENCES app.approval_snapshots(id);

CREATE INDEX review_opinions_open_case_idx ON app.review_opinions(asset_id,created_at,id)
  WHERE removed_at IS NULL AND resolved_approval_id IS NULL;

-- Existing direct suggestions already followed by an approval remain concluded.
UPDATE app.review_opinions o SET resolved_approval_id=(
  SELECT p.id FROM app.approval_snapshots p
  WHERE p.project_id=o.project_id AND p.case_id=o.asset_id AND p.kind='UI'
    AND p.approved_at>=o.created_at
  ORDER BY p.approval_sequence LIMIT 1
) WHERE o.kind='UI' AND o.removed_at IS NULL;

-- Recompute only the stage left by the retired flow, using direct review records.
WITH current_stage AS (
  SELECT a.id,CASE
    WHEN EXISTS(SELECT 1 FROM app.review_opinions o
      WHERE o.asset_id=a.id AND o.removed_at IS NULL AND o.resolved_approval_id IS NULL
        AND (o.revision_id=a.current_revision_id OR NOT EXISTS(SELECT 1 FROM app.optimization_notes n
          WHERE n.asset_id=a.id AND n.opinion_id=o.id AND n.target_revision_id=a.current_revision_id)))
      THEN 'needsOptimization'
    WHEN EXISTS(SELECT 1 FROM app.review_opinions o
      WHERE o.asset_id=a.id AND o.removed_at IS NULL AND o.resolved_approval_id IS NULL)
      THEN 'aiOptimized'
    ELSE 'pending'
  END new_stage
  FROM app.test_assets a WHERE a.kind='UI' AND a.target_type='case' AND a.removed_at IS NULL
    AND a.review_state IN ('needsOptimization','aiOptimized')
    AND EXISTS(SELECT 1 FROM app.ui_review_meetings m WHERE m.project_id=a.project_id AND m.case_ids @> ARRAY[a.id])
)
UPDATE app.test_assets a SET review_state=s.new_stage,row_version=a.row_version+1
  FROM current_stage s WHERE s.id=a.id AND a.review_state<>s.new_stage;

ALTER TABLE app.ui_case_supplement_origins DISABLE TRIGGER ui_case_supplement_origins_immutable;
DELETE FROM app.ui_case_supplement_origins WHERE origin ? 'meetingId';
ALTER TABLE app.ui_case_supplement_origins ENABLE TRIGGER ui_case_supplement_origins_immutable;

UPDATE app.business_confirmations SET expires_at=LEAST(expires_at,clock_timestamp())
  WHERE tool_name='ath_reviews' AND operation LIKE 'meeting-%' AND state='waitingConfirmation';

DROP TABLE app.ui_review_meetings;
