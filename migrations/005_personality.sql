-- Per-scope reviewer "personality" — free-text guidance appended to the
-- scrutiny system prompt. Lets a scope target the same scrutiny tier
-- with extra context (e.g., "this is a Rust project, prefer idiomatic
-- patterns" or "be especially strict on auth code").
--
-- Snapshot to pending_reviews at enqueue time so editing the scope
-- doesn't retroactively reformat in-flight runs.

ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS personality_prompt TEXT;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS personality_prompt TEXT;
