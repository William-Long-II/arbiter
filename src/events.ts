// In-process pub/sub keyed by user_id. The db layer's pg LISTEN handler
// calls `publish(event)` whenever the worker (or the API enqueue endpoint)
// fires a Postgres NOTIFY on `reviews_changed`. SSE route handlers call
// `subscribe(userId, fn)` to receive the events for the current user.
//
// One in-memory map per process is fine for our single-app-container
// deployment. The pg channel is the cross-process glue — if we ever fan out
// to multiple app containers, every container LISTENs and every container
// holds its own subscribers; NOTIFY fans out to all of them automatically.

export type ReviewEvent = {
  userId: number;
  reviewId: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  verdict: 'approve' | 'comment' | 'request-changes' | null;
  postedEvent: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' | null;
  startedAt: string | null;
  finishedAt: string | null;
};

type Subscriber = (event: ReviewEvent) => void | Promise<void>;

const subscribersByUser = new Map<number, Set<Subscriber>>();
// Non-user-scoped listeners. Used by the worker to wake up on any new
// queued review without needing to know who owns it.
const globalSubscribers = new Set<Subscriber>();

export function subscribe(userId: number, fn: Subscriber): () => void {
  let set = subscribersByUser.get(userId);
  if (!set) {
    set = new Set();
    subscribersByUser.set(userId, set);
  }
  set.add(fn);
  return () => {
    const s = subscribersByUser.get(userId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribersByUser.delete(userId);
  };
}

/**
 * Subscribe to events for ANY user. Used by the worker to wake up
 * immediately when a new review is enqueued (status: 'queued'), rather
 * than waiting for the next 5s timer tick.
 */
export function subscribeAll(fn: Subscriber): () => void {
  globalSubscribers.add(fn);
  return () => {
    globalSubscribers.delete(fn);
  };
}

export function publish(event: ReviewEvent): void {
  const userSet = subscribersByUser.get(event.userId);
  // Iterate snapshots — a subscriber callback could unsubscribe itself
  // (closing the SSE stream on a write failure) and mutate the set mid-iter.
  if (userSet) deliver(event, [...userSet]);
  if (globalSubscribers.size > 0) deliver(event, [...globalSubscribers]);
}

function deliver(event: ReviewEvent, subscribers: Subscriber[]): void {
  for (const fn of subscribers) {
    try {
      const result = fn(event);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((err) => {
          console.error('[events] async subscriber error:', err);
        });
      }
    } catch (err) {
      console.error('[events] subscriber error:', err);
    }
  }
}

/** For diagnostics + tests. */
export function subscriberCount(userId: number): number {
  return subscribersByUser.get(userId)?.size ?? 0;
}

/** For diagnostics + tests. */
export function globalSubscriberCount(): number {
  return globalSubscribers.size;
}
