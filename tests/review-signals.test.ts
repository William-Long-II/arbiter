import { describe, expect, test } from 'bun:test';
import {
  buildSignalsNote,
  changedFilePaths,
  escalateScrutiny,
  sensitivePathHits,
  testGapNote,
} from '../src/review/signals.ts';

describe('changedFilePaths', () => {
  test('reads git headers for add/modify/delete/rename', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
    ].join('\n');
    expect(changedFilePaths(diff)).toEqual(['src/a.ts', 'new/name.ts']);
  });

  test('falls back to +++ b/ and ignores /dev/null', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '--- a/gone.ts', '+++ /dev/null'].join(
      '\n',
    );
    expect(changedFilePaths(diff)).toEqual(['x.ts']);
  });

  test('parses the reconstructed large-PR manifest rows', () => {
    const diff = [
      '# Files changed but not shown above (name only):',
      '  src/big.ts  (+10/-2, modified)',
      '  config/auth.yml  (+1/-0, added)',
    ].join('\n');
    expect(changedFilePaths(diff)).toEqual(['src/big.ts', 'config/auth.yml']);
  });

  test('dedupes, preserving first-seen order', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\ndiff --git a/a.ts b/a.ts';
    expect(changedFilePaths(diff)).toEqual(['a.ts']);
  });
});

describe('sensitivePathHits / escalateScrutiny', () => {
  test('flags auth, migrations, CI, Docker, terraform, k8s', () => {
    const paths = [
      'src/auth.ts',
      'db/migrations/004_x.sql',
      '.github/workflows/ci.yml',
      'Dockerfile',
      'infra/main.tf',
      'k8s/deploy.yaml',
      'README.md',
      'src/util.ts',
    ];
    const hits = sensitivePathHits(paths);
    expect(hits).toContain('src/auth.ts');
    expect(hits).toContain('db/migrations/004_x.sql');
    expect(hits).toContain('.github/workflows/ci.yml');
    expect(hits).toContain('Dockerfile');
    expect(hits).toContain('infra/main.tf');
    expect(hits).toContain('k8s/deploy.yaml');
    expect(hits).not.toContain('README.md');
    expect(hits).not.toContain('src/util.ts');
  });

  test('escalates below-strict tiers when sensitive paths present', () => {
    const r = escalateScrutiny('standard', ['src/oauth-callback.ts']);
    expect(r).not.toBeNull();
    expect(r!.scrutiny).toBe('strict');
    expect(r!.hits).toEqual(['src/oauth-callback.ts']);
  });

  test('no escalation when already strict', () => {
    expect(escalateScrutiny('strict', ['Dockerfile'])).toBeNull();
  });

  test('no escalation when nothing sensitive', () => {
    expect(escalateScrutiny('light', ['src/util.ts', 'README.md'])).toBeNull();
  });
});

describe('testGapNote', () => {
  test('note when code changed but no tests', () => {
    expect(testGapNote(['src/a.ts', 'src/b.go'])).toMatch(/no test files/i);
  });

  test('null when a test file is included', () => {
    expect(testGapNote(['src/a.ts', 'tests/a.test.ts'])).toBeNull();
    expect(testGapNote(['src/a.py', 'test_a.py'])).toBeNull();
  });

  test('null when only docs/config changed (no code)', () => {
    expect(testGapNote(['README.md', 'config/app.yml'])).toBeNull();
  });

  test('test-only PRs do not count as code-without-tests', () => {
    expect(testGapNote(['src/__tests__/a.spec.ts'])).toBeNull();
  });
});

describe('buildSignalsNote', () => {
  test('combines escalation + test gap', () => {
    const note = buildSignalsNote(
      { scrutiny: 'strict', hits: ['src/auth.ts'] },
      'gap text here',
    );
    expect(note).toContain('strict');
    expect(note).toContain('src/auth.ts');
    expect(note).toContain('gap text here');
  });

  test('null when neither signal fired', () => {
    expect(buildSignalsNote(null, null)).toBeNull();
  });
});
