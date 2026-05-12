-- Per-scope trigger mode: which PRs the poller picks up.
--
-- 'open'             — every open non-draft PR matching the scope (existing
--                      behavior; default so old scopes don't change).
-- 'review_requested' — only PRs where the OAuth'd user (or one of their teams)
--                      is in the requested-reviewers list. This is what the
--                      "@me" half of GitHub's UI uses and matches the human
--                      intent "review what someone asked me to review."
--
-- Stored as text rather than an enum so future modes (e.g. 'ready_for_review')
-- don't require a migration.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS trigger_mode TEXT NOT NULL DEFAULT 'open';

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard it manually.
-- Without this, replaying the migration on a DB that already has the
-- constraint (e.g. picked up under a previous filename before this one
-- was renamed) crashes with 42710.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scopes_trigger_mode_check'
      AND conrelid = 'scopes'::regclass
  ) THEN
    ALTER TABLE scopes
      ADD CONSTRAINT scopes_trigger_mode_check
      CHECK (trigger_mode IN ('open', 'review_requested'));
  END IF;
END $$;
