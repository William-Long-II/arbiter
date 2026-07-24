// Pure ranking + summary for a Time Machine retro-audit report. Kept
// separate from the DB layer so it's unit-testable without Postgres (same
// pure/impure split as signals.ts and gate.ts).
//
// A retro-audit produces one review per merged PR. The report leads with
// the worst — blocking findings first — so an operator triaging "what did
// we ship?" reads the scariest rows without scrolling. We rank on the
// structured findings marker when present (the reliable signal) and fall
// back to the coarse verdict when the model omitted it.

import type { FindingCounts, Severity, Verdict } from './format.ts';
import { topSeverity } from './format.ts';

/** The minimal slice of a review row the ranker needs. PendingReview
 *  satisfies this structurally, so callers pass rows straight through. */
export type AuditRankable = {
  status: string;
  verdict: Verdict | null;
  findings: FindingCounts | null;
};

const SEVERITY_TIER: Record<Severity, number> = {
  blocking: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

// A no-findings-marker review still carries a verdict; map it onto the same
// tier scale so those rows interleave sensibly rather than all sinking to
// the bottom. request-changes ranks with blocking, comment mid, approve last.
const VERDICT_TIER: Record<Verdict, number> = {
  'request-changes': 4,
  comment: 2,
  approve: 0,
};

/** Higher = more severe = shown first. Encodes tier, then blocking count,
 *  then major count into one monotonic number for a stable sort. */
export function auditSeverityScore(r: AuditRankable): number {
  const top = topSeverity(r.findings);
  const tier = top != null ? SEVERITY_TIER[top] : r.verdict ? VERDICT_TIER[r.verdict] : 0;
  const blocking = r.findings?.blocking ?? 0;
  const major = r.findings?.major ?? 0;
  return tier * 1_000_000 + blocking * 1_000 + major;
}

/** Rank done reviews most-severe-first. Non-terminal / non-done rows are
 *  excluded — the report shows those as an "in progress" count, not in the
 *  ranked list. Stable: equal-severity rows keep input order. */
export function rankAuditReviews<T extends AuditRankable>(rows: T[]): T[] {
  return rows
    .filter((r) => r.status === 'done')
    .map((r, i) => ({ r, i }))
    .sort((a, b) => auditSeverityScore(b.r) - auditSeverityScore(a.r) || a.i - b.i)
    .map(({ r }) => r);
}

export type AuditSummary = {
  total: number;
  done: number;
  inProgress: number;
  failed: number;
  /** Done reviews whose worst finding is a blocking issue. */
  reviewsWithBlocking: number;
  /** Done reviews whose worst finding is major (no blocking). */
  reviewsWithMajor: number;
  /** Findings summed across every done review in the run. */
  findings: FindingCounts;
};

/** Roll a run's rows up into the header numbers the report shows. */
export function summarizeAudit(rows: AuditRankable[]): AuditSummary {
  const findings: FindingCounts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  let done = 0;
  let inProgress = 0;
  let failed = 0;
  let reviewsWithBlocking = 0;
  let reviewsWithMajor = 0;

  for (const r of rows) {
    if (r.status === 'done') {
      done++;
      if (r.findings) {
        findings.blocking += r.findings.blocking;
        findings.major += r.findings.major;
        findings.minor += r.findings.minor;
        findings.nit += r.findings.nit;
      }
      const top = topSeverity(r.findings);
      if (top === 'blocking') reviewsWithBlocking++;
      else if (top === 'major') reviewsWithMajor++;
    } else if (r.status === 'queued' || r.status === 'running') {
      inProgress++;
    } else {
      failed++; // failed | skipped
    }
  }

  return {
    total: rows.length,
    done,
    inProgress,
    failed,
    reviewsWithBlocking,
    reviewsWithMajor,
    findings,
  };
}
