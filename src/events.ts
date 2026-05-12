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

export function publish(event: ReviewEvent): void {
  const set = subscribersByUser.get(event.userId);
  if (!set) return;
  // Iterate a snapshot — a subscriber callback could unsubscribe itself
  // (closing the SSE stream on a write failure) and mutate the set mid-iter.
  for (const fn of [...set]) {
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
