-- Per-scope opt-in to auto-approve when the reviewer determines no blockers.
-- Snapshot the flag onto pending_reviews at enqueue time so changing the
-- scope later doesn't retroactively flip queued/in-flight reviews.

ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT FALSE;

-- Capture the verdict the reviewer emitted (parsed from the marker in the
-- review body). Useful for the queue UI and for filtering history.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS verdict TEXT
    CHECK (verdict IS NULL OR verdict IN ('approve','comment','request-changes'));

-- And which GitHub review event we actually posted (so the UI can show
-- whether we auto-approved or just commented).
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS posted_event TEXT
    CHECK (posted_event IS NULL OR posted_event IN ('APPROVE','COMMENT','REQUEST_CHANGES'));
