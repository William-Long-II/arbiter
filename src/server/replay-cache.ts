/**
 * Delivery-ID nonce cache for HMAC replay protection.
 *
 * After signature verification succeeds, every delivery ID is inserted here.
 * A second request carrying the same ID is rejected with 409 (replay) even if
 * the signature is still cryptographically valid.
 *
 * Design choices:
 *  - Pure in-memory Map<id, expiryMs>. No external dependency, no persistence.
 *    After a process restart all nonces are forgotten; that is documented and
 *    accepted (see issue #22 Out-of-scope).
 *  - LRU eviction: on every insert we scan the Map for the oldest entry when
 *    the cap is exceeded.  A Map preserves insertion order, so the first entry
 *    is the oldest.  O(1) amortised for the common case (TTL prune removes
 *    most entries before LRU kicks in).
 *  - TTL prune on insert: before admitting a new id we sweep entries whose
 *    expiry has already passed.  This keeps the Map compact without a
 *    background timer and without needing a separate priority queue.
 */

/** Default TTL in milliseconds (10 minutes). */
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

/** Default maximum entries before LRU eviction. */
const DEFAULT_MAX_SIZE = 10_000;

export class ReplayCache {
  private readonly ttlMs: number;
  private readonly maxSize: number;

  /**
   * Map<deliveryId, expiryTimestampMs>.
   * Insertion order = age order, which makes LRU eviction O(1): the first
   * key returned by the iterator is always the oldest.
   */
  private readonly store = new Map<string, number>();

  /** Injectable clock for deterministic testing. */
  private readonly now: () => number;

  constructor(opts: {
    ttlMs?: number;
    maxSize?: number;
    /** Override Date.now() for deterministic tests. */
    now?: () => number;
  } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Attempt to insert `deliveryId` into the cache.
   *
   * Returns `{ fresh: true }` if the ID was not previously seen (or its TTL
   * has expired), meaning the request should be processed normally.
   * Returns `{ fresh: false }` if the ID is already present and unexpired —
   * the caller should reject with 409.
   */
  tryInsert(deliveryId: string): { fresh: boolean } {
    const ts = this.now();

    // Prune expired entries before checking / inserting so the size cap
    // reflects live entries only, and expired IDs can be legitimately reused.
    this.pruneExpired(ts);

    const expiry = this.store.get(deliveryId);
    if (expiry !== undefined && expiry > ts) {
      // Already seen, still within TTL — replay.
      return { fresh: false };
    }

    // If re-inserting an expired entry, delete first so Map preserves correct
    // insertion-order after the new set below.
    if (this.store.has(deliveryId)) {
      this.store.delete(deliveryId);
    }

    // LRU eviction: drop the oldest entry when at capacity.
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.set(deliveryId, ts + this.ttlMs);
    return { fresh: true };
  }

  /** Current number of live entries (includes not-yet-expired ones). */
  size(): number {
    return this.store.size;
  }

  /** Remove all expired entries. Called automatically on insert. */
  private pruneExpired(now: number): void {
    for (const [id, expiry] of this.store) {
      if (expiry <= now) {
        this.store.delete(id);
      } else {
        // Map iteration is in insertion order; once we see a non-expired entry
        // we can stop — all subsequent entries were inserted later and are at
        // least as fresh.
        break;
      }
    }
  }

  /** Clear all entries (useful for tests). */
  clear(): void {
    this.store.clear();
  }
}

/** Process-wide singleton. */
export const replayCache = new ReplayCache();
