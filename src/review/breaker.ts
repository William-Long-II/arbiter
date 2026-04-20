/**
 * Three-state circuit breaker for external dependencies.
 *
 * State machine:
 *   CLOSED  — normal operation; failures are sampled in a rolling window.
 *   OPEN    — calls are rejected immediately; no upstream traffic.
 *   HALF_OPEN — one probe request is allowed through; success → CLOSED,
 *               failure → OPEN again.
 *
 * Trip condition: failure ratio > 50% over the last `windowMs` (default 60s)
 * with at least `minSamples` (default 20) in that window.
 *
 * The breaker is global per named dependency — NOT per repository. This is
 * intentional: a single breaker keeps total upstream pressure bounded and is
 * easy to reason about. (Caveat: one misbehaving repo can affect others — see
 * comments in the PR self-review.)
 */

import { log } from "../server/logger";
import { setBreakerState } from "../server/metrics";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BreakerState = "closed" | "open" | "half-open";

export type CheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterSeconds: number };

export interface BreakerOptions {
  /** Rolling window duration in milliseconds. Default: 60_000 (60s). */
  windowMs?: number;
  /** Minimum samples in the window before the breaker can trip. Default: 20. */
  minSamples?: number;
  /** Failure ratio (0..1) above which the breaker trips. Default: 0.5. */
  failureThreshold?: number;
  /** Duration in milliseconds the breaker stays OPEN before trying half-open. Default: 60_000 (60s). */
  openDurationMs?: number;
  /** Named dependency, used for logging and metrics labels. */
  dep?: string;
}

// ---------------------------------------------------------------------------
// CircuitOpenError
// ---------------------------------------------------------------------------

/**
 * Thrown by the breaker guard when a call is rejected because the breaker is
 * open. Callers should NOT retry this error — retrying is the anti-pattern the
 * breaker is designed to prevent.
 */
export class CircuitOpenError extends Error {
  readonly dep: string;
  readonly retryAfterSeconds: number;

  constructor(dep: string, retryAfterSeconds: number) {
    super(
      `Circuit breaker open for dependency "${dep}"; retry in ${retryAfterSeconds}s`,
    );
    this.name = "CircuitOpenError";
    this.dep = dep;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Rolling window sample store
// ---------------------------------------------------------------------------

interface Sample {
  ts: number; // epoch ms
  success: boolean;
}

/**
 * Fixed-capacity ring buffer for time-windowed samples.
 *
 * We keep at most `maxSize` entries (hard cap to bound memory). The `evict`
 * method drops entries older than a given cutoff — callers should call it
 * before any read operation so the window stays accurate.
 */
class SampleWindow {
  private samples: Sample[] = [];
  // Hard cap: even in pathological traffic, memory stays bounded.
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  add(success: boolean, now = Date.now()): void {
    if (this.samples.length >= this.maxSize) {
      // Oldest entry is at index 0 (push-to-end ordering).
      this.samples.shift();
    }
    this.samples.push({ ts: now, success });
  }

  /** Remove entries older than `cutoffMs`. Call before reads. */
  evict(cutoffMs: number): void {
    // samples is chronologically ordered — binary-search would be O(log n) but
    // the typical window size is small, so a simple linear scan from the front
    // is fine and easier to reason about.
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.ts < cutoffMs) {
      i++;
    }
    if (i > 0) this.samples.splice(0, i);
  }

  count(): number {
    return this.samples.length;
  }

  failureCount(): number {
    return this.samples.filter((s) => !s.success).length;
  }

  clear(): void {
    this.samples = [];
  }
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private readonly window: SampleWindow;
  private openSince: number | null = null;
  private probeInFlight = false;

  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  readonly dep: string;

  constructor(options: BreakerOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.minSamples = options.minSamples ?? 20;
    this.failureThreshold = options.failureThreshold ?? 0.5;
    this.openDurationMs = options.openDurationMs ?? 60_000;
    this.dep = options.dep ?? "unknown";
    this.window = new SampleWindow();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Check whether the next call should be allowed.
   *
   * - CLOSED → always allowed.
   * - OPEN → allowed only if the open period has elapsed (transitions to HALF_OPEN).
   * - HALF_OPEN → allowed only if no probe is currently in flight.
   */
  check(now = Date.now()): CheckResult {
    if (this.state === "closed") {
      return { allowed: true };
    }

    if (this.state === "open") {
      const elapsed = now - (this.openSince ?? now);
      if (elapsed >= this.openDurationMs) {
        this.transition("half-open", now);
        // This call is the probe — mark it in-flight before returning.
        this.probeInFlight = true;
        return { allowed: true };
      }
      const retryAfterSeconds = Math.ceil(
        (this.openDurationMs - elapsed) / 1000,
      );
      return {
        allowed: false,
        reason: `circuit open for ${this.dep}`,
        retryAfterSeconds,
      };
    }

    // HALF_OPEN: allow the first probe, gate subsequent calls while probe is in-flight.
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `circuit half-open for ${this.dep}; probe in-flight`,
      retryAfterSeconds: Math.ceil(this.openDurationMs / 1000),
    };
  }

  /**
   * Record a successful upstream call. In HALF_OPEN this closes the breaker.
   */
  recordSuccess(now = Date.now()): void {
    this.window.evict(now - this.windowMs);
    this.window.add(true, now);

    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.window.clear();
      this.transition("closed", now);
    }
  }

