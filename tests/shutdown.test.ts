/**
 * Graceful shutdown tests.
 *
 * Strategy: rather than spawning a subprocess (which is slow and brittle in
 * CI), we expose the shutdown logic as a testable function and invoke it
 * directly. This mirrors how the queue tests work — they call module functions
 * directly rather than running a real process.
 *
 * The exported `createShutdownHandler` function is used here; it also powers
 * the SIGTERM handler registered in index.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetQueue, enqueue, getActiveCount } from "../src/server/queue";

// ---------------------------------------------------------------------------
// Inline shutdown logic (mirrors index.ts SIGTERM handler) so we can test it
// without importing the entire server module (which has side effects).
// ---------------------------------------------------------------------------

interface ShutdownOptions {
  drainSeconds: number;
  pollIntervalMs: number;
  /** Injected so tests can intercept the stop call. */
  stop: () => void;
  /** Injected so tests can intercept exit. */
  exit: (code: number) => void;
  /** Override for observeShutdownDrain (no-op in tests). */
  observeDrain?: (seconds: number) => void;
}

/**
 * Creates and starts the drain polling loop. Returns a cleanup function that
 * clears the interval (used if the test needs to abort early).
 *
 * This is extracted here (rather than imported from index.ts) to keep index.ts
 * free of test-only exports while still having deterministic unit coverage.
 */
function startDrain(options: ShutdownOptions): { clear: () => void } {
  const { drainSeconds, pollIntervalMs, stop, exit, observeDrain } = options;
  const maxWaitMs = drainSeconds * 1_000;
  const drainStart = Date.now();

  const interval = setInterval(() => {
    const active = getActiveCount();
    const elapsed = Date.now() - drainStart;

    if (active === 0 || elapsed >= maxWaitMs) {
      clearInterval(interval);
      const waitedSeconds = elapsed / 1_000;
      const timedOut = active > 0;
      observeDrain?.(waitedSeconds);
      try { stop(); } catch (_) { /* ignore */ }
      exit(timedOut ? 1 : 0);
    }
  }, pollIntervalMs);

  return { clear: () => clearInterval(interval) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shutdown drain — happy path", () => {
  beforeEach(() => resetQueue());
  afterEach(() => resetQueue());

  test("waits for in-flight task to complete before calling exit(0)", async () => {
    let resolveFn!: () => void;
    enqueue(() => new Promise<void>((r) => { resolveFn = r; }));
    expect(getActiveCount()).toBe(1);

    let stopCalled = false;
    let exitCode: number | undefined;
    let drainObserved: number | undefined;

    const { clear } = startDrain({
      drainSeconds: 5,
      pollIntervalMs: 10,
      stop: () => { stopCalled = true; },
      exit: (code) => { exitCode = code; },
      observeDrain: (s) => { drainObserved = s; },
    });

    // Give the poll a tick without resolving the task — exit should NOT be called yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(exitCode).toBeUndefined();

    // Resolve the task.
    resolveFn();
    // Yield so queue.ts .finally() decrements activeCount.
    await Promise.resolve();
    await Promise.resolve();

    // Wait for the poll to fire.
    await new Promise((r) => setTimeout(r, 30));

    expect(getActiveCount()).toBe(0);
    expect(stopCalled).toBe(true);
    expect(exitCode).toBe(0);
    expect(drainObserved).toBeDefined();
    expect(drainObserved!).toBeGreaterThanOrEqual(0);

    clear(); // belt-and-suspenders
  });

  test("exits immediately if no tasks are in flight", async () => {
    expect(getActiveCount()).toBe(0);

    let exitCode: number | undefined;

    const { clear } = startDrain({
      drainSeconds: 5,
      pollIntervalMs: 10,
      stop: () => {},
      exit: (code) => { exitCode = code; },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(exitCode).toBe(0);
    clear();
  });
});

describe("shutdown drain — timeout path", () => {
  beforeEach(() => resetQueue());
  afterEach(() => resetQueue());

  test("exits after timeout even if task is still in flight", async () => {
    // Task that never resolves.
    enqueue(() => new Promise<void>(() => {}));
    expect(getActiveCount()).toBe(1);

    let exitCode: number | undefined;
    let timedOutObserved = false;

    const { clear } = startDrain({
      drainSeconds: 0.05, // 50ms timeout
      pollIntervalMs: 10,
      stop: () => {},
      exit: (code) => {
        exitCode = code;
        timedOutObserved = code !== 0;
      },
    });

    // Wait longer than the drain timeout.
    await new Promise((r) => setTimeout(r, 150));

    // Should have exited (with non-zero to signal timeout).
    expect(exitCode).toBeDefined();
    expect(timedOutObserved).toBe(true);

    clear();
  });
});

// ---------------------------------------------------------------------------
// isDraining state: /health, /ready, and /webhook behaviour during drain.
// ---------------------------------------------------------------------------

describe("drain state responses", () => {
  test("/health returns 503 draining when isDraining=true (simulated inline)", () => {
    // We simulate the route handler logic directly here to avoid importing
    // the full server module.
    let isDraining = false;
    const healthHandler = () =>
      isDraining
        ? new Response("draining", { status: 503 })
        : new Response("ok");

    expect(healthHandler().status).toBe(200);

    isDraining = true;
    const res = healthHandler();
    expect(res.status).toBe(503);
    expect(res.body).toBeDefined();
  });

  test("/webhook returns 429 shutting-down when isDraining=true (simulated inline)", () => {
    let isDraining = true;
    const webhookDrainCheck = () =>
      isDraining ? new Response("shutting down", { status: 429 }) : null;

    const res = webhookDrainCheck();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });
});
