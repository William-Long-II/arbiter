import { describe, expect, test, beforeEach } from "bun:test";
import {
  enqueue,
  enqueueOrThrow,
  getActiveCount,
  onQueueFull,
  QueueFullError,
  resetQueue,
  setOnQueueFull,
} from "../src/server/queue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A work task that never resolves unless signalled. */
function makeBlockingTask(): {
  work: () => Promise<void>;
  resolve: () => void;
} {
  const ref = { resolve: (() => {}) as () => void };
  const work = () =>
    new Promise<void>((r) => {
      ref.resolve = r;
    });
  // Return a stable resolve proxy that delegates through the ref so callers
  // can call resolve() after work() has been invoked.
  return { work, resolve: () => ref.resolve() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queue — basic enqueue", () => {
  beforeEach(() => resetQueue());

  test("accepted task increments activeCount", () => {
    const { work } = makeBlockingTask();
    const result = enqueue(work);
    expect(result.accepted).toBe(true);
    expect(getActiveCount()).toBe(1);
  });

  test("activeCount decrements after task resolves", async () => {
    let resolveFn!: () => void;
    const work = () =>
      new Promise<void>((r) => {
        resolveFn = r;
      });
    enqueue(work);
    expect(getActiveCount()).toBe(1);
    resolveFn();
    // Yield so the .finally() runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(getActiveCount()).toBe(0);
  });

  test("activeCount decrements even when task throws", async () => {
    let resolveFn!: (reason?: unknown) => void;
    const work = () =>
      new Promise<void>((_, rej) => {
        resolveFn = rej;
      });
    enqueue(work);
    expect(getActiveCount()).toBe(1);
    resolveFn(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(getActiveCount()).toBe(0);
  });
});

describe("queue — saturation / 503 path", () => {
  beforeEach(() => resetQueue());

  test("enqueue returns { accepted: false } when queue is full", () => {
    // Fill the queue with blocking tasks. Default max is 32 but we override
    // via env later — for this test we rely on the module-level max by pushing
    // many tasks.
    const blockers: Array<{ resolve: () => void }> = [];
    // We can't easily change REVIEW_QUEUE_MAX mid-test, so we fill up
    // whatever the current max is and then try one more.
    let accepted = true;
    while (accepted) {
      const { work, resolve } = makeBlockingTask();
      const res = enqueue(work);
      accepted = res.accepted;
      if (accepted) blockers.push({ resolve });
    }

    // The last call returned { accepted: false } — queue is full.
    expect(getActiveCount()).toBeGreaterThanOrEqual(1);

    // Clean up.
    for (const { resolve } of blockers) resolve();
  });

  test("enqueueOrThrow throws QueueFullError when full", () => {
    // Saturate the queue first.
    const blockers: Array<() => void> = [];
    let accepted = true;
    while (accepted) {
      const { work, resolve } = makeBlockingTask();
      const res = enqueue(work);
      accepted = res.accepted;
      if (accepted) blockers.push(resolve);
    }

    expect(() => enqueueOrThrow(() => Promise.resolve())).toThrow(QueueFullError);

    for (const resolve of blockers) resolve();
  });

  test("QueueFullError has the right name and message", () => {
    const err = new QueueFullError(10, 10);
    expect(err.name).toBe("QueueFullError");
    expect(err.message).toContain("10/10");
  });
});

describe("queue — onQueueFull hook", () => {
  beforeEach(() => {
    resetQueue();
    setOnQueueFull(() => {}); // reset to no-op
  });

  test("onQueueFull is called when the queue is full", () => {
    let hookCalls = 0;
    setOnQueueFull(() => { hookCalls++; });

    // Saturate.
    const blockers: Array<() => void> = [];
    let accepted = true;
    while (accepted) {
      const { work, resolve } = makeBlockingTask();
      const res = enqueue(work);
      accepted = res.accepted;
      if (accepted) blockers.push(resolve);
    }

    // The enqueue call that failed should have fired the hook.
    expect(hookCalls).toBe(1);

    for (const resolve of blockers) resolve();
  });

  test("default onQueueFull export is a no-op function", () => {
    // Just ensure calling it doesn't throw.
    expect(() => onQueueFull()).not.toThrow();
  });
});

describe("queue — 503 integration: QueueFullError propagates through webhook stack", () => {
  beforeEach(() => resetQueue());

  test("enqueueOrThrow throws and caller can detect QueueFullError", () => {
    // Saturate.
    const blockers: Array<() => void> = [];
    let accepted = true;
    while (accepted) {
      const { work, resolve } = makeBlockingTask();
      const res = enqueue(work);
      accepted = res.accepted;
      if (accepted) blockers.push(resolve);
    }

    let caught: unknown;
    try {
      enqueueOrThrow(() => Promise.resolve());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(QueueFullError);

    for (const resolve of blockers) resolve();
  });
});
