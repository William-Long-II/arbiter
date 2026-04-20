/**
 * Token-bucket rate limiter keyed by GitHub installation ID.
 *
 * Each installation gets its own bucket. Tokens refill continuously at a
 * steady rate (RATELIMIT_RPM / 60 tokens/second). The bucket can hold up to
 * RATELIMIT_BURST tokens; any excess refill is discarded. On each request we
 * attempt to consume one token; if none are available the request is rejected
 * and the caller gets a Retry-After hint in whole seconds.
 *
 * WHY check before signature verification: HMAC computation is ~O(payload
 * size) and involves crypto primitives; rate-limit checks are O(1) hash map
 * lookups. Cheap rejects should come first.
 *
 * LRU cap: to bound memory we keep at most MAX_INSTALLATIONS distinct buckets.
 * When the cap is reached and a new installation appears, the least-recently-
 * used entry is evicted.
 */

const DEFAULT_RPM = 60;
const DEFAULT_BURST = 120;
const MAX_INSTALLATIONS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds the caller should wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token-bucket rate limiter.
 * Exported as a class so tests can instantiate isolated instances with custom
 * configuration rather than depending on the module-level singleton.
 */
export class RateLimiter {
  private readonly tokensPerMs: number;
  private readonly capacity: number;
  private readonly maxInstallations: number;

  // Map preserves insertion order; we use this for LRU eviction.
  private readonly buckets = new Map<string, Bucket>();

  constructor(options?: {
    rpm?: number;
    burst?: number;
    maxInstallations?: number;
  }) {
    const rpm = options?.rpm ?? DEFAULT_RPM;
    const burst = options?.burst ?? DEFAULT_BURST;
    this.tokensPerMs = rpm / 60 / 1_000; // tokens per millisecond
    this.capacity = burst;
    this.maxInstallations = options?.maxInstallations ?? MAX_INSTALLATIONS;
  }

  /**
   * Check whether the given installation key is within its rate limit.
   *
   * @param installationKey  Opaque string identifying the rate-limit bucket.
   * @param now              Current time in milliseconds (injectable for tests).
   */
  check(installationKey: string, now: number = Date.now()): RateLimitResult {
    let bucket = this.buckets.get(installationKey);

    if (bucket === undefined) {
      // New installation: start with a full bucket.
      if (this.buckets.size >= this.maxInstallations) {
        // Evict the least-recently-used entry (first key in Map insertion order).
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(installationKey, bucket);
    } else {
      // Move to end to mark as most-recently-used.
      this.buckets.delete(installationKey);
      this.buckets.set(installationKey, bucket);

      // Refill tokens based on elapsed time.
      const elapsed = Math.max(0, now - bucket.lastRefillMs);
      const refill = elapsed * this.tokensPerMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Rejected: compute how long until one token refills.
    const deficit = 1 - bucket.tokens;
    const msUntilToken = deficit / this.tokensPerMs;
    const retryAfterSeconds = Math.ceil(msUntilToken / 1_000);

    return { allowed: false, retryAfterSeconds };
  }

  /** Number of tracked installation buckets (visible for tests). */
  get size(): number {
    return this.buckets.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — reads env vars once at import time.
// ---------------------------------------------------------------------------

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return defaultValue;
}

export const rateLimiter = new RateLimiter({
  rpm: parseEnvInt("RATELIMIT_RPM", DEFAULT_RPM),
  burst: parseEnvInt("RATELIMIT_BURST", DEFAULT_BURST),
  maxInstallations: MAX_INSTALLATIONS,
});
