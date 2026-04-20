/**
 * Tests for the circuit breaker (src/review/breaker.ts).
 *
 * All time is injected via the `now` parameter so tests are fully
 * deterministic — no real timers, no fake-timer infrastructure.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  CircuitBreaker,
  CircuitOpenError,
  withBreaker,
  getBreaker,
  _resetBreakers,
} from "../src/review/breaker";
import { registry, breakerState } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms

function makeBreaker(
  overrides: {
    windowMs?: number;
    minSamples?: number;
    failureThreshold?: number;
    openDurationMs?: number;
  } = {},
): CircuitBreaker {
  return new CircuitBreaker({
    windowMs: overrides.windowMs ?? 60_000,
    minSamples: overrides.minSamples ?? 20,
    failureThreshold: overrides.failureThreshold ?? 0.5,
    openDurationMs: overrides.openDurationMs ?? 60_000,
    dep: "test-dep",
  });
}

/**
 * Inject n failures at the same timestamp (default T0).
 *
 * Using the same timestamp keeps openSince predictable: the breaker trips on
 * the Nth failure, and openSince is set to `startTs`, so the open window expires
 * at exactly `startTs + openDurationMs`. Tests can use `startTs + openDurationMs + 1`
 * to reliably land in the half-open window.
 */
function injectFailures(
  b: CircuitBreaker,
  count: number,
  startTs = T0,
): void {
  for (let i = 0; i < count; i++) {
    b.recordFailure(startTs);
  }
}

