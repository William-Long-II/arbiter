import { describe, expect, test } from 'bun:test';
import { hasBlocking, pickReviewEvent, statusForReview } from '../src/review/gate.ts';
import type { FindingCounts } from '../src/review/format.ts';

const counts = (over: Partial<FindingCounts> = {}): FindingCounts => ({
  blocking: 0,
  major: 0,
  minor: 0,
  nit: 0,
  ...over,
});

describe('hasBlocking', () => {
  test('true on request-changes OR a blocking finding', () => {
    expect(hasBlocking('request-changes', null)).toBe(true);
    expect(hasBlocking('comment', counts({ blocking: 1 }))).toBe(true);
  });
  test('false otherwise', () => {
    expect(hasBlocking('approve', counts())).toBe(false);
    expect(hasBlocking('comment', null)).toBe(false);
    expect(hasBlocking('approve', null)).toBe(false);
  });
});

describe('pickReviewEvent', () => {
  const base = {
    autoApprove: false,
    gateOnBlocking: false,
    verdict: 'comment' as const,
    findings: null,
    prAuthor: 'octocat',
    reviewerLogin: 'me',
  };

  test('default (no opt-ins) is always COMMENT', () => {
    expect(pickReviewEvent({ ...base, verdict: 'request-changes' })).toBe('COMMENT');
    expect(
      pickReviewEvent({ ...base, verdict: 'comment', findings: counts({ blocking: 3 }) }),
    ).toBe('COMMENT');
  });

  test('auto-approve: approve + not self ⇒ APPROVE; self ⇒ COMMENT', () => {
    expect(
      pickReviewEvent({ ...base, autoApprove: true, verdict: 'approve' }),
    ).toBe('APPROVE');
    expect(
      pickReviewEvent({
        ...base,
        autoApprove: true,
        verdict: 'approve',
        prAuthor: 'me',
      }),
    ).toBe('COMMENT');
  });

  test('gate: blockers + opted-in + not self ⇒ REQUEST_CHANGES', () => {
    expect(
      pickReviewEvent({ ...base, gateOnBlocking: true, verdict: 'request-changes' }),
    ).toBe('REQUEST_CHANGES');
    expect(
      pickReviewEvent({
        ...base,
        gateOnBlocking: true,
        verdict: 'comment',
        findings: counts({ blocking: 1 }),
      }),
    ).toBe('REQUEST_CHANGES');
  });

  test('gate: own PR falls back to COMMENT (GitHub blocks self-review)', () => {
    expect(
      pickReviewEvent({
        ...base,
        gateOnBlocking: true,
        verdict: 'request-changes',
        prAuthor: 'me',
      }),
    ).toBe('COMMENT');
  });

  test('gate opted-in but no blockers ⇒ COMMENT', () => {
    expect(
      pickReviewEvent({ ...base, gateOnBlocking: true, verdict: 'comment' }),
    ).toBe('COMMENT');
  });

  test('both opt-ins: approve ⇒ APPROVE; request-changes ⇒ REQUEST_CHANGES', () => {
    expect(
      pickReviewEvent({
        ...base,
        autoApprove: true,
        gateOnBlocking: true,
        verdict: 'approve',
      }),
    ).toBe('APPROVE');
    expect(
      pickReviewEvent({
        ...base,
        autoApprove: true,
        gateOnBlocking: true,
        verdict: 'request-changes',
      }),
    ).toBe('REQUEST_CHANGES');
  });
});

describe('statusForReview', () => {
  test('blockers ⇒ failure with a count when known', () => {
    expect(
      statusForReview({ verdict: 'comment', findings: counts({ blocking: 2 }) }),
    ).toEqual({
      state: 'failure',
      description: '2 blocking findings — changes requested',
    });
    expect(statusForReview({ verdict: 'request-changes', findings: null })).toEqual({
      state: 'failure',
      description: 'Blocking issues — changes requested',
    });
    expect(
      statusForReview({ verdict: 'comment', findings: counts({ blocking: 1 }) })
        .description,
    ).toBe('1 blocking finding — changes requested');
  });

  test('no blockers ⇒ success, with a non-blocking breakdown when available', () => {
    expect(statusForReview({ verdict: 'approve', findings: null })).toEqual({
      state: 'success',
      description: 'No blocking findings',
    });
    expect(
      statusForReview({
        verdict: 'comment',
        findings: counts({ major: 1, minor: 2, nit: 3 }),
      }),
    ).toEqual({
      state: 'success',
      description: 'No blocking findings (major 1, minor 2, nit 3)',
    });
  });

  test('description never exceeds GitHub’s 140-char limit', () => {
    const d = statusForReview({
      verdict: 'approve',
      findings: counts({ major: 999999, minor: 999999, nit: 999999 }),
    }).description;
    expect(d.length).toBeLessThanOrEqual(140);
  });
});
