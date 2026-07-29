-- Comment-triggered re-review.
--
-- A review that ends in `request-changes` posts a blocking GitHub review. If
-- the blocking finding was wrong, the author's only recourse was to push a
-- commit: nothing else re-runs arbiter. `pull_request` webhooks fire on
-- `synchronize`, and auto rows dedupe on (repo, pr, head_sha), so an author
-- replying "that's not what the code says" was shouting into a void — the
-- review never re-read the PR and the block never lifted. Arbiter could
-- demand a code change in order to answer a question that needed none.
--
-- 'comment' rows are enqueued when the PR author replies under a blocking
-- review. They deliberately sit OUTSIDE the partial unique index (which
-- covers only 'auto'), so they stack on an unchanged head SHA — that is the
-- whole point: same commit, new argument.
ALTER TABLE pending_reviews
  DROP CONSTRAINT IF EXISTS pending_reviews_trigger_source_check;

ALTER TABLE pending_reviews
  ADD CONSTRAINT pending_reviews_trigger_source_check
    CHECK (trigger_source IN ('auto', 'manual', 'comment'));
