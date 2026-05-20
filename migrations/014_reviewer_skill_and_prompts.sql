-- Optional reviewer skill name (e.g. 'bmad-code-review'). When set, the
-- worker invokes `claude -p` with a wrapper prompt that triggers the named
-- skill instead of using the built-in scrutiny system prompt. NULL keeps
-- the existing built-in path. Skill availability is a runtime concern
-- (the worker needs the skill installed at ~/.claude/skills/<name>); a
-- scope with a skill that isn't reachable will fail the review with the
-- subprocess's own error, which lands on the queue detail page.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS reviewer_skill TEXT;

-- Snapshotted from the matching scope at enqueue time, same as
-- personality_prompt et al. Kept on the row so a later scope edit doesn't
-- retroactively change how an already-queued review was generated.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS reviewer_skill TEXT;

-- Array of { label, prompt } system prompts actually used to generate the
-- review. JSONB so it can grow when a single review combines multiple
-- reviewer outputs (each parallel reviewer's system prompt is one entry).
-- Surfaced on the queue detail page so the operator can see and tune what
-- the model actually saw. Null = predates the column or never assembled
-- (e.g. structural skip before runReview was called).
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS prompts JSONB;
