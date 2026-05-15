-- Self-reported issue counts by severity, parsed from the model's
-- `<!-- arbiter:findings={...} -->` marker (review/format.ts). JSONB so
-- the shape can grow later (e.g. per-finding items for inline comments)
-- without another migration. Nullable: the model may omit the marker, and
-- rows predating this column / structural skips have none.
ALTER TABLE pending_reviews
  ADD COLUMN IF NOT EXISTS findings JSONB;
