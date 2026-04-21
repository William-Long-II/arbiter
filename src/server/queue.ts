/**
 * Bounded in-memory work queue for webhook-triggered reviews.
 *
 * Keeps at most REVIEW_QUEUE_MAX concurrent/pending review tasks (default 32).
 * When the queue is full the caller receives a 503 and a metric hook is fired
 * so that a metrics agent (issue #2) can observe saturation events without
 * this module carrying any counter state of its own.
 *
 * Shadow serializable state (issue #92):
 *   Callers may pass a `pendingRecord` to `enqueueOrThrow`.  When the task is
 *   admitted, the record is inserted into the shadow map (keyed by
 *   `pendingRecord.taskId`).  When the task body begins executing, the record
 *   is evicted automatically so the persistence layer does not snapshot it
 *   again once work is underway.
 *
 *   `getPendingRecords()` exposes the snapshot to the persistence layer for
 *   writing to disk.
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

// ---------------------------------------------------------------------------
// Shadow serializable state — keyed by stable task ID.
// Entries live here from enqueue admission until the task begins executing.
// ---------------------------------------------------------------------------

/** The serializable intent for a single queued review task (issue #92). */
export type QueueRecord = {
  taskId: string;
  queuedAt: string; // ISO-8601
  ref: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
  };
  source: string;
  deliveryId: string;
  entry: Record<string, unknown>;
};

/** Shadow map: taskId → QueueRecord for tasks that have not started yet. */
const pendingRecords = new Map<string, QueueRecord>();

/** Register a serializable record for a newly-admitted task. */
export function registerPending(record: QueueRecord): void {
  pendingRecords.set(record.taskId, record);
}

/** Evict the record once the task begins executing (or is abandoned). */
export function dropPending(taskId: string): void {
  pendingRecords.delete(taskId);
}

/** Returns a snapshot of all pending (not yet started) records. */
export function getPendingRecords(): QueueRecord[] {
  return Array.from(pendingRecords.values());
}

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
  pendingRecords.clear();
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

  // If the caller registered a pending record (via registerPending before
  // calling enqueue), wrap work so the record is evicted the instant the
  // async task body starts executing — before any awaits inside it.
  const taskId = typeof context["taskId"] === "string" ? context["taskId"] : null;
  const wrappedWork = taskId
    ? async () => {
        dropPending(taskId);
        return work();
      }
    : work;

  wrappedWork()
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
 *
 * When `pendingRecord` is supplied and the task is admitted, the record is
 * registered in the shadow pending map (used by the queue-persistence layer
 * to snapshot not-yet-started tasks to disk across restarts).  The record is
 * automatically evicted once the task body begins executing.
 */
export function enqueueOrThrow(
  work: () => Promise<void>,
  context: Record<string, unknown> = {},
  pendingRecord?: QueueRecord,
): void {
  // Register the record first so it is present in the shadow map if enqueue
  // admits the task synchronously.  If enqueue rejects (queue full), the
  // record was never inserted so there's nothing to clean up.
  if (pendingRecord) {
    registerPending(pendingRecord);
  }

  let accepted: boolean;
  try {
    const result = enqueue(work, {
      ...context,
      ...(pendingRecord ? { taskId: pendingRecord.taskId } : {}),
    });
    accepted = result.accepted;
  } catch (err) {
    // Should not happen, but clean up the shadow record on unexpected errors.
    if (pendingRecord) {
      dropPending(pendingRecord.taskId);
    }
    throw err;
  }

  if (!accepted) {
    // Queue was full — evict the speculatively-inserted record.
    if (pendingRecord) {
      dropPending(pendingRecord.taskId);
    }
    throw new QueueFullError(activeCount, queueMax);
  }
}