  /**
   * Record a failed upstream call.
   *
   * In HALF_OPEN the probe failed → re-open.
   * In CLOSED, check the rolling window and trip if threshold is met.
   */
  recordFailure(now = Date.now()): void {
    this.window.evict(now - this.windowMs);
    this.window.add(false, now);

    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.window.clear();
      this.openSince = now;
      this.transition("open", now);
      return;
    }

    if (this.state === "closed") {
      this.maybeTrip(now);
    }
  }

  /** Current state — primarily for observability and testing. */
  getState(): BreakerState {
    return this.state;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private maybeTrip(now: number): void {
    const total = this.window.count();
    if (total < this.minSamples) return;

    const failures = this.window.failureCount();
    const ratio = failures / total;
    if (ratio > this.failureThreshold) {
      this.openSince = now;
      this.window.clear();
      this.transition("open", now);
    }
  }

  private transition(to: BreakerState, now: number): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;

    // Emit exactly one structured log line per transition.
    log.info("breaker.transition", {
      evt: "breaker.transition",
      dep: this.dep,
      from,
      to,
      ts: now,
    });

    // Emit metric: 0=closed, 1=open, 2=half-open.
    const stateValue: Record<BreakerState, number> = {
      closed: 0,
      open: 1,
      "half-open": 2,
    };
    setBreakerState(this.dep, stateValue[to]);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — one breaker per named dependency
// ---------------------------------------------------------------------------

const breakers = new Map<string, CircuitBreaker>();

/**
 * Returns the singleton `CircuitBreaker` for the given dependency name.
 * Creates one on first call. Options are only respected on creation — pass
 * them only the first time (or rely on defaults).
 */
export function getBreaker(
  dep: string,
  options?: BreakerOptions,
): CircuitBreaker {
  let b = breakers.get(dep);
  if (!b) {
    b = new CircuitBreaker({ ...options, dep });
    breakers.set(dep, b);
  }
  return b;
}

/**
 * Reset all breakers — only intended for use in tests.
 */
export function _resetBreakers(): void {
  breakers.clear();
}

// ---------------------------------------------------------------------------
// Guard helper — wraps an async call with breaker check/record
// ---------------------------------------------------------------------------

/**
 * Run `fn` through the named circuit breaker.
 *
 * - If the breaker is open, throws `CircuitOpenError` immediately.
 * - Otherwise calls `fn`, records success/failure, and returns the result.
 *
 * Place this BEFORE `withRetry` so a tripped breaker short-circuits retry
 * loops entirely.
 */
export async function withBreaker<T>(
  dep: string,
  fn: () => Promise<T>,
): Promise<T> {
  const breaker = getBreaker(dep);
  const check = breaker.check();

  if (!check.allowed) {
    throw new CircuitOpenError(dep, check.retryAfterSeconds);
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err) {
    // Only count errors that indicate upstream failure.
    // CircuitOpenError from a nested call (shouldn't happen, but guard anyway)
    // is not a new upstream failure.
    if (!(err instanceof CircuitOpenError)) {
      breaker.recordFailure();
    }
    throw err;
  }
}
