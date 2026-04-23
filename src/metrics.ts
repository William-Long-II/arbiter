/**
 * Dashboard metrics — one function computes everything, cached briefly so
 * the /api/metrics endpoint doesn't thrash sqlite when multiple tabs are
 * open. All inputs come from the existing `reviews` + `events` tables;
 * nothing new to persist.
 *
 * Metrics are deliberately all-or-null: each one returns null when there
 * isn't enough data to compute it honestly, rather than a misleading zero
 * or NaN. The dashboard renders "—" for nulls so an empty install doesn't
 * look like a broken one.
 */
import type { Store } from "./state/db.ts";

export type MetricsWindow = "24h" | "7d" | "30d";

const WINDOW_HOURS: Record<MetricsWindow, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export type Metrics = {
  window: MetricsWindow;
  windowStart: string;
  /** Count of review rows in the window, broken down by verdict. */
  volume: {
    total: number;
    approve: number;
    request_changes: number;
    dry_run: number;
    skipped: number;
  };
  /** % of live-mode reviews (approve + request_changes) that were approvals. Null if no live reviews. */
  approvalRate: number | null;
  /** Seconds from claude.invoke to post.ok/post.dry_run for the same (repo, pr, sha). Averaged. Null if no matched pairs. */
  avgLatencySeconds: number | null;
  /** Average per-review comment counts by severity. Null if no reviews with structured notes in window. */
  avgCommentsPerReview:
    | {
        nit: number;
        suggestion: number;
        issue: number;
        blocker: number;
      }
    | null;
  /** dropped/(valid+dropped) averaged across reviews in window. Null if no reviews with notes. */
  droppedCommentRate: number | null;
  /** Average filesFilteredOut from claude.invoke event payloads. Null if no claude.invoke events. */
  avgFilesFilteredOut: number | null;
  /** Count of failure events by kind within the window. Always present (zeros are meaningful). */
  failures: {
    claude_failed: number;
    post_failed: number;
    breaker_deferred: number;
    dead_letter_entered: number;
  };
};

type CacheEntry = { at: number; metrics: Metrics };
const CACHE_MS = 60_000;
const cache = new Map<MetricsWindow, CacheEntry>();

export function invalidateMetricsCache(): void {
  cache.clear();
}

export function computeMetrics(store: Store, window: MetricsWindow = "7d"): Metrics {
  const hit = cache.get(window);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.metrics;

  const cutoff = new Date(Date.now() - WINDOW_HOURS[window] * 60 * 60 * 1000);
  const windowStart = cutoff.toISOString();

  const volume = countVolume(store, windowStart);
  const approvalRate = computeApprovalRate(volume);
  const avgLatencySeconds = computeAvgLatency(store, windowStart);
  const { avgCommentsPerReview, droppedCommentRate } = computeCommentStats(
    store,
    windowStart,
  );
  const avgFilesFilteredOut = computeAvgFilesFilteredOut(store, windowStart);
  const failures = countFailures(store, windowStart);

  const metrics: Metrics = {
    window,
    windowStart,
    volume,
    approvalRate,
    avgLatencySeconds,
    avgCommentsPerReview,
    droppedCommentRate,
    avgFilesFilteredOut,
    failures,
  };
  cache.set(window, { at: Date.now(), metrics });
  return metrics;
}

function countVolume(store: Store, since: string): Metrics["volume"] {
  const rows = store.db
    .prepare(
      `SELECT verdict, COUNT(*) AS n FROM reviews
       WHERE reviewed_at >= ? GROUP BY verdict`,
    )
    .all(since) as { verdict: string; n: number }[];
  const v = { total: 0, approve: 0, request_changes: 0, dry_run: 0, skipped: 0 };
  for (const r of rows) {
    v.total += r.n;
    if (r.verdict === "approve") v.approve = r.n;
    else if (r.verdict === "request_changes") v.request_changes = r.n;
    else if (r.verdict === "dry_run") v.dry_run = r.n;
    else if (r.verdict === "skipped") v.skipped = r.n;
  }
  return v;
}

function computeApprovalRate(volume: Metrics["volume"]): number | null {
  const denom = volume.approve + volume.request_changes;
  if (denom === 0) return null;
  return volume.approve / denom;
}

