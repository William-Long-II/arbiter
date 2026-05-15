-- Sub-status for an in-flight review so the queue UI can show *where* a
-- running review is, not just that it's "running".
--
-- The worker's processJob goes: claim (preparing) -> fetch PR/diff/CI
-- -> runReview (reviewing, the multi-minute claude -p call) -> post
-- (posting) -> done. Status alone collapses all of that into "running";
-- this column distinguishes the phases. NULL whenever the row isn't
-- running (queued/deferred/done/failed/skipped) — status conveys those.
ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS phase TEXT;