/** Inject n successes at the same timestamp (default T0). */
function injectSuccesses(
  b: CircuitBreaker,
  count: number,
  startTs = T0,
): void {
  for (let i = 0; i < count; i++) {
    b.recordSuccess(startTs);
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("CircuitBreaker — initial state", () => {
  test("starts CLOSED", () => {
    const b = makeBreaker();
    expect(b.getState()).toBe("closed");
  });

  test("check() returns allowed:true when closed", () => {
    const b = makeBreaker();
    expect(b.check(T0)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Closed → Open: 20 failures trips the breaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker — closed → open transition", () => {
  test("20 failures (all 100% failure) trips the breaker", () => {
    const b = makeBreaker({ minSamples: 20 });
    injectFailures(b, 20);
    expect(b.getState()).toBe("open");
  });

  test("check() returns allowed:false immediately after tripping", () => {
    const b = makeBreaker({ minSamples: 20, openDurationMs: 60_000 });
    injectFailures(b, 20);
    const result = b.check(T0 + 2_000); // 2s after open
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  test("19 failures (1 below minSamples) does NOT trip", () => {
    const b = makeBreaker({ minSamples: 20 });
    injectFailures(b, 19);
    expect(b.getState()).toBe("closed");
  });

  test("50/50 failures/successes (exactly at threshold) does NOT trip", () => {
    // threshold is > 0.5, so exactly 0.5 should not trip
    const b = makeBreaker({ minSamples: 20, failureThreshold: 0.5 });
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        b.recordFailure(T0 + i * 100);
      } else {
        b.recordSuccess(T0 + i * 100);
      }
    }
    // ratio = 10/20 = 0.5, threshold is > 0.5, so NOT tripped
    expect(b.getState()).toBe("closed");
  });

  test("51% failure rate trips when minSamples met", () => {
    // Record exactly 20 samples: 11 failures then 9 successes.
    // On the 20th sample (the 9th success) ratio = 11/20 = 55% > 50% → trips.
    // Note: maybeTrip() is called only in recordFailure(). So the 11th failure
    // (the 20th overall if we do 9 successes first then 11 failures) triggers it.
    // Easier: 11 failures first to guarantee > 50% at 20 samples once minSamples hit.
    const b = makeBreaker({ minSamples: 20, failureThreshold: 0.5 });
    // 11 failures, then 9 successes → 20 total, 11/20 = 55%
    // But maybeTrip only runs in recordFailure. After 11 failures + 9 successes we
    // have 20 samples, but the last action was recordSuccess. Check state manually:
    // We need the breaker to evaluate at the point it has ≥20 samples.
    // Strategy: interleave so that a recordFailure call has ≥20 total samples.
    // Record 10 successes then 11 failures — at the 11th failure (21st total sample)
    // we have 11/21 ≈ 52% > 50%, minSamples=20 met → trips.
    for (let i = 0; i < 10; i++) b.recordSuccess(T0);
    for (let i = 0; i < 11; i++) b.recordFailure(T0);
    // At 11th failure: 21 samples, 11 failures = 52.4% > 50% → open
    expect(b.getState()).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Small-sample protection (< 20 samples never trips)
// ---------------------------------------------------------------------------

describe("CircuitBreaker — small-sample protection", () => {
  test("fewer than minSamples pure failures do not trip", () => {
    const b = makeBreaker({ minSamples: 20 });
    injectFailures(b, 19); // 1 below floor
    expect(b.getState()).toBe("closed");
    expect(b.check(T0)).toEqual({ allowed: true });
  });

  test("minSamples=1: even 1 failure can trip", () => {
    const b = makeBreaker({ minSamples: 1, failureThreshold: 0.5 });
    b.recordFailure(T0);
    expect(b.getState()).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Rolling window eviction
// ---------------------------------------------------------------------------

describe("CircuitBreaker — rolling window", () => {
  test("after openDurationMs elapses, check() transitions to half-open", () => {
    // All failures at T0 → openSince = T0 → open expires at T0 + 60_000.
    const b = makeBreaker({ windowMs: 60_000, minSamples: 20, openDurationMs: 60_000 });
    injectFailures(b, 20, T0);
    expect(b.getState()).toBe("open");

    // T0 + 60_001 > T0 + 60_000 → open duration elapsed → half-open
    const r = b.check(T0 + 60_001);
    expect(r.allowed).toBe(true);
    expect(b.getState()).toBe("half-open");
  });

  test("failures outside the rolling window don't contribute to ratio", () => {
    const b = makeBreaker({ windowMs: 60_000, minSamples: 20, openDurationMs: 60_000 });

    // Inject 20 failures at T0 → openSince = T0
    injectFailures(b, 20, T0);
    expect(b.getState()).toBe("open");

    // Move to half-open: check at T0 + 60_001
    const probe = T0 + 60_001;
    b.check(probe);
    expect(b.getState()).toBe("half-open");

    // Successful probe → closed, window cleared
    b.recordSuccess(probe);
    expect(b.getState()).toBe("closed");

    // Now inject fresh successes — no failures in current window
    injectSuccesses(b, 25, probe + 1_000);
    expect(b.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Open → Half-open → Closed
// ---------------------------------------------------------------------------

// All failures injected at T0 → openSince = T0 → open expires at T0 + 60_000.

describe("CircuitBreaker — half-open probe success → closed", () => {
  test("after openDurationMs breaker transitions to half-open", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0);
    expect(b.getState()).toBe("open");

    // Just before open duration expires — still open (59_999 < 60_000)
    const result1 = b.check(T0 + 59_999);
    expect(result1.allowed).toBe(false);
    expect(b.getState()).toBe("open");

    // After open duration — transitions to half-open (60_001 > 60_000)
    const result2 = b.check(T0 + 60_001);
    expect(result2.allowed).toBe(true);
    expect(b.getState()).toBe("half-open");
  });

  test("successful probe closes the breaker", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0); // openSince = T0

    b.check(T0 + 60_001); // → half-open
    expect(b.getState()).toBe("half-open");

    b.recordSuccess(T0 + 60_002);
    expect(b.getState()).toBe("closed");
  });

  test("closed breaker allows subsequent calls normally", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0);
    b.check(T0 + 60_001);
    b.recordSuccess(T0 + 60_002);

    expect(b.check(T0 + 60_003)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Open → Half-open → Open (probe failure)
// ---------------------------------------------------------------------------

// All failures at T0 → openSince = T0 → open expires at T0 + 60_000.

describe("CircuitBreaker — half-open probe failure → open", () => {
  test("probe failure re-opens the breaker", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0); // openSince = T0

    b.check(T0 + 60_001); // → half-open
    expect(b.getState()).toBe("half-open");

    b.recordFailure(T0 + 60_002);
    expect(b.getState()).toBe("open");
  });

  test("after probe failure, check() blocks subsequent calls", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0);
    b.check(T0 + 60_001);
    b.recordFailure(T0 + 60_002); // openSince reset to T0 + 60_002

    const result = b.check(T0 + 60_003);
    expect(result.allowed).toBe(false);
  });

  test("second half-open window allows another probe", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0);
    b.check(T0 + 60_001);
    b.recordFailure(T0 + 60_002); // openSince = T0 + 60_002

    // Second window expires at T0 + 60_002 + 60_000 = T0 + 120_002
    const result = b.check(T0 + 120_003);
    expect(result.allowed).toBe(true);
    expect(b.getState()).toBe("half-open");
  });

  test("while probe in-flight, other calls are blocked", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0);

    b.check(T0 + 60_001); // probe allowed → probeInFlight = true

    // Second check while probe in-flight should be blocked
    const result = b.check(T0 + 60_002);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retryAfterSeconds accuracy
// ---------------------------------------------------------------------------

// Failures at T0 → openSince = T0.

describe("CircuitBreaker — retryAfterSeconds", () => {
  test("retryAfterSeconds reflects remaining open time", () => {
    const b = makeBreaker({ openDurationMs: 60_000, minSamples: 20 });
    injectFailures(b, 20, T0); // openSince = T0

    // Check 10s after open: elapsed = 10_000ms, remaining = 50_000ms → 50s
    const result = b.check(T0 + 10_000);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// CircuitOpenError
// ---------------------------------------------------------------------------

describe("CircuitOpenError", () => {
  test("has the right name and properties", () => {
    const err = new CircuitOpenError("anthropic", 30);
    expect(err.name).toBe("CircuitOpenError");
    expect(err.dep).toBe("anthropic");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });

  test("message includes dep and retryAfterSeconds", () => {
    const err = new CircuitOpenError("anthropic", 45);
    expect(err.message).toContain("anthropic");
    expect(err.message).toContain("45");
  });
});

// ---------------------------------------------------------------------------
// withBreaker integration — stub client
// ---------------------------------------------------------------------------

describe("withBreaker — integration with stub client", () => {
  beforeEach(() => {
    _resetBreakers();
  });

  test("successful calls pass through and stay closed", async () => {
    let calls = 0;
    const stub = async () => {
      calls++;
      return "ok";
    };

    for (let i = 0; i < 5; i++) {
      const result = await withBreaker("stub", stub);
      expect(result).toBe("ok");
    }
    expect(calls).toBe(5);

    const b = getBreaker("stub");
    expect(b.getState()).toBe("closed");
  });

  test("20 failures trip the breaker and the 21st call short-circuits", async () => {
    // Use a fresh breaker with default options (minSamples=20)
    const stub = async () => {
      throw Object.assign(new Error("upstream error"), { status: 500 });
    };

    // Push 20 failures through withBreaker. Each call throws, withBreaker
    // records failure and rethrows.
    for (let i = 0; i < 20; i++) {
      await expect(withBreaker("anthropic", stub)).rejects.toThrow();
    }

    const b = getBreaker("anthropic");
    expect(b.getState()).toBe("open");

    // 21st call must short-circuit with CircuitOpenError
    await expect(withBreaker("anthropic", stub)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  test("CircuitOpenError from inner call is NOT double-counted as a failure", async () => {
    _resetBreakers();
    const inner = new CircuitOpenError("anthropic", 30);
    let recordedFailures = 0;

    // Simulate: stub throws a CircuitOpenError (shouldn't happen in practice, but verify guard)
    const b = getBreaker("dep-x");
    const origRecord = b.recordFailure.bind(b);
    b.recordFailure = (...args) => {
      recordedFailures++;
      return origRecord(...args);
    };

    await expect(
      withBreaker("dep-x", async () => {
        throw inner;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    // CircuitOpenError should not trigger recordFailure
    expect(recordedFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metric observable
// ---------------------------------------------------------------------------

describe("CircuitBreaker — metric emitted on transition", () => {
  beforeEach(() => {
    _resetBreakers();
  });

  test("reviewme_breaker_state metric reflects current state", () => {
    const b = makeBreaker({ minSamples: 20, openDurationMs: 60_000 });

    // Initially no metric entry (no transition yet).
    // Trigger a trip to emit the metric.
    injectFailures(b, 20, T0);
    expect(b.getState()).toBe("open");

    const rendered = registry.render();
    expect(rendered).toContain("reviewme_breaker_state");
    // State 1 = open
    expect(rendered).toMatch(/reviewme_breaker_state\{[^}]*dep="test-dep"[^}]*\}\s+1/);
  });

  test("metric updates to 2 (half-open) on transition", () => {
    // Failures at T0 → openSince = T0 → open expires at T0 + 60_000
    const b = makeBreaker({ minSamples: 20, openDurationMs: 60_000 });
    injectFailures(b, 20, T0);
    b.check(T0 + 60_001); // → half-open
    expect(b.getState()).toBe("half-open");

    const rendered = registry.render();
    expect(rendered).toMatch(/reviewme_breaker_state\{[^}]*dep="test-dep"[^}]*\}\s+2/);
  });

  test("metric updates to 0 (closed) after successful probe", () => {
    // Failures at T0 → openSince = T0 → open expires at T0 + 60_000
    const b = makeBreaker({ minSamples: 20, openDurationMs: 60_000 });
    injectFailures(b, 20, T0);
    b.check(T0 + 60_001); // → half-open
    b.recordSuccess(T0 + 60_002); // → closed
    expect(b.getState()).toBe("closed");

    const rendered = registry.render();
    expect(rendered).toMatch(/reviewme_breaker_state\{[^}]*dep="test-dep"[^}]*\}\s+0/);
  });
});
