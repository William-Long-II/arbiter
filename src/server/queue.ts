/**
 * Bounded in-memory work queue for webhook-triggered reviews.
 *
 * Keeps at most REVIEW_QUEUE_MAX concurrent/pending review tasks (default 32).
 * When the queue is full the caller receives a 503 and a metric hook is fired
 * so that a metrics agent (issue #2) can observe saturation events without
 * this module carrying any counter state of its own.
 */

import { log } from "./logger";

const DEFAULT_QUEUE_MAX = 32;

const queueMax = (() => {
  const raw = process.env.REVIEW_QUEUE_MAX;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_QUEUE_MAX;
})();

/** Current number of in-flight or queued tasks. */
let activeCount = 0;

/**
 * Thrown by enqueueOrThrow when the queue is full so that the HTTP layer can
 * return 503 without the webhooks module needing to know about HTTP.
 */
export class QueueFullError extends Error {
  constructor(public readonly activeCount: number, public readonly queueMax: number) {
    super(`review queue full (${activeCount}/${queueMax})`);
    this.name = "QueueFullError";
  }
}

/**
 * Metric hook for queue-full events.  Issue #2 will replace this with a real
 * counter; until then it no-ops.  Exposed so the metrics agent can monkey-
 * patch it during initialisation without touching this file.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
export let onQueueFull: () => void = () => {};

/** Allow the metrics agent (issue #2) to register a real handler. */
export function setOnQueueFull(fn: () => void): void {
  onQueueFull = fn;
}

/** Visible for tests. */
export function getActiveCount(): number {
  return activeCount;
}

/** Visible for tests — reset between test cases. */
export function resetQueue(): void {
  activeCount = 0;
}

/**
 * Attempt to enqueue a review task.
 *
 * Returns `{ accepted: true }` when the task was admitted and the async
 * `work` promise has been started (fire-and-forget from the caller's
 * perspective — errors are caught here and logged).
 *
 * Returns `{ accepted: false }` when the queue is full; the caller should
 * respond with 503.
 */
export function enqueue(
  work: () => Promise<void>,
  context: Record<string, unknown> = {},
): { accepted: boolean } {
  if (activeCount >= queueMax) {
    log.warn("QUEUE_FULL: dropping review task", {
      activeCount,
      queueMax,
      ...context,
    });
    onQueueFull();
    return { accepted: false };
  }

  activeCount++;
  work()
    .catch((err: unknown) => {
      log.error("queued review task failed", {
        error: err instanceof Error ? err.message : String(err),
        ...context,
      });
    })
    .finally(() => {
      activeCount--;
    });

  return { accepted: true };
}

/**
 * Like `enqueue`, but throws `QueueFullError` when the queue is full so the
 * HTTP layer can propagate a 503 without the webhook handler caring about HTTP.
 */
export function enqueueOrThrow(
  work: () => Promise<void>,
  context: Record<string, unknown> = {},
): void {
  const result = enqueue(work, context);
  if (!result.accepted) {
    throw new QueueFullError(activeCount, queueMax);
  }
}
