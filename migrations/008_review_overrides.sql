-- Record when a user manually overrides the worker's auto-approval decision.
--
-- Background: pickEvent() in worker.ts only posts as APPROVE when (a) the
-- scope opted in, (b) the reviewer's verdict was 'approve', and (c) the PR
-- isn't authored by the reviewer. Anything else gets posted as COMMENT.
--
-- Sometimes the model flagged a "blocking issue" the user disagrees with —
-- a stylistic nit or speculative concern that shouldn't have stopped the
-- merge. This table records each manual approve-anyway action so it shows
-- on the queue detail page and so the data is available for future tuning
-- of the "issue vs suggestion" line in the scrutiny prompts.
--
-- One override per review; the unique index makes the approve-anyway POST
-- idempotent even if the user double-clicks.
CREATE TABLE IF NOT EXISTS review_overrides (
  id              BIGSERIAL PRIMARY KEY,
  review_id       BIGINT NOT NULL REFERENCES pending_reviews(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  override_event  TEXT NOT NULL CHECK (override_event IN ('APPROVE')),
  reason          TEXT,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_overrides_review_id_uniq
  ON review_overrides (review_id);

CREATE INDEX IF NOT EXISTS review_overrides_user_id_idx
  ON review_overrides (user_id, posted_at DESC);
