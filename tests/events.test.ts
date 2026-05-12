import { describe, expect, test } from 'bun:test';
import {
  publish,
  subscribe,
  subscriberCount,
  type ReviewEvent,
} from '../src/events.ts';

function ev(over: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    userId: 1,
    reviewId: 100,
    status: 'done',
    verdict: 'approve',
    postedEvent: 'APPROVE',
    startedAt: '2026-05-12T12:00:00.000Z',
    finishedAt: '2026-05-12T12:00:30.000Z',
    ...over,
  };
}

describe('events bus', () => {
  test('subscribe + publish fan-out to all subscribers for a user', () => {
    const received: number[] = [];
    const u1 = subscribe(1, () => received.push(1));
    const u2 = subscribe(1, () => received.push(2));
    publish(ev({ userId: 1 }));
    expect(received).toEqual([1, 2]);
    u1();
    u2();
  });

  test('events do not leak across users', () => {
    const a: ReviewEvent[] = [];
    const b: ReviewEvent[] = [];
    const ua = subscribe(1, (e) => { a.push(e); });
    const ub = subscribe(2, (e) => { b.push(e); });
    publish(ev({ userId: 1, reviewId: 10 }));
    publish(ev({ userId: 2, reviewId: 20 }));
    expect(a.map((e) => e.reviewId)).toEqual([10]);
    expect(b.map((e) => e.reviewId)).toEqual([20]);
    ua();
    ub();
  });

  test('unsubscribe stops receiving events', () => {
    const received: ReviewEvent[] = [];
    const unsub = subscribe(3, (e) => { received.push(e); });
    publish(ev({ userId: 3, reviewId: 1 }));
    unsub();
    publish(ev({ userId: 3, reviewId: 2 }));
    expect(received.map((e) => e.reviewId)).toEqual([1]);
    expect(subscriberCount(3)).toBe(0);
  });

  test('subscriber count tracks adds and removes', () => {
    expect(subscriberCount(99)).toBe(0);
    const u1 = subscribe(99, () => {});
    const u2 = subscribe(99, () => {});
    expect(subscriberCount(99)).toBe(2);
    u1();
    expect(subscriberCount(99)).toBe(1);
    u2();
    expect(subscriberCount(99)).toBe(0);
  });

  test('a subscriber that unsubscribes during dispatch does not skip the next one', () => {
    // Snapshot iteration: even if one callback removes itself from the
    // subscriber set mid-dispatch, the other callbacks for that user still
    // receive the event.
    const received: number[] = [];
    let unsub2: () => void;
    const unsub1 = subscribe(7, () => {
      received.push(1);
      unsub2!();
    });
    unsub2 = subscribe(7, () => {
      received.push(2);
    });
    publish(ev({ userId: 7 }));
    expect(received).toContain(1);
    expect(received).toContain(2);
    unsub1();
  });

  test('publish to a user with no subscribers is a no-op', () => {
    expect(() => publish(ev({ userId: 9999 }))).not.toThrow();
  });

  test('publish handles a throwing subscriber without breaking siblings', () => {
    const received: number[] = [];
    const u1 = subscribe(5, () => { throw new Error('boom'); });
    const u2 = subscribe(5, () => { received.push(2); });
    publish(ev({ userId: 5 }));
    expect(received).toEqual([2]);
    u1();
    u2();
  });
});
