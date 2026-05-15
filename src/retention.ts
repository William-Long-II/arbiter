import { config } from './config.ts';
import { sql } from './db.ts';
import { pruneExpiredSessions } from './db/users.ts';

let timer: ReturnType<typeof setInterval> | null = null;
const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Hourly housekeeping. Two independent concerns:
 *  - Terminal (`done`/`failed`/`skipped`) pending_reviews older than
 *    `REVIEW_RETENTION_DAYS` (0 disables just this part). Non-terminal rows
 *    (`queued`/`running`) are NEVER pruned even if ancient — a stuck job is
 *    a different problem; we don't want to silently lose it.
 *  - Expired `sessions` rows — always pruned regardless of the review
 *    setting; leaving dead sessions in the table forever is a security and
 *    storage liability, not a tunable.
 */
export function startRetention(): void {
  if (timer) return;
  const reviewPolicy =
    config.reviewRetentionDays <= 0
      ? 'reviews kept forever'
      : `reviews kept ${config.reviewRetentionDays}d`;
  console.log(`[retention] starting, running hourly (${reviewPolicy}, expired sessions always pruned)`);
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
  await pruneReviews();
  await pruneSessions();
}

async function pruneReviews(): Promise<void> {
  if (config.reviewRetentionDays <= 0) return; // REVIEW_RETENTION_DAYS=0 disables
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
    console.error('[retention] review prune failed:', err);
  }
}

async function pruneSessions(): Promise<void> {
  try {
    const n = await pruneExpiredSessions();
    if (n > 0) {
      console.log(`[retention] pruned ${n} expired session rows`);
    }
  } catch (err) {
    console.error('[retention] session prune failed:', err);
  }
}
