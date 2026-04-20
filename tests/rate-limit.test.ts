import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/server/rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a limiter with known parameters, bypassing env vars. */
function makeLimiter(rpm = 60, burst = 120) {
  return new RateLimiter({ rpm, burst });
}

// ---------------------------------------------------------------------------
// Burst tests — uses monkey-clock to stay deterministic.
// ---------------------------------------------------------------------------

describe("rate-limit — burst", () => {
  test("burst capacity: exactly BURST requests allowed in one instant", () => {
    const limiter = makeLimiter(60, 120);
    const now = 1_000_000; // arbitrary fixed timestamp

    let allowed = 0;
    let rejected = 0;
    // The bucket starts full (120 tokens).
    for (let i = 0; i < 125; i++) {
      const result = limiter.check("install-1", now);
      if (result.allowed) allowed++;
      else rejected++;
    }

    expect(allowed).toBe(120);
    expect(rejected).toBe(5);
  });

  test("121st request in a burst is blocked with retryAfterSeconds >= 1", () => {
    const limiter = makeLimiter(60, 120);
    const now = 2_000_000;

    for (let i = 0; i < 120; i++) {
      limiter.check("install-burst", now);
    }

    const result = limiter.check("install-burst", now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Steady-state tests — advance the clock to simulate passage of time.
// ---------------------------------------------------------------------------

describe("rate-limit — steady-state", () => {
  test("~60 requests per minute allowed at steady state", () => {
    // 60 rpm = 1 token/second. Advance clock by 1 second between requests.
    const limiter = makeLimiter(60, 60); // burst = steady rate for clarity
    let t = 0;

    // Drain the bucket first.
    for (let i = 0; i < 60; i++) limiter.check("steady", t);

    // Now advance 1 second per request — each should be allowed.
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      t += 1_000; // +1 second
      const r = limiter.check("steady", t);
      if (r.allowed) allowed++;
    }

    expect(allowed).toBe(60);
  });

  test("requests within a second are throttled when bucket is empty", () => {
    const limiter = makeLimiter(60, 60);
    let t = 0;

    // Drain.
    for (let i = 0; i < 60; i++) limiter.check("throttle", t);

    // No time elapsed — all should be rejected.
    let rejected = 0;
    for (let i = 0; i < 10; i++) {
      const r = limiter.check("throttle", t);
      if (!r.allowed) rejected++;
    }
    expect(rejected).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Per-installation isolation.
// ---------------------------------------------------------------------------

describe("rate-limit — per-installation isolation", () => {
  test("two distinct keys do not share a bucket", () => {
    const limiter = makeLimiter(60, 5); // small burst for fast test
    const now = 3_000_000;

    // Exhaust install-A.
    for (let i = 0; i < 5; i++) limiter.check("install-A", now);
    const aResult = limiter.check("install-A", now);
    expect(aResult.allowed).toBe(false);

    // install-B should still be untouched.
    const bResult = limiter.check("install-B", now);
    expect(bResult.allowed).toBe(true);
  });

  test("(no-installation) key does not bleed into named installation", () => {
    const limiter = makeLimiter(60, 3);
    const now = 4_000_000;

    // Exhaust the fallback bucket.
    for (let i = 0; i < 3; i++) limiter.check("(no-installation)", now);
    expect(limiter.check("(no-installation)", now).allowed).toBe(false);

    // Named installation should be unaffected.
    expect(limiter.check("12345", now).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction.
// ---------------------------------------------------------------------------

describe("rate-limit — LRU cap", () => {
  test("LRU cap evicts oldest entry when map is full", () => {
    const limiter = new RateLimiter({ rpm: 60, burst: 10, maxInstallations: 3 });
    const now = 5_000_000;

    // Fill to cap: install-0, install-1, install-2.
    limiter.check("install-0", now);
    limiter.check("install-1", now);
    limiter.check("install-2", now);
    expect(limiter.size).toBe(3);

    // Adding install-3 should evict install-0 (LRU).
    limiter.check("install-3", now);
    expect(limiter.size).toBe(3);

    // install-0 is evicted, so its bucket resets to full on next access.
    const r = limiter.check("install-0", now);
    // After eviction and re-creation the bucket starts full → allowed.
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// retryAfterSeconds accuracy.
// ---------------------------------------------------------------------------

describe("rate-limit — retryAfterSeconds", () => {
  test("retryAfterSeconds is ceiling of fractional wait", () => {
    // 60 rpm = 1 token per second. Bucket empty → next token in 1 s.
    const limiter = makeLimiter(60, 1);
    const now = 0;

    limiter.check("check-retry", now); // consume the single token

    const result = limiter.check("check-retry", now);
    expect(result.allowed).toBe(false);
    // Deficit = 1 token, rate = 1/s → 1 s wait → ceil(1) = 1.
    expect(result.retryAfterSeconds).toBe(1);
  });
});
