import type { PrContext } from "../github/diff.ts";

/**
 * Large-PR handling policy — pure functions. The loop calls shouldTriage
 * to decide whether to go down the two-pass path, and pickDeepReviewFiles
 * to trim the triage output to a reviewable set.
 *
 * Design choice (see #133): option B (triage + deep-dive). Two Claude
 * calls per large PR regardless of size — one lightweight triage over
 * filenames+stats, one full review over the top-priority subset. Costs
 * exactly 1 extra Claude call compared to the small-PR path, instead of
 * an unbounded multiplier.
 */

export type LargePrThresholds = {
  /** File count threshold — above this, triage runs. */
  fileCount: number;
  /** Diff size threshold in bytes — above this, triage runs. Either threshold triggers. */
  diffBytes: number;
  /** How many files get the full review after triage. */
  deepReviewFiles: number;
};

export function shouldTriage(pr: PrContext, t: LargePrThresholds): boolean {
  if (pr.files.length >= t.fileCount) return true;
  let totalBytes = 0;
  for (const f of pr.files) {
    totalBytes += f.patch.length;
    if (totalBytes >= t.diffBytes) return true;
  }
  return false;
}

export type TriageEntry = { path: string; priority: "high" | "medium" | "low"; reason: string };

/**
 * Turn triage output into the set of files to deep-review.
 *
 *   1. Sort by priority (high → medium → low), then by file size descending
 *      so large complex files beat tiny ones within a priority band.
 *   2. Take up to `limit` files.
 *   3. If triage hallucinates paths that aren't in the PR, those are
 *      silently skipped (pure set intersection with `allPaths`).
 *   4. Files that were changed but never classified by triage are appended
 *      at "unknown" priority so nothing silently falls off the radar —
 *      they're after every real triage entry.
 */
export function pickDeepReviewFiles(args: {
  triage: TriageEntry[];
  allFiles: PrContext["files"];
  limit: number;
}): {
  kept: string[];
  deferred: string[];
} {
  const { triage, allFiles, limit } = args;
  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const priorityOrder: Record<TriageEntry["priority"], number> = { high: 0, medium: 1, low: 2 };

  // Valid triage entries (hallucinated paths dropped), sorted.
  const valid = triage
    .filter((t) => byPath.has(t.path))
    .sort((a, b) => {
      const p = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (p !== 0) return p;
      return (byPath.get(b.path)!.patch.length) - (byPath.get(a.path)!.patch.length);
    });

  // Unclassified files appended at the end.
  const classifiedPaths = new Set(valid.map((v) => v.path));
  const unclassified = allFiles
    .map((f) => f.path)
    .filter((p) => !classifiedPaths.has(p));

  const ordered = [...valid.map((v) => v.path), ...unclassified];
  const kept = ordered.slice(0, Math.max(1, limit));
  const deferred = ordered.slice(Math.max(1, limit));
  return { kept, deferred };
}
