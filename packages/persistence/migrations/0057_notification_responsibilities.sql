ALTER TABLE app.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE app.notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN (
    'requirementReview', 'assetReview', 'reportReady', 'scheduleCompleted',
    'issueNotDefect', 'uploadInterrupted', 'agentReminder', 'agentTaskReady',
    'issueAssigned', 'issueRetest', 'issueReturned'
  ));

CREATE INDEX outbox_issue_notification_responsibility_idx
  ON app.outbox(project_id, aggregate_id, seq DESC)
  WHERE payload->>'notificationResponsibilityChanged' = 'true';
