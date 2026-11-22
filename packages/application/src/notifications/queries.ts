/** Current membership also gates historical notification links. */
export const canReadNotification = `n.recipient_id=$1
 AND EXISTS(SELECT 1 FROM app.users u WHERE u.id=$1 AND u.active)
 AND (n.project_id IS NULL OR EXISTS(
   SELECT 1 FROM app.project_members m JOIN app.projects p ON p.id=m.project_id
   WHERE m.project_id=n.project_id AND m.user_id=$1 AND m.active AND p.active AND (
     n.kind='uploadInterrupted'
     OR (n.kind='issueNotDefect' AND 'developer'=ANY(m.roles))
     OR (n.kind IN ('issueAssigned','issueReturned') AND m.roles && ARRAY['developer','tester']::text[])
     OR (n.kind NOT IN ('issueNotDefect','uploadInterrupted','issueAssigned','issueReturned') AND 'tester'=ANY(m.roles))
   )
 ))`;

/** Derived lanes leave the original notices and individual read dates intact. */
export const notificationView = `WITH candidate AS (
  SELECT n.*,
    p.name project_name,
    v.version_no requirement_version_no,
    req.id requirement_id,
    req.title requirement_title,
    a.kind asset_kind,
    ar.content->>'title' asset_title,
    ar.id asset_revision_id,
    ar.revision_no asset_revision_no,
    issue.number issue_number,
    issue.title issue_title,
    run.state run_state,
    CASE
      WHEN n.kind='assetReview' THEN
        a.kind='UI' AND a.removed_at IS NULL AND a.review_state IN ('pending','aiOptimized')
        AND a.current_revision_id=ar.id AND req.archived_at IS NULL
        AND e.actor_id IS DISTINCT FROM n.recipient_id
        AND (req.created_by=n.recipient_id OR EXISTS (
          SELECT 1 FROM app.requirement_participants rp
          WHERE rp.requirement_id=req.id AND rp.user_id=n.recipient_id AND rp.active
        ))
      WHEN n.kind IN ('issueAssigned','issueReturned') THEN
        responsibility.id=e.id AND issue.assignee_id=n.recipient_id
        AND issue.state IN ('pending','inProgress') AND req.archived_at IS NULL
      WHEN n.kind='issueRetest' THEN
        responsibility.id=e.id AND issue.submitted_by=n.recipient_id
        AND issue.state='awaitingRetest' AND req.archived_at IS NULL
      WHEN n.kind='uploadInterrupted' THEN
        file.owner_user_id=n.recipient_id AND file.status='failed'
        AND file.deleted_at IS NULL AND file.attempt::text=e.payload->>'attempt'
      WHEN n.kind='reportReady' THEN
        run.created_by=n.recipient_id AND (
          run.state IN ('interrupted','recoveryRequired') OR (
            run.state IN ('completed','terminated') AND run.delivery_status='incomplete'
          )
        )
      ELSE n.kind='agentReminder'
    END actionable,
    n.kind || ':' || COALESCE(n.project_id::text,'personal') || ':' ||
      CASE
        WHEN n.kind='assetReview' AND v.id IS NOT NULL THEN v.id::text || ':' || a.kind
        WHEN n.kind='requirementReview' THEN n.object_id::text
        WHEN n.kind='reportReady' THEN COALESCE(run.plan_id,req.id,run.id,n.object_id)::text
        WHEN n.kind IN ('issueAssigned','issueRetest','issueReturned','issueNotDefect') THEN COALESCE(req.id,n.object_id)::text
        WHEN n.kind IN ('agentReminder','uploadInterrupted') THEN n.id::text
        ELSE n.object_id::text
      END group_key
  FROM app.notifications n
  JOIN app.outbox e ON e.id=n.event_id
  LEFT JOIN app.projects p ON p.id=n.project_id
  LEFT JOIN app.test_assets a ON n.kind='assetReview' AND a.project_id=n.project_id AND a.id=n.object_id
  LEFT JOIN app.asset_revisions ar ON ar.asset_id=a.id AND ar.id::text=e.payload->>'revisionId'
  LEFT JOIN app.issues issue ON n.kind IN ('issueAssigned','issueRetest','issueReturned','issueNotDefect')
    AND issue.project_id=n.project_id AND issue.id=n.object_id
  LEFT JOIN app.requirement_versions v ON v.project_id=n.project_id AND (
    v.id=COALESCE(a.requirement_version_id,issue.requirement_version_id)
    OR (n.kind='requirementReview' AND v.requirement_id=n.object_id AND v.id::text=e.payload->>'versionId')
  )
  LEFT JOIN app.reports report ON n.kind='reportReady' AND report.project_id=n.project_id AND report.id=n.object_id
  LEFT JOIN app.runs run ON run.project_id=report.project_id AND run.id=report.run_id
  LEFT JOIN LATERAL (
    SELECT min(COALESCE(rv.requirement_id::text,item->>'requirementId')) requirement_id
    FROM jsonb_array_elements(run.scope_snapshot->'items') item
    LEFT JOIN app.requirement_versions rv ON rv.project_id=n.project_id AND rv.id::text=item->>'requirementVersionId'
    HAVING count(DISTINCT COALESCE(rv.requirement_id::text,item->>'requirementId'))=1
  ) run_scope ON run.plan_id IS NULL
  LEFT JOIN app.requirements req ON req.project_id=n.project_id AND (
    req.id=COALESCE(v.requirement_id,issue.requirement_id)
    OR (n.kind='requirementReview' AND req.id=n.object_id)
    OR req.id::text=run_scope.requirement_id
  )
  LEFT JOIN app.file_resources file ON n.kind='uploadInterrupted' AND file.id=n.object_id
  LEFT JOIN LATERAL (
    SELECT prior.id FROM app.outbox prior
    WHERE prior.project_id=issue.project_id AND prior.aggregate_id=issue.id
      AND prior.payload->>'notificationResponsibilityChanged'='true'
    ORDER BY prior.seq DESC LIMIT 1
  ) responsibility ON n.kind IN ('issueAssigned','issueRetest','issueReturned')
  WHERE ${canReadNotification}
), notification_view AS MATERIALIZED (
  SELECT *, CASE
    WHEN actionable AND (
      kind <> 'assetReview' OR row_number() OVER (
        PARTITION BY kind,project_id,object_id
        ORDER BY actionable DESC NULLS LAST,created_at DESC,id DESC
      )=1
    ) THEN 'attention' ELSE 'activity' END lane
  FROM candidate
)`;

export const groupWatermark = `to_char(head.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
