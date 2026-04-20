/**
 * In-memory LRU thread-state tracker for pull_request_review_comment threads.
 *
 * Keyed by `${repoFull}:${parentCommentId}`. Entries expire after TTL_MS
 * (24 hours by default), bounding both memory growth and the permanence of
 * `/stop` — a user who stopped the thread more than 24 h ago will receive
 * replies again after the entry expires.
 *
 * Max 10k entries: at ~100 bytes each that is about 1 MB. LRU eviction means
 * active threads are retained while idle ones are dropped first.
 */

export type ThreadState = {
  replies: number;
  stopped: boolean;
  expiresAt: number; // Unix ms
};

const MAX_ENTRIES = 10_000;
const TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

export class ThreadTracker {
  // Map preserves insertion order; we use that for LRU eviction: the first
  // entry is the least-recently-used one.
  private readonly map = new Map<string, ThreadState>();

  private readonly ttlMs: number;

  constructor(ttlMs = TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private key(repoFull: string, parentCommentId: number): string {
    return `${repoFull}:${parentCommentId}`;
  }

  /** Return the state for this thread, or undefined if no state recorded yet. */
  get(repoFull: string, parentCommentId: number): ThreadState | undefined {
    const k = this.key(repoFull, parentCommentId);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(k);
      return undefined;
    }
    // Refresh LRU position by re-inserting at the end.
    this.map.delete(k);
    this.map.set(k, entry);
    return entry;
  }

  /**
   * Get (or create) the state for this thread.
   * Returns the existing (non-expired) entry or a fresh one with replies=0.
   */
  getOrCreate(repoFull: string, parentCommentId: number): ThreadState {
    const existing = this.get(repoFull, parentCommentId);
    if (existing) return existing;

    // Evict the LRU entry when we are at capacity.
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    const state: ThreadState = {
      replies: 0,
      stopped: false,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.map.set(this.key(repoFull, parentCommentId), state);
    return state;
  }

  /** Visible for testing. */
  get size(): number {
    return this.map.size;
  }
}

/** Singleton used at runtime. */
export const threadTracker = new ThreadTracker();
