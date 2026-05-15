-- Per-scope review execution context: what the reviewer subprocess sees.
--
-- 'isolated' — run `claude -p` in a fresh empty temp directory. The model
--              reviews from the diff alone. This is the default and fixes
--              the prior behavior where the subprocess inherited the
--              container's /app cwd (arbiter's own source), confusing the
--              reviewer into "the working directory contains an unrelated
--              project" caveats and wasted filesystem exploration.
-- 'checkout' — shallow-checkout the PR's head commit into the temp dir so
--              the reviewer can verify cross-module references. Heavier
--              (clone per review); opt-in.
--
-- Snapshotted onto pending_reviews at enqueue time (like footer_template /
-- personality_prompt) so changing a scope doesn't retroactively alter
-- already-queued reviews. Stored as text (not enum) so future contexts
-- don't need a migration. Default 'isolated' so existing scopes/rows keep
-- working without change.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS review_context TEXT NOT NULL DEFAULT 'isolated';

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS review_context TEXT NOT NULL DEFAULT 'isolated';

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guard each manually so
-- replaying the migration is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scopes_review_context_check'
      AND conrelid = 'scopes'::regclass
  ) THEN
    ALTER TABLE scopes
      ADD CONSTRAINT scopes_review_context_check
      CHECK (review_context IN ('isolated', 'checkout'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_reviews_review_context_check'
      AND conrelid = 'pending_reviews'::regclass
  ) THEN
    ALTER TABLE pending_reviews
      ADD CONSTRAINT pending_reviews_review_context_check
      CHECK (review_context IN ('isolated', 'checkout'));
  END IF;
END $$;
