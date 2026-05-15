import { describe, expect, test } from 'bun:test';
import {
  assembleLargeDiff,
  isTooLargeDiffError,
  type ChangedFile,
  LISTFILES_HARD_CAP,
} from '../src/github/pulls.ts';

function file(over: Partial<ChangedFile> & { filename: string }): ChangedFile {
  return {
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: `@@ -1 +1 @@\n-a\n+b`,
    ...over,
  };
}

// Shapes below are reconstructed from real Octokit RequestErrors observed
// in production (pending_reviews rows that were wrongly marked `failed`
// instead of `skipped`). The key fact the previous implementation got
// wrong: GitHub returns 406 for the `.diff` media type over its size
// limits, NOT 422 — so detection must NOT gate on status.

function octokitError(opts: {
  status: number;
  message: string;
  data?: unknown;
}): Error & { status: number; response: { data: unknown } } {
  const err = new Error(opts.message) as Error & {
    status: number;
    response: { data: unknown };
  };
  err.status = opts.status;
  err.response = { data: opts.data };
  return err;
}

describe('isTooLargeDiffError', () => {
  test('detects the >300-files rejection (HTTP 406, not 422)', () => {
    const err = octokitError({
      status: 406,
      message:
        "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.: {\"resource\":\"PullRequest\",\"field\":\"diff\",\"code\":\"too_large\"} - https://docs.github.com/rest/pulls/pulls#list-pull-requests-files",
      data: {
        message:
          "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
        errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }],
        documentation_url:
          'https://docs.github.com/rest/pulls/pulls#list-pull-requests-files',
      },
    });
    expect(isTooLargeDiffError(err)).toBe(true);
  });

  test('detects the >20000-lines rejection', () => {
    const err = octokitError({
      status: 406,
      message:
        'Sorry, the diff exceeded the maximum number of lines (20000): {"resource":"PullRequest","field":"diff","code":"too_large"} - https://docs.github.com/rest/pulls/pulls#get-a-pull-request',
      data: {
        message: 'Sorry, the diff exceeded the maximum number of lines (20000)',
        errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }],
        documentation_url:
          'https://docs.github.com/rest/pulls/pulls#get-a-pull-request',
      },
    });
    expect(isTooLargeDiffError(err)).toBe(true);
  });

  test('still detects when status is 422 (defensive — code is the signal)', () => {
    const err = octokitError({
      status: 422,
      message: 'Validation failed',
      data: { errors: [{ code: 'too_large' }] },
    });
    expect(isTooLargeDiffError(err)).toBe(true);
  });

  test('detects when errors is a single object, not an array', () => {
    const err = octokitError({
      status: 406,
      message: 'too large',
      data: { errors: { resource: 'PullRequest', code: 'too_large' } },
    });
    expect(isTooLargeDiffError(err)).toBe(true);
  });

  test('falls back to message text when body is a raw string', () => {
    const err = octokitError({
      status: 406,
      message:
        'Sorry, the diff exceeded the maximum number of files (300). - https://docs.github.com/rest',
      data: 'Sorry, the diff exceeded the maximum number of files (300).',
    });
    expect(isTooLargeDiffError(err)).toBe(true);
  });

  test('does NOT match an unrelated 422 validation error', () => {
    const err = octokitError({
      status: 422,
      message: 'Validation Failed: "lock prevents review"',
      data: {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequestReview', code: 'custom' }],
      },
    });
    expect(isTooLargeDiffError(err)).toBe(false);
  });

  test('does NOT match a generic network/other error', () => {
    expect(isTooLargeDiffError(new Error('socket hang up'))).toBe(false);
    expect(isTooLargeDiffError(null)).toBe(false);
    expect(isTooLargeDiffError(undefined)).toBe(false);
    expect(isTooLargeDiffError('boom')).toBe(false);
  });
});

describe('assembleLargeDiff', () => {
  test('includes real code patches smallest-change-first within budget', () => {
    const files = [
      file({ filename: 'big.ts', changes: 900 }),
      file({ filename: 'small.ts', changes: 4 }),
      file({ filename: 'mid.ts', changes: 40 }),
    ];
    // Budget fits ~2 of these blocks; the largest must spill to manifest.
    const { diff, notice } = assembleLargeDiff(files, 'acme/widget', 7, 160);
    expect(diff.indexOf('b/small.ts')).toBeGreaterThan(-1);
    expect(diff.indexOf('b/mid.ts')).toBeGreaterThan(-1);
    // Smallest appears before mid (ordering), big is manifest-only.
    expect(diff.indexOf('diff --git a/small.ts')).toBeLessThan(
      diff.indexOf('diff --git a/mid.ts'),
    );
    expect(diff).toContain('# Files changed but not shown above');
    expect(diff).toContain('big.ts  (+1/-1, modified)');
    expect(notice).toContain('Reviewed in FULL: 2 file(s)');
    expect(notice).toContain('PARTIAL review of a large PR');
  });

  test('demotes lockfiles/generated and binary (no-patch) files to manifest', () => {
    const files = [
      file({ filename: 'src/app.ts', changes: 10 }),
      file({ filename: 'bun.lock', changes: 5000 }),
      file({ filename: 'dist/bundle.js', changes: 9000 }),
      file({ filename: 'logo.png', patch: undefined, changes: 0, status: 'added' }),
    ];
    const { diff } = assembleLargeDiff(files, 'acme/widget', 7);
    expect(diff).toContain('diff --git a/src/app.ts');
    expect(diff).not.toContain('diff --git a/bun.lock');
    expect(diff).not.toContain('diff --git a/dist/bundle.js');
    expect(diff).toContain('bun.lock  (+1/-1, modified)');
    expect(diff).toContain('logo.png  (+1/-1, added)');
  });

  test('synthesizes /dev/null headers for added and removed files', () => {
    const added = assembleLargeDiff(
      [file({ filename: 'new.ts', status: 'added' })],
      'r/r',
      1,
    ).diff;
    expect(added).toContain('--- /dev/null');
    expect(added).toContain('+++ b/new.ts');

    const removed = assembleLargeDiff(
      [file({ filename: 'gone.ts', status: 'removed' })],
      'r/r',
      1,
    ).diff;
    expect(removed).toContain('--- a/gone.ts');
    expect(removed).toContain('+++ /dev/null');
  });

  test('throws DiffTooManyFilesError for the genuine residual', () => {
    // Empty list.
    expect(() => assembleLargeDiff([], 'r/r', 1)).toThrow(
      'over GitHub',
    );
    // At/over the listFiles hard cap.
    const capped = Array.from({ length: LISTFILES_HARD_CAP }, (_, i) =>
      file({ filename: `f${i}.ts` }),
    );
    expect(() => assembleLargeDiff(capped, 'r/r', 1)).toThrow('over GitHub');
    // Nothing reviewable fits (all noise) → no full content to review.
    expect(() =>
      assembleLargeDiff(
        [file({ filename: 'bun.lock' }), file({ filename: 'yarn.lock' })],
        'r/r',
        1,
      ),
    ).toThrow('over GitHub');
  });
});
