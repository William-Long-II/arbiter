-- Opt-in post-processing: when humanize is true AND personality_prompt is
-- set, the runner makes a second LLM call after the review parses to
-- rewrite the prose body in the personality's voice. Off by default —
-- doubles latency + cost per review, but the only reliable way to fix
-- the "very AI" tone of skill-driven reviews (the skill's own format
-- usually drowns out a personality appended to its system prompt).
--
-- Snapshotted to pending_reviews at enqueue time, same shape as
-- personality_prompt / reviewer_skill, so a later scope edit doesn't
-- retroactively change how an in-flight review is rendered.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS humanize BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS humanize BOOLEAN NOT NULL DEFAULT FALSE;
