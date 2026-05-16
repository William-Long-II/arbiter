-- Opt-in "gate on blocking findings". When a scope has this set, a review
-- with blocking findings is posted as REQUEST_CHANGES and a failing commit
-- status is set (a soft merge gate via branch protection). Off by default
-- so scopes that don't opt in keep the deliberately non-aggressive
-- COMMENT-only behavior. Snapshotted onto pending_reviews at enqueue time
-- (like auto_approve) so editing a scope never retroactively changes
-- already-queued reviews.
ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS gate_on_blocking BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS gate_on_blocking BOOLEAN NOT NULL DEFAULT FALSE;
