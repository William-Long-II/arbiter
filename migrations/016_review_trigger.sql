-- Distinguish auto-ingested reviews (poller / webhook) from deliberate
-- manual ones (a user-initiated re-review). The unique index that collapses
-- a poller+webhook race on the same push must NOT block a manual re-run on
-- the same head SHA, so it becomes PARTIAL: only 'auto' rows are unique on
-- (repo, pr, sha). Manual rows can stack, giving a history of re-runs you
-- can compare (the queue-detail "Prior runs" list already renders them).
--
-- ("trigger" alone is a reserved word in Postgres; trigger_source avoids
-- quoting it everywhere.)
ALTER TABLE pending_reviews
  ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (trigger_source IN ('auto', 'manual'));

-- Existing rows are all 'auto' (the default), and each had exactly one row
-- per (repo, pr, sha) under the old index, so re-creating it as partial
-- can't conflict.
DROP INDEX IF EXISTS pending_reviews_unique_head;

CREATE UNIQUE INDEX IF NOT EXISTS pending_reviews_unique_head
  ON pending_reviews(repo_full, pr_number, head_sha)
  WHERE trigger_source = 'auto';
