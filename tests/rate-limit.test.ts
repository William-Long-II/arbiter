import { describe, expect, test } from "bun:test";
import { RateLimiter, resolveClientIp } from "../src/webhook/rate-limit.ts";

describe("RateLimiter.take", () => {
  test("allows up to capacity in an initial burst", () => {
    const rl = new RateLimiter({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) {
      const d = rl.take("ip1", 0);
      expect(d.ok).toBe(true);
    }
    const sixth = rl.take("ip1", 0);
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.retryAfterMs).toBeGreaterThan(0);
  });

  test("refills tokens over time", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(rl.take("ip1", 0).ok).toBe(true);
    expect(rl.take("ip1", 0).ok).toBe(true);
    // Bucket empty. Wait 1500ms → 1.5 tokens worth of refill → 1 full token.
    const d = rl.take("ip1", 1500);
    expect(d.ok).toBe(true);
    // Another request immediately → 0.5 tokens left → reject.
    expect(rl.take("ip1", 1500).ok).toBe(false);
  });

  test("retryAfterMs is proportional to the deficit", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    rl.take("ip1", 0); // 1 → 0
    const d = rl.take("ip1", 0);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      // Need 1 token at 1 token/sec → ~1000ms.
      expect(d.retryAfterMs).toBeGreaterThanOrEqual(900);
      expect(d.retryAfterMs).toBeLessThanOrEqual(1100);
    }
  });

  test("different keys have independent buckets", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(rl.take("ip1", 0).ok).toBe(true);
    expect(rl.take("ip1", 0).ok).toBe(false);
    // ip2 still has its own full bucket.
    expect(rl.take("ip2", 0).ok).toBe(true);
  });

  test("refill clamps at capacity (long idle doesn't accumulate an infinite burst)", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    rl.take("ip1", 0); // 3 → 2
    // Come back an hour later; bucket should refill to 3, NOT to 3603.
    rl.take("ip1", 3_600_000);
    expect(rl.take("ip1", 3_600_000).ok).toBe(true); // spends 1 → 1 left
    expect(rl.take("ip1", 3_600_000).ok).toBe(true); // spends 1 → 0 left
    expect(rl.take("ip1", 3_600_000).ok).toBe(false); // empty
  });

  test("sweep removes buckets whose last touch is older than staleAfterMs", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, staleAfterMs: 1000 });
    rl.take("ip1", 0);
    rl.take("ip2", 500);
    expect(rl.bucketCount()).toBe(2);
    // Sweep at 1500: ip1 was touched at 0 (age 1500 > 1000) → drop.
    // ip2 was touched at 500 (age 1000; >=1000 does NOT drop — strict >).
    const removed = rl.sweep(1500);
    expect(removed).toBe(1);
    expect(rl.bucketCount()).toBe(1);
  });
});

describe("resolveClientIp", () => {
  function headers(init: Record<string, string>): Headers {
    const h = new Headers();
    for (const [k, v] of Object.entries(init)) h.set(k, v);
    return h;
  }

  test("takes the first value of X-Forwarded-For when present", () => {
    const ip = resolveClientIp({
      headers: headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }),
      tcpAddress: "127.0.0.1",
    });
    expect(ip).toBe("203.0.113.7");
  });

  test("falls back to Cf-Connecting-IP when XFF isn't set", () => {
    const ip = resolveClientIp({
      headers: headers({ "cf-connecting-ip": "198.51.100.5" }),
      tcpAddress: "127.0.0.1",
    });
    expect(ip).toBe("198.51.100.5");
  });

  test("falls back to the TCP address when no headers are present", () => {
    const ip = resolveClientIp({
      headers: headers({}),
      tcpAddress: "192.0.2.42",
    });
    expect(ip).toBe("192.0.2.42");
  });

  test("returns 'unknown' when nothing resolves (all bucket together)", () => {
    const ip = resolveClientIp({
      headers: headers({}),
      tcpAddress: null,
    });
    expect(ip).toBe("unknown");
  });

  test("ignores an empty XFF value and keeps falling through", () => {
    const ip = resolveClientIp({
      headers: headers({ "x-forwarded-for": "  , 10.0.0.1" }),
      tcpAddress: "127.0.0.1",
    });
    // First element is whitespace-only → treated as empty; fall through
    // to Cf-Connecting-IP (absent) → tcpAddress.
    expect(ip).toBe("127.0.0.1");
  });
});
