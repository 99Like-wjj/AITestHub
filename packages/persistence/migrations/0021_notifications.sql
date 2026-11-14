CREATE TABLE app.notification_dispatches(event_id uuid PRIMARY KEY REFERENCES app.outbox(id),processed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE app.notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id uuid NOT NULL REFERENCES app.users(id),event_id uuid NOT NULL REFERENCES app.outbox(id),
 project_id uuid REFERENCES app.projects(id),kind text NOT NULL CHECK(kind IN ('requirementReview','assetReview','reportReady','scheduleCompleted','issueNotDefect','uploadInterrupted')),
 object_id uuid NOT NULL,title text NOT NULL,target_path text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(recipient_id,event_id)
);
CREATE INDEX notifications_recipient_recent_idx ON app.notifications(recipient_id,created_at DESC,id);
