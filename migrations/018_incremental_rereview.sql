-- Incremental re-review: when a PR already has a completed review, later
-- reviews can run against only the compare-delta (prior head → new head)
-- with the prior review supplied as context, instead of re-reviewing the
-- whole PR diff — a large token/latency saving on iterating PRs.
--
-- scopes.incremental_rereview: per-scope toggle, ON by default — the
-- worker falls back to a full review whenever the delta isn't clean
-- (rebase/force-push, merge-from-base, compare failure), so incremental
-- is a pure optimization, never a correctness dependency.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS incremental_rereview BOOLEAN NOT NULL DEFAULT TRUE;

-- pending_reviews.prior_review_id / prior_head_sha: the candidate prior
-- review snapshotted at enqueue time. Nullable — absent means "no prior
-- completed review existed" (or the scope opted out) and the row runs a
-- normal full review. ON DELETE SET NULL keeps retention pruning safe.
--
-- pending_reviews.incremental: set by the worker only when the delta path
-- actually ran (prior columns alone can't tell — the worker may have
-- fallen back). Drives the queue-detail "incremental" indicator.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS prior_review_id BIGINT REFERENCES pending_reviews(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prior_head_sha TEXT,
  ADD COLUMN IF NOT EXISTS incremental BOOLEAN NOT NULL DEFAULT FALSE;
