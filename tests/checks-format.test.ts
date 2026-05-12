import { describe, expect, test } from 'bun:test';
import { formatChecksSummary, type ChecksSummary } from '../src/github/checks.ts';

function summary(over: Partial<ChecksSummary> = {}): ChecksSummary {
  return {
    anyFailing: false,
    allPassing: false,
    hasPending: false,
    hasAny: true,
    signals: [],
    ...over,
  };
}

describe('formatChecksSummary', () => {
  test('returns null when there are no signals at all', () => {
    expect(formatChecksSummary(summary({ hasAny: false }))).toBeNull();
  });

  test('renders failing checks first and includes the count', () => {
    const out = formatChecksSummary(
      summary({
        anyFailing: true,
        signals: [
          { name: 'lint', state: 'failure' },
          { name: 'build', state: 'success' },
        ],
      }),
    );
    expect(out).toContain('## CI status');
    expect(out).toContain('Failing (1): lint');
    expect(out).toContain('Passing (1): build');
    // Failing should appear before Passing in the rendered text.
    expect(out!.indexOf('Failing')).toBeLessThan(out!.indexOf('Passing'));
  });

  test('groups pending separately from passing', () => {
    const out = formatChecksSummary(
      summary({
        signals: [
          { name: 'e2e', state: 'pending' },
          { name: 'unit', state: 'success' },
        ],
      }),
    );
    expect(out).toContain('Pending (1): e2e');
    expect(out).toContain('Passing (1): unit');
  });

  test('skipped/neutral checks land in their own line', () => {
    const out = formatChecksSummary(
      summary({
        signals: [
          { name: 'release-on-tag', state: 'neutral' },
          { name: 'unit', state: 'success' },
        ],
      }),
    );
    expect(out).toContain('Skipped/neutral (1): release-on-tag');
  });

  test('omits empty buckets entirely', () => {
    const out = formatChecksSummary(
      summary({
        allPassing: true,
        signals: [{ name: 'unit', state: 'success' }],
      }),
    );
    expect(out).toContain('Passing (1): unit');
    expect(out).not.toContain('Failing');
    expect(out).not.toContain('Pending');
    expect(out).not.toContain('Skipped');
  });
});
