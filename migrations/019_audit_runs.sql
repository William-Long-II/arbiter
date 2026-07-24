-- Time Machine: report-only retro-audit of already-merged PRs.
--
-- An "audit run" back-reviews the last N merged PRs in a repo so the
-- operator can find issues that shipped to main without any PR-triggered
-- review ever seeing them. The reviews it enqueues are REPORT-ONLY: the
-- worker generates + persists the review (body, verdict, findings) exactly
-- as usual, but posts NOTHING to GitHub — no comment, no inline threads, no
-- commit status. That makes the blast radius of even a noisy first run
-- literally zero (it also sidesteps 422s that GitHub returns on
-- REQUEST_CHANGES against a closed/merged PR), so the audit is safe to run
-- five minutes after install on a repo full of strangers' history.

CREATE TABLE IF NOT EXISTS audit_runs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full       TEXT NOT NULL,
  scrutiny        TEXT NOT NULL,
  review_context  TEXT NOT NULL DEFAULT 'isolated',
  -- How many merged PRs the operator asked to audit. The number actually
  -- enqueued can be smaller (a repo with fewer merged PRs than requested).
  requested_count INT NOT NULL,
  enqueued_count  INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_runs_user_id_idx
  ON audit_runs (user_id, created_at DESC);

-- When true the worker generates + persists the review but performs ZERO
-- GitHub mutation. Default FALSE so every existing enqueue path (poller,
-- webhook, manual re-review) is unaffected.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS report_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Groups a report-only row into the audit run that spawned it. ON DELETE
-- SET NULL mirrors prior_review_id (018): retention can prune the run
-- without orphan-blocking the review row, and vice versa.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS audit_run_id BIGINT REFERENCES audit_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pending_reviews_audit_run_id_idx
  ON pending_reviews (audit_run_id);
