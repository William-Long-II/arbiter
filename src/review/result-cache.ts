/**
 * Short-TTL in-process LRU cache for `runReview` results, keyed on
 * `${repoFull}@${headSha}`.
 *
 * Why TTL = 10 minutes?
 *   A given head SHA is immutable — the commit it points to never changes.
 *   Within the lifetime of a typical CI event storm (retry loops, branch-
 *   protection re-evaluations), 10 minutes is long enough to absorb duplicates
 *   while still being short enough that a hot-deploy of the bot (which may
 *   change the system prompt) does not serve stale reviews for long.
 *
 * Why cap = 500 entries?
 *   Roughly the number of concurrent open PRs a busy mono-repo sees.  At
 *   ~4 KB per RunReviewOutput the worst-case RSS is ~2 MB — negligible.
 *
 * Design: dependency-free Map-based LRU, identical pattern to
 * `src/review/conventions.ts`.  Map preserves insertion order; we re-insert
 * on access to push the entry to the "most-recently-used" tail.
 */

import type { RunReviewOutput } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a cached result stays valid. */
const CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

/** Maximum number of entries before LRU eviction. */
const CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type CacheEntry = {
  value: RunReviewOutput;
  expiresAt: number;
};

// ---------------------------------------------------------------------------
// LRU cache class
// ---------------------------------------------------------------------------

class ResultLruCache {
  // Map preserves insertion order; re-inserting a key on read moves it to the
  // most-recently-used tail.
  private readonly map = new Map<string, CacheEntry>();

  /**
   * Return the cached `RunReviewOutput` for `key`, or `undefined` if absent
   * or expired.  Never throws.
   */
  get(key: string): RunReviewOutput | undefined {
    try {
      const entry = this.map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        this.map.delete(key);
        return undefined;
      }
      // Move to MRU tail by re-inserting.
      this.map.delete(key);
      this.map.set(key, entry);
      return entry.value;
    } catch {
      // Swallow any unexpected error — cache failures must never interrupt the
      // review pipeline.
      return undefined;
    }
  }

  /**
   * Store `value` under `key` with the configured TTL.  When at capacity the
   * least-recently-used entry is evicted first.  Never throws.
   */
  set(key: string, value: RunReviewOutput): void {
    try {
      // Evict the LRU (oldest) entry when at capacity and the key is new.
      if (this.map.size >= CACHE_MAX && !this.map.has(key)) {
        const lruKey = this.map.keys().next().value;
        if (lruKey !== undefined) this.map.delete(lruKey);
      }
      // Re-insert at tail (ensures correct MRU order even on updates).
      this.map.delete(key);
      this.map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    } catch {
      // Swallow — same rationale as get().
    }
  }

  /**
   * Remove all entries.  Called by tests between runs and available for
   * operator tooling that wants a full flush without a process restart.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Total number of live entries currently held (includes not-yet-expired
   * ones).  Exposed for testing.
   */
  size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/** Process-wide result cache singleton. Exported for testing only. */
export const resultCache = new ResultLruCache();
