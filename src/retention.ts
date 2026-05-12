import { config } from './config.ts';
import { sql } from './db.ts';

let timer: ReturnType<typeof setInterval> | null = null;
const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Prune terminal (`done`/`failed`/`skipped`) pending_reviews rows older than
 * `REVIEW_RETENTION_DAYS`. Set to 0 to disable.
 *
 * Skips non-terminal rows — `queued`/`running` are NEVER pruned, even if
 * their created_at is ancient (a stuck job is a different problem; we don't
 * want to silently lose it).
 */
export function startRetention(): void {
  if (timer) return;
  if (config.reviewRetentionDays <= 0) {
    console.log('[retention] disabled (REVIEW_RETENTION_DAYS=0)');
    return;
  }
  console.log(`[retention] starting, keeping terminal rows for ${config.reviewRetentionDays}d, running hourly`);
  // Run shortly after boot so any backlog gets cleared promptly.
  setTimeout(() => { void prune(); }, 5_000);
  timer = setInterval(() => { void prune(); }, RUN_INTERVAL_MS);
}

export function stopRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function prune(): Promise<void> {
  try {
    const days = config.reviewRetentionDays;
    const result = await sql`
      DELETE FROM pending_reviews
      WHERE status IN ('done', 'failed', 'skipped')
        AND finished_at IS NOT NULL
        AND finished_at < now() - make_interval(days => ${days})
    `;
    if (result.count > 0) {
      console.log(`[retention] pruned ${result.count} terminal review rows older than ${days}d`);
    }
  } catch (err) {
    console.error('[retention] prune failed:', err);
  }
}
