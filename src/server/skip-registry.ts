/**
 * In-memory LRU skip registry for per-PR /review-me skip commands.
 *
 * Keyed by `${repoFull}#${prNumber}`. Entries expire after TTL_MS (7 days),
 * which means a skipped PR will silently resume auto-review after 7 days.
 * This is a known trade-off: TTL prevents unbounded memory growth without a
 * background GC timer. Operators can also explicitly resume via /review-me resume.
 *
 * Max 10k entries: at ~100 bytes each that is about 1 MB.
 * LRU eviction means recently-touched skips are retained while idle ones
 * are dropped first when the cap is reached.
 */

const MAX_ENTRIES = 10_000;

/** 7 days in milliseconds. */
const TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type Entry = {
  expiresAt: number; // Unix ms
};

export class SkipRegistry {
  // Map preserves insertion order; we use that for LRU eviction: the first
  // entry is the least-recently-used one.
  private readonly map = new Map<string, Entry>();

  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Returns true if the PR is currently marked as skipped (and not expired). */
  isSkipped(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (this.now() > entry.expiresAt) {
      // Expired — evict lazily.
      this.map.delete(key);
      return false;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return true;
  }

  /** Mark the PR as skipped. Overwrites any existing entry. */
  setSkipped(key: string): void {
    // Evict LRU entry when at capacity (only when inserting a new key).
    if (!this.map.has(key) && this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    // Remove first to reset LRU insertion-order position.
    this.map.delete(key);
    this.map.set(key, { expiresAt: this.now() + this.ttlMs });
  }

  /** Clear the skip flag for this PR. No-op if not present. */
  clearSkipped(key: string): void {
    this.map.delete(key);
  }

  /** Current number of entries (includes not-yet-expired ones). Visible for testing. */
  get size(): number {
    return this.map.size;
  }
}

/** Process-wide singleton. */
export const skipRegistry = new SkipRegistry();

/** Convenience key builder — matches the format used in webhooks.ts. */
export function skipKey(repoFull: string, prNumber: number): string {
  return `${repoFull}#${prNumber}`;
}
