-- Bounded deferral for reviews that arrive while CI is still running.
--
-- When the worker fetches checks for a head SHA and finds at least one
-- pending check (and no failing ones), it sets defer_until = NOW() + 2min
-- and bumps defer_count instead of producing a half-blind review.
-- The claim query skips rows whose defer_until is still in the future,
-- so the worker effectively re-checks 2 minutes later.
--
-- After ~10 defers (~20 minutes) the worker proceeds anyway with whatever
-- signals it has. CI that takes longer than 20 minutes shouldn't block
-- review feedback indefinitely; the prompt will note the still-pending
-- checks under non-blocking.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS defer_until TIMESTAMPTZ;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS defer_count INT NOT NULL DEFAULT 0;

-- Index supports the worker's claim filter — `status = 'queued' AND
-- (defer_until IS NULL OR defer_until <= NOW())` — without scanning
-- terminal rows.
CREATE INDEX IF NOT EXISTS pending_reviews_queued_defer_idx
  ON pending_reviews (defer_until)
  WHERE status = 'queued';
