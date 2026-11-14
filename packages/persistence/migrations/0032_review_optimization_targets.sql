-- Keep all original opinion/note/approval rows unchanged. Legacy notes retain NULL
-- relationship columns and are read as source=target=their original opinion revision.
ALTER TABLE app.review_opinions ADD CONSTRAINT review_opinions_revision_identity
  UNIQUE(project_id,kind,set_id,asset_id,revision_id,id);
ALTER TABLE app.optimization_notes
  ADD COLUMN source_opinion_revision_id uuid,
  ADD COLUMN target_revision_id uuid,
  ADD CONSTRAINT optimization_notes_revision_pair CHECK (
    (source_opinion_revision_id IS NULL AND target_revision_id IS NULL)
    OR (source_opinion_revision_id IS NOT NULL AND target_revision_id IS NOT NULL)
  ),
  ADD CONSTRAINT optimization_notes_source_revision_fk
    FOREIGN KEY(project_id,kind,set_id,asset_id,source_opinion_revision_id,opinion_id)
    REFERENCES app.review_opinions(project_id,kind,set_id,asset_id,revision_id,id),
  ADD CONSTRAINT optimization_notes_target_revision_fk
    FOREIGN KEY(project_id,kind,set_id,asset_id,target_revision_id)
    REFERENCES app.asset_revisions(project_id,kind,set_id,asset_id,id);
CREATE INDEX optimization_notes_target_revision_idx
  ON app.optimization_notes(asset_id,target_revision_id,created_at,id);
