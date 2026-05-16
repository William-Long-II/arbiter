// A bounded work pump. `claim` atomically reserves the next unit of work
// (or returns null when the queue is drained); `run` processes one unit.
// The pool keeps up to `concurrency` `run`s in flight at once.
//
// Concurrency invariant: a slot is reserved *synchronously* (`active++`
// before any `await`) ahead of each `claim`, so no matter how many callers
// hit `pump()` at the same instant — the wake timer, a NOTIFY event, and a
// just-finished job all racing — the check-then-reserve is atomic under the
// single-threaded model and `active` can never exceed `concurrency`.
//
// Every finished job re-pumps from its `finally`, so a backlog drains as
// fast as slots free without waiting on the next wake tick. `pump()` while
// saturated is a cheap synchronous no-op (the `while` guard fails at once).
// Claiming is serialized within a pump pass (one `await claim` at a time)
// so a wake never fans out into a thundering herd of simultaneous claims.

export interface WorkerPoolOptions<T> {
  /** Max concurrent `run`s. Values < 1 (or non-finite) are clamped to 1. */
  concurrency: number;
  /** Reserve the next job atomically, or null when nothing is claimable. */
  claim: () => Promise<T | null>;
  /** Process one claimed job. Must settle (resolve or reject) eventually. */
  run: (job: T) => Promise<void>;
  /** A `claim()` threw — the pass backs off; a later wake re-pumps. */
  onClaimError?: (err: unknown) => void;
  /** A `run()` rejected. The slot is still freed and the pool re-pumps. */
  onRunError?: (err: unknown, job: T) => void;
}

export interface WorkerPool {
  /** Top up idle slots. Safe to call concurrently and while saturated. */
  pump: () => void;
  /** Jobs currently reserved or in flight (0..concurrency). */
  readonly active: number;
  /** The effective (clamped) concurrency cap. */
  readonly concurrency: number;
}

export function createWorkerPool<T>(opts: WorkerPoolOptions<T>): WorkerPool {
  const concurrency =
    Number.isFinite(opts.concurrency) && opts.concurrency >= 1
      ? Math.floor(opts.concurrency)
      : 1;
  let active = 0;

  async function runJob(job: T): Promise<void> {
    try {
      await opts.run(job);
    } catch (err) {
      opts.onRunError?.(err, job);
    } finally {
      // Slot freed — release it and immediately try to refill rather than
      // idling until the next wake tick.
      active--;
      void pump();
    }
  }

  async function pump(): Promise<void> {
    while (active < concurrency) {
      // Reserve the slot synchronously, before the first await, so a
      // concurrent pump can't also pass the guard on the same count.
      active++;
      let job: T | null;
      try {
        job = await opts.claim();
      } catch (err) {
        active--;
        opts.onClaimError?.(err);
        return;
      }
      if (job === null) {
        active--;
        return;
      }
      // Keep the reserved slot for the lifetime of this job; do NOT await
      // — concurrency comes from letting runJob run while the loop claims
      // the next slot (or exits because we're now saturated).
      void runJob(job);
    }
  }

  return {
    pump: () => {
      void pump();
    },
    get active() {
      return active;
    },
    concurrency,
  };
}
