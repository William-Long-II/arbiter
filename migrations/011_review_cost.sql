-- Cost (USD) of the model call that produced a review.
--
-- `claude -p --output-format json` reports total_cost_usd, which the runner
-- already parses (review/format.ts → ReviewOutput.costUsd) and, until now,
-- threw away. Persisting it gives per-review and aggregate spend visibility
-- — the foundation for budget caps later.
--
-- Nullable on purpose:
--   * API-mode reviews don't report a cost.
--   * Rows that existed before this migration have none.
--   * Structural skips (diff too large) never ran a model call.
-- DOUBLE PRECISION (not NUMERIC) so postgres.js returns a JS number rather
-- than a string — fine for display + summing small dollar amounts.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;
