/**
 * Simple in-memory token-bucket rate limiter for ingress endpoints.
 *
 * Webhook and login pages are the only routes that accept requests from
 * unauthenticated clients; both benefit from a "you can't hit me a
 * million times per second" guard even though the payload validation
 * (HMAC for webhooks, OAuth state nonce for login) already rejects
 * anything unauthorized. The limiter exists to protect the process
 * from resource exhaustion under a retry storm or flood — a bug in a
 * GitHub integration, a misbehaving tunnel, or a drive-by scanner.
 *
 * Pure data structure; no IO. Tested as a unit.
 *
 * Design:
 *  - Per-key bucket with `capacity` tokens, refilled at `refillPerSec`.
 *  - `take(key)` returns `ok: true` and spends a token, or `ok: false`
 *    with the number of ms until the bucket has at least one token.
 *  - `sweep(now)` drops buckets whose last-touch is older than
 *    `staleAfterMs` so the map doesn't grow unboundedly.
 *
 * Bucket state is ephemeral (process-local). That's fine here — this is
 * a flood guard, not a billing mechanism, and the process restart rate
 * is low enough that periodic resets are harmless.
 */
export type RateLimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

export type RateLimiterOptions = {
  /** Bucket size, i.e. how many requests can arrive in a burst before rejection. */
  capacity: number;
  /** Tokens refilled per second. A capacity=30 + 0.5/sec limiter accepts a 30-burst, then 1 request every 2s. */
  refillPerSec: number;
  /** Drop unreferenced buckets after this many ms without a take(). */
  staleAfterMs?: number;
};

type Bucket = {
  tokens: number;
  lastRefillMs: number;
  lastTouchMs: number;
};

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly staleAfterMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.staleAfterMs = opts.staleAfterMs ?? 10 * 60 * 1000;
  }

  /**
   * Attempt to spend one token for `key`. Returns ok:true with the
   * remaining-after-this-take count, or ok:false with the minimum
   * number of ms the caller should wait before retrying.
   *
   * `now` is injectable so tests can advance time without touching the
   * system clock.
   */
  take(key: string, now: number = Date.now()): RateLimitDecision {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now, lastTouchMs: now };
      this.buckets.set(key, b);
    } else {
      // Refill based on elapsed time. Capacity clamp prevents a long-idle
      // bucket from accumulating into an infinite burst.
      const elapsedMs = Math.max(0, now - b.lastRefillMs);
      const refill = (elapsedMs / 1000) * this.refillPerSec;
      b.tokens = Math.min(this.capacity, b.tokens + refill);
      b.lastRefillMs = now;
    }
    b.lastTouchMs = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    // Not enough: compute how long until we'd have 1 token.
    const deficit = 1 - b.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { ok: false, retryAfterMs };
  }

  /** Drop stale buckets. Cheap enough to call on every take() but the
   *  webhook route only runs it periodically to keep per-request cost flat. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastTouchMs > this.staleAfterMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Visible for tests. */
  bucketCount(): number {
    return this.buckets.size;
  }
}

/**
 * Extract the caller-facing IP for rate-limiting. Trusts the first
 * value of X-Forwarded-For when present (the webhook is almost always
 * behind a proxy / tunnel), then Cloudflare's Cf-Connecting-IP, then
 * falls back to the supplied tcp-level address. If nothing resolves,
 * returns a fixed sentinel so every unknown-IP request shares a bucket
 * — which is exactly what you want (an attacker masking IPs still has
 * to contend with a collective limit).
 */
export function resolveClientIp(args: {
  headers: Headers;
  tcpAddress: string | null;
}): string {
  const xff = args.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const cf = args.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  if (args.tcpAddress) return args.tcpAddress;
  return "unknown";
}