function computeAvgLatency(store: Store, since: string): number | null {
  // Pair each claude.invoke with the matching post.* event by (repo, pr, sha).
  // Uses the events table's composite key on repo/pr/sha. Self-join on the
  // triple; take MIN(ts) of post.* per triple so re-tries don't double-count.
  const row = store.db
    .prepare(
      `SELECT AVG((julianday(p.ts) - julianday(i.ts)) * 86400.0) AS avg_sec
       FROM events i
       JOIN events p ON p.repo = i.repo AND p.pr_number = i.pr_number AND p.head_sha = i.head_sha
       WHERE i.kind = 'claude.invoke'
         AND i.ts >= ?
         AND p.kind IN ('post.ok', 'post.dry_run')
         AND p.ts >= i.ts`,
    )
    .get(since) as { avg_sec: number | null } | undefined;
  if (!row || row.avg_sec === null) return null;
  return Math.round(row.avg_sec * 10) / 10;
}

function computeCommentStats(
  store: Store,
  since: string,
): {
  avgCommentsPerReview: Metrics["avgCommentsPerReview"];
  droppedCommentRate: number | null;
} {
  // note is a JSON string produced by buildReviewNote in loop.ts: it carries
  // valid[] (each with severity) and dropped[] (each with comment.severity).
  // We parse per-row in JS — sqlite's json_extract would work but would need
  // N queries, vs one scan + JS loop.
  const rows = store.db
    .prepare(
      `SELECT note FROM reviews
       WHERE reviewed_at >= ? AND note IS NOT NULL AND note != ''`,
    )
    .all(since) as { note: string }[];

  if (rows.length === 0) {
    return { avgCommentsPerReview: null, droppedCommentRate: null };
  }

  let reviewsWithNotes = 0;
  let sumNit = 0,
    sumSuggestion = 0,
    sumIssue = 0,
    sumBlocker = 0;
  let totalValid = 0,
    totalDropped = 0;

  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.note);
    } catch {
      continue; // older "claude: <err>" notes aren't JSON; skip
    }
    const v = parsed as {
      valid?: Array<{ severity?: string }>;
      dropped?: Array<{ comment?: { severity?: string } }>;
    };
    const valid = Array.isArray(v.valid) ? v.valid : null;
    const dropped = Array.isArray(v.dropped) ? v.dropped : null;
    if (!valid && !dropped) continue;
    reviewsWithNotes += 1;
    if (valid) {
      for (const c of valid) {
        switch (c.severity) {
          case "nit": sumNit += 1; break;
          case "suggestion": sumSuggestion += 1; break;
          case "issue": sumIssue += 1; break;
          case "blocker": sumBlocker += 1; break;
        }
      }
      totalValid += valid.length;
    }
    if (dropped) totalDropped += dropped.length;
  }

  if (reviewsWithNotes === 0) {
    return { avgCommentsPerReview: null, droppedCommentRate: null };
  }

  const avgCommentsPerReview = {
    nit: round(sumNit / reviewsWithNotes, 2),
    suggestion: round(sumSuggestion / reviewsWithNotes, 2),
    issue: round(sumIssue / reviewsWithNotes, 2),
    blocker: round(sumBlocker / reviewsWithNotes, 2),
  };
  const totalComments = totalValid + totalDropped;
  const droppedCommentRate = totalComments === 0 ? null : totalDropped / totalComments;

  return { avgCommentsPerReview, droppedCommentRate };
}

function computeAvgFilesFilteredOut(store: Store, since: string): number | null {
  const rows = store.db
    .prepare(`SELECT payload FROM events WHERE kind = 'claude.invoke' AND ts >= ?`)
    .all(since) as { payload: string | null }[];
  if (rows.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (!r.payload) continue;
    try {
      const p = JSON.parse(r.payload) as { filesFilteredOut?: number };
      if (typeof p.filesFilteredOut === "number") {
        sum += p.filesFilteredOut;
        count += 1;
      }
    } catch {
      // corrupt payload; skip
    }
  }
  if (count === 0) return null;
  return round(sum / count, 2);
}

function countFailures(store: Store, since: string): Metrics["failures"] {
  const rows = store.db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM events
       WHERE ts >= ? AND kind IN ('claude.failed', 'post.failed', 'breaker.deferred', 'dead_letter.entered')
       GROUP BY kind`,
    )
    .all(since) as { kind: string; n: number }[];
  const f = { claude_failed: 0, post_failed: 0, breaker_deferred: 0, dead_letter_entered: 0 };
  for (const r of rows) {
    if (r.kind === "claude.failed") f.claude_failed = r.n;
    else if (r.kind === "post.failed") f.post_failed = r.n;
    else if (r.kind === "breaker.deferred") f.breaker_deferred = r.n;
    else if (r.kind === "dead_letter.entered") f.dead_letter_entered = r.n;
  }
  return f;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
