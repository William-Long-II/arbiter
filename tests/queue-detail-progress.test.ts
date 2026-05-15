import { describe, expect, test } from 'bun:test';
import { detailProgress } from '../src/web/views/queue-detail.tsx';
import type { PendingReview } from '../src/db/reviews.ts';

// detailProgress feeds the queue *detail* page's initial "phase · elapsed"
// (the bug: the detail page showed no running progress while the list
// did). The 1s client ticker re-derives elapsed from data attributes, so
// only the non-running/empty branches and the phase composition matter
// here — elapsed magnitude is fmtElapsed's job (tested separately).
function review(over: Partial<PendingReview>): PendingReview {
  return {
    id: 1,
    status: 'running',
    phase: 'reviewing',
    startedAt: new Date(Date.now() - 75_000),
    reviewContext: 'isolated',
    ...over,
  } as PendingReview;
}

describe('detailProgress', () => {
  test('running with phase → "phase · elapsed"', () => {
    expect(detailProgress(review({}))).toMatch(/^reviewing · \d/);
  });

  test('running without phase → elapsed only', () => {
    expect(detailProgress(review({ phase: null }))).toMatch(/^\d/);
    expect(detailProgress(review({ phase: null }))).not.toContain('·');
  });

  test('empty when not running (queued/done/failed/skipped)', () => {
    for (const status of ['queued', 'done', 'failed', 'skipped'] as const) {
      expect(detailProgress(review({ status }))).toBe('');
    }
  });

  test('empty when running but startedAt is missing', () => {
    expect(detailProgress(review({ startedAt: null }))).toBe('');
  });
});
