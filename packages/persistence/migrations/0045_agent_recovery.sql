-- Additive recovery availability; existing entry IDs and saved bodies remain unchanged.
ALTER TABLE app.agent_memories ADD COLUMN availability text NOT NULL DEFAULT 'available'
  CHECK(availability IN ('available','restoredNeedsReview'));
ALTER TABLE app.agent_memory_heads ADD COLUMN restore_gaps jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(restore_gaps)='array');
