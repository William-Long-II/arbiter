-- Per-scope footer customization.
--
-- Tri-state nullable text:
--   NULL    → use the built-in default footer (preserves current behavior
--             for existing scopes without a backfill)
--   ''      → explicitly NO footer (don't append anything)
--   any text → use this string as a template; the worker substitutes
--              {{scrutiny}}, {{mode}}, {{verdict}}, {{posted_as}}
--
-- pending_reviews snapshots the template at enqueue time so editing the
-- scope later doesn't retroactively reformat in-flight or completed runs.

ALTER TABLE scopes
  ADD COLUMN IF NOT EXISTS footer_template TEXT;

ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS footer_template TEXT;
