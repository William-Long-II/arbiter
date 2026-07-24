import { describe, expect, test } from 'bun:test';
import {
  auditSeverityScore,
  rankAuditReviews,
  summarizeAudit,
} from '../src/review/audit-rank.ts';
import type { FindingCounts, Verdict } from '../src/review/format.ts';

const counts = (over: Partial<FindingCounts> = {}): FindingCounts => ({
  blocking: 0,
  major: 0,
  minor: 0,
  nit: 0,
  ...over,
});

type Row = {
  id: number;
  status: string;
  verdict: Verdict | null;
  findings: FindingCounts | null;
};

const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  status: 'done',
  verdict: 'comment',
  findings: null,
  ...over,
});

describe('auditSeverityScore', () => {
  test('orders by worst severity: blocking > major > minor > nit', () => {
    const blocking = auditSeverityScore(row(1, { findings: counts({ blocking: 1 }) }));
    const major = auditSeverityScore(row(2, { findings: counts({ major: 1 }) }));
    const minor = auditSeverityScore(row(3, { findings: counts({ minor: 1 }) }));
    const nit = auditSeverityScore(row(4, { findings: counts({ nit: 1 }) }));
    expect(blocking).toBeGreaterThan(major);
    expect(major).toBeGreaterThan(minor);
    expect(minor).toBeGreaterThan(nit);
  });

  test('within the same tier, more blocking then more major ranks higher', () => {
    const two = auditSeverityScore(row(1, { findings: counts({ blocking: 2 }) }));
    const one = auditSeverityScore(row(2, { findings: counts({ blocking: 1, major: 9 }) }));
    // Two blocking outranks one blocking regardless of major count.
    expect(two).toBeGreaterThan(one);
  });

  test('falls back to verdict when there is no findings marker', () => {
    const rc = auditSeverityScore(row(1, { verdict: 'request-changes', findings: null }));
    const comment = auditSeverityScore(row(2, { verdict: 'comment', findings: null }));
    const approve = auditSeverityScore(row(3, { verdict: 'approve', findings: null }));
    expect(rc).toBeGreaterThan(comment);
    expect(comment).toBeGreaterThan(approve);
  });

  test('a clean approve outranks nothing (score 0 floor)', () => {
    expect(auditSeverityScore(row(1, { verdict: 'approve', findings: counts() }))).toBe(0);
  });
});

describe('rankAuditReviews', () => {
  test('sorts done rows most-severe-first', () => {
    const rows = [
      row(1, { verdict: 'approve', findings: counts() }),
      row(2, { findings: counts({ blocking: 1 }) }),
      row(3, { findings: counts({ minor: 3 }) }),
      row(4, { findings: counts({ major: 2 }) }),
    ];
    expect(rankAuditReviews(rows).map((r) => r.id)).toEqual([2, 4, 3, 1]);
  });

  test('excludes non-done rows (queued/running/failed/skipped)', () => {
    const rows = [
      row(1, { status: 'queued', findings: counts({ blocking: 5 }) }),
      row(2, { status: 'running' }),
      row(3, { status: 'failed' }),
      row(4, { status: 'skipped' }),
      row(5, { status: 'done', findings: counts({ major: 1 }) }),
    ];
    expect(rankAuditReviews(rows).map((r) => r.id)).toEqual([5]);
  });

  test('is stable for equal severity (input order preserved)', () => {
    const rows = [
      row(10, { findings: counts({ blocking: 1 }) }),
      row(11, { findings: counts({ blocking: 1 }) }),
      row(12, { findings: counts({ blocking: 1 }) }),
    ];
    expect(rankAuditReviews(rows).map((r) => r.id)).toEqual([10, 11, 12]);
  });
});

describe('summarizeAudit', () => {
  test('buckets by status and sums findings across done rows', () => {
    const rows = [
      row(1, { status: 'done', findings: counts({ blocking: 2, major: 1 }) }),
      row(2, { status: 'done', findings: counts({ major: 3, nit: 4 }) }),
      row(3, { status: 'done', verdict: 'approve', findings: counts() }),
      row(4, { status: 'queued' }),
      row(5, { status: 'running' }),
      row(6, { status: 'failed' }),
      row(7, { status: 'skipped' }),
    ];
    const s = summarizeAudit(rows);
    expect(s.total).toBe(7);
    expect(s.done).toBe(3);
    expect(s.inProgress).toBe(2); // queued + running
    expect(s.failed).toBe(2); // failed + skipped
    expect(s.findings).toEqual(counts({ blocking: 2, major: 4, nit: 4 }));
    expect(s.reviewsWithBlocking).toBe(1); // row 1
    expect(s.reviewsWithMajor).toBe(1); // row 2 (major top, no blocking)
  });

  test('empty run is all zeroes', () => {
    const s = summarizeAudit([]);
    expect(s).toEqual({
      total: 0,
      done: 0,
      inProgress: 0,
      failed: 0,
      reviewsWithBlocking: 0,
      reviewsWithMajor: 0,
      findings: counts(),
    });
  });
});
