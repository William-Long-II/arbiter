import { describe, expect, test, beforeEach } from "bun:test";
import {
  withRetry,
  defaultRetryOn,
  setSleep,
  type RetryOptions,
} from "../src/util/retry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track sleep calls so we can assert on backoff delays. */
function makeFakeSleep() {
  const delays: number[] = [];
  const impl = async (ms: number) => {
    delays.push(ms);
  };
  return { delays, impl };
}

function makeError(status?: number, headers?: Record<string, string>): Error {
  const err = new Error(`HTTP ${status ?? "network error"}`) as Error & {
    status?: number;
    headers?: Record<string, string>;
  };
  if (status !== undefined) err.status = status;
  if (headers !== undefined) err.headers = headers;
  return err;
}

// ---------------------------------------------------------------------------
// defaultRetryOn
// ---------------------------------------------------------------------------

describe("defaultRetryOn", () => {
  test("retries on network errors (no status)", () => {
    expect(defaultRetryOn(new Error("ECONNREFUSED"))).toBe(true);
  });

  test("retries on 408", () => {
    expect(defaultRetryOn(makeError(408))).toBe(true);
  });

  test("retries on 429", () => {
    expect(defaultRetryOn(makeError(429))).toBe(true);
  });

  test("retries on 500", () => {
    expect(defaultRetryOn(makeError(500))).toBe(true);
  });

  test("retries on 503", () => {
    expect(defaultRetryOn(makeError(503))).toBe(true);
  });

  test("does NOT retry on 400", () => {
    expect(defaultRetryOn(makeError(400))).toBe(false);
  });

  test("does NOT retry on 401", () => {
    expect(defaultRetryOn(makeError(401))).toBe(false);
  });

  test("does NOT retry on 403", () => {
    expect(defaultRetryOn(makeError(403))).toBe(false);
  });

  test("does NOT retry on 404", () => {
    expect(defaultRetryOn(makeError(404))).toBe(false);
  });

  test("does NOT retry on 422", () => {
    expect(defaultRetryOn(makeError(422))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry — successful call
// ---------------------------------------------------------------------------

describe("withRetry — success on first attempt", () => {
  test("returns the value immediately without sleeping", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(delays).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry — retry count
// ---------------------------------------------------------------------------

describe("withRetry — retry behaviour", () => {
  beforeEach(() => {
    const { impl } = makeFakeSleep();
    setSleep(impl);
  });

  test("retries up to attempts-1 times then succeeds", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls < 3) throw makeError(500);
        return Promise.resolve("ok");
      },
      { attempts: 3, baseMs: 10, capMs: 100 },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2); // slept between attempt 1→2 and 2→3
  });

  test("throws on the last attempt without sleeping", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw makeError(503);
        },
        { attempts: 3, baseMs: 10, capMs: 100 },
      ),
    ).rejects.toMatchObject({ status: 503 });

    expect(calls).toBe(3);
    expect(delays).toHaveLength(2); // sleeps between attempts, not after last
  });

  test("does not retry non-retryable 4xx", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw makeError(404);
        },
        { attempts: 3 },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry — backoff progression
// ---------------------------------------------------------------------------

describe("withRetry — backoff progression", () => {
  test("delays are non-negative and bounded by capMs", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    await expect(
      withRetry(
        () => {
          throw makeError(503);
        },
        { attempts: 5, baseMs: 50, capMs: 200 },
      ),
    ).rejects.toBeDefined();

    expect(delays).toHaveLength(4);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(200);
    }
  });

  test("later attempts can have higher maximum delay (exponential cap grows)", async () => {
    // Run many samples to probabilistically confirm the ceiling grows.
    // With baseMs=100, capMs=10000, attempts=4:
    //   attempt 0 ceiling = min(10000, 100 * 2^0) = 100
    //   attempt 1 ceiling = min(10000, 100 * 2^1) = 200
    //   attempt 2 ceiling = min(10000, 100 * 2^2) = 400
    // The average of samples from [0, X] is X/2, so later attempts should
    // have higher average delays.  We check the max observed is strictly
    // larger after a few attempts.
    const allDelays: number[][] = [[], [], []]; // per attempt index

    for (let run = 0; run < 30; run++) {
      const perRunDelays: number[] = [];
      setSleep(async (ms) => { perRunDelays.push(ms); });

      await expect(
        withRetry(() => { throw makeError(503); }, {
          attempts: 4,
          baseMs: 100,
          capMs: 10_000,
        }),
      ).rejects.toBeDefined();

      for (let i = 0; i < 3; i++) {
        if (perRunDelays[i] !== undefined) allDelays[i]!.push(perRunDelays[i]!);
      }
    }

    const maxDelay = (arr: number[]) => Math.max(...arr);
    // The maximum observed delay in later attempts should exceed earlier ones.
    expect(maxDelay(allDelays[2]!)).toBeGreaterThan(maxDelay(allDelays[0]!));
  });
});

// ---------------------------------------------------------------------------
// withRetry — Retry-After header
// ---------------------------------------------------------------------------

describe("withRetry — Retry-After header", () => {
  test("honours Retry-After (in seconds) on 429", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    await withRetry(
      () => {
        calls++;
        if (calls === 1) {
          throw makeError(429, { "retry-after": "2" });
        }
        return Promise.resolve("done");
      },
      { attempts: 3, baseMs: 10, capMs: 100 },
    );

    expect(calls).toBe(2);
    // Should have slept for exactly 2000 ms (2 seconds * 1000).
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(2_000);
  });

  test("ignores malformed Retry-After and falls back to jitter", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    await withRetry(
      () => {
        calls++;
        if (calls === 1) {
          throw makeError(429, { "retry-after": "not-a-number" });
        }
        return Promise.resolve("done");
      },
      { attempts: 3, baseMs: 10, capMs: 100 },
    );

    expect(delays).toHaveLength(1);
    // Fallback jitter delay should be in [0, capMs].
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// withRetry — custom retryOn predicate
// ---------------------------------------------------------------------------

describe("withRetry — custom retryOn", () => {
  test("custom predicate can prevent retry on 500", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw makeError(500);
        },
        {
          attempts: 3,
          retryOn: () => false, // never retry
        },
      ),
    ).rejects.toBeDefined();

    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  test("custom predicate can enable retry on 422", async () => {
    const { delays, impl } = makeFakeSleep();
    setSleep(impl);

    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls < 2) throw makeError(422);
        return Promise.resolve("recovered");
      },
      {
        attempts: 3,
        baseMs: 1,
        retryOn: (err) => (err as { status?: number }).status === 422,
      },
    );

    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
  });
});
